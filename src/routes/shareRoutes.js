const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const { getRow, getAll, runQuery } = require('../database/db');
const { requireAuth, logAudit } = require('../middleware/auth');
const SFTPService = require('../services/sftpService');
const ArchiveService = require('../services/archiveService');
const { streamInlineFile } = require('../utils/previewStream');
const { streamTranscodedPreview } = require('../services/videoPreviewService');
const { startDownloadMonitor, watchResponse } = require('../services/downloadMonitorService');

/**
 * 1. List active share links for logged in user
 */
router.get('/my-links', requireAuth, async (req, res) => {
  try {
    const links = await getAll(
      `SELECT id, file_path, is_directory, created_at, expires_at, is_active, view_count
       FROM share_links WHERE user_id = ? ORDER BY created_at DESC;`,
      [req.user.id]
    );

    const appUrlSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'app_url';`);
    const appUrl = appUrlSetting ? appUrlSetting.value : 'http://storage.zendevelopment.in';

    const formatted = links.map(l => ({
      ...l,
      shareUrl: `${appUrl}/#public-share?token=${l.id}`,
      isExpired: l.expires_at ? new Date(l.expires_at) < new Date() : false
    }));

    return res.json(formatted);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve share links.' });
  }
});

/**
 * 2. Create public share link (Enforces Max Active Links Limit)
 */
router.post('/create', requireAuth, async (req, res) => {
  try {
    const { filePath, durationHours } = req.body;
    if (!filePath) return res.status(400).json({ error: 'File path is required.' });

    // Check active share link count against setting (Default max: 3)
    const maxLinksSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'max_share_links_per_user';`);
    const maxAllowed = maxLinksSetting ? parseInt(maxLinksSetting.value, 10) : 3;

    const activeCount = await getRow(
      `SELECT COUNT(*) as count FROM share_links WHERE user_id = ? AND is_active = 1 AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP);`,
      [req.user.id]
    );

    if (activeCount.count >= maxAllowed) {
      return res.status(400).json({
        error: `Share link limit reached! You can have a maximum of ${maxAllowed} active share links.`
      });
    }

    const { absolutePath } = SFTPService.resolveUserPath(req.user.id, filePath);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'File or folder does not exist.' });
    }

    const isDirectory = fs.statSync(absolutePath).isDirectory() ? 1 : 0;
    const token = crypto.randomBytes(16).toString('hex');

    let expiresAt = null;
    if (durationHours && durationHours > 0) {
      expiresAt = new Date(Date.now() + parseInt(durationHours, 10) * 3600000).toISOString();
    }

    await runQuery(
      `INSERT INTO share_links (id, user_id, file_path, is_directory, expires_at, is_active) VALUES (?, ?, ?, ?, ?, 1);`,
      [token, req.user.id, filePath, isDirectory, expiresAt]
    );

    const appUrlSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'app_url';`);
    const appUrl = appUrlSetting ? appUrlSetting.value : 'http://storage.zendevelopment.in';

    await logAudit(req.user.id, 'create_share_link', { filePath, token, durationHours }, req);

    return res.status(201).json({
      message: 'Share link created successfully!',
      token,
      shareUrl: `${appUrl}/#public-share?token=${token}`,
      expiresAt
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 3. Revoke / Delete share link
 */
router.post('/revoke', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Share token is required.' });

    await runQuery(`UPDATE share_links SET is_active = 0 WHERE id = ? AND user_id = ?;`, [token, req.user.id]);
    await logAudit(req.user.id, 'revoke_share_link', { token }, req);
    return res.json({ message: 'Share link revoked successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to revoke share link.' });
  }
});

/**
 * 4. PUBLIC SHARE LINK FILE DOWNLOAD / ACCESS
 */
router.get('/public/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const link = await getRow(`SELECT * FROM share_links WHERE id = ? AND is_active = 1;`, [token]);

    if (!link) {
      return res.status(404).json({ error: 'Share link not found or has been revoked.' });
    }

    if (link.expires_at && new Date(link.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This share link has expired.' });
    }

    // Count a shared-link visit/download request, but not every video byte-range request.
    // Fired without awaiting: a slow/contended write here must not delay the
    // file bytes themselves, especially for large downloads.
    if (req.query.preview !== '1') {
      runQuery(`UPDATE share_links SET view_count = view_count + 1 WHERE id = ?;`, [token]).catch(err => console.error('Share view count update error:', err.message));
    }

    const { absolutePath } = SFTPService.resolveUserPath(link.user_id, link.file_path);
    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'Shared content is no longer available on disk.' });
    }

    const stat = fs.statSync(absolutePath);
    const fileName = path.basename(link.file_path);

    if (req.query.info === '1') {
      return res.json({
        fileName,
        isDirectory: link.is_directory === 1,
        sizeBytes: stat.size,
        mimeType: stat.isDirectory() ? 'inode/directory' : (mime.lookup(absolutePath) || 'application/octet-stream'),
        createdAt: link.created_at,
        expiresAt: link.expires_at,
        viewCount: link.view_count + 1
      });
    }

    if (req.query.preview === '1' && !stat.isDirectory()) {
      const mimeType = mime.lookup(absolutePath) || '';
      if (/^video\//i.test(mimeType)) {
        // Start with the original stream for instant playback. If the browser
        // rejects its codec, the frontend retries with ?transcoded=1.
        if (req.query.transcoded === '1') {
          const safe = req.query.safe === '1' || req.query.safe === 'true';
          const result = await streamTranscodedPreview(absolutePath, res, { safe });
          if (result.cached && !res.headersSent) {
            return streamInlineFile(req, res, result.path, { cacheControl: 'public, max-age=60' });
          }
          return;
        }
        return streamInlineFile(req, res, absolutePath, { cacheControl: 'public, max-age=60' });
      }
      return streamInlineFile(req, res, absolutePath, { cacheControl: 'public, max-age=60' });
    }

    if (stat.isDirectory()) {
      const tempZipName = `public_share_${token}_${Date.now()}.zip`;
      const { archivePath } = await ArchiveService.compress(link.user_id, [link.file_path], tempZipName, 'zip');
      startDownloadMonitor(req, {
        userId: link.user_id,
        requestedUrl: req.originalUrl,
        endpoint: req.path,
        fileName: `${fileName}.zip`,
        filePath: link.file_path,
        fileId: token,
        fileSizeBytes: fs.statSync(archivePath).size
      }).then(id => watchResponse(res, id)).catch(err => console.error('Share download monitor start error:', err.message));
      return res.download(archivePath, `${fileName}.zip`, () => {
        try { if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath); } catch (_) {}
      });
    }

    const mimeType = mime.lookup(absolutePath) || 'application/octet-stream';
    startDownloadMonitor(req, {
      userId: link.user_id,
      requestedUrl: req.originalUrl,
      endpoint: req.path,
      fileName,
      filePath: link.file_path,
      fileId: token,
      fileSizeBytes: stat.size
    }).then(id => watchResponse(res, id)).catch(err => console.error('Share download monitor start error:', err.message));
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const stream = fs.createReadStream(absolutePath);
    stream.pipe(res);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
