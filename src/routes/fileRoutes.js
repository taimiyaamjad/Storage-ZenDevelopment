const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const mime = require('mime-types');
const SFTPService = require('../services/sftpService');
const ArchiveService = require('../services/archiveService');
const { requireAuth, logAudit } = require('../middleware/auth');
const { runQuery, getRow } = require('../database/db');
const DownloadService = require('../services/downloadService');
const { streamInlineFile } = require('../utils/previewStream');
const { streamTranscodedPreview } = require('../services/videoPreviewService');
const { startDownloadMonitor, watchResponse } = require('../services/downloadMonitorService');

// Browser downloads can be opened directly in a new tab, so support a token query
// parameter for this endpoint only. Frontend downloads use the Authorization header.
function requireDownloadAuth(req, res, next) {
  if (!req.headers.authorization && req.query && req.query.token) {
    req.headers.authorization = `Bearer ${req.query.token}`;
  }
  return requireAuth(req, res, next);
}

const requirePreviewAuth = requireDownloadAuth;


async function getQuotaState(userId) {
  const user = await getRow(`SELECT storage_quota_bytes FROM users WHERE id = ?;`, [userId]);
  if (!user) throw new Error('User account not found.');
  const usedBytes = SFTPService.calculateUserStorageBytes(userId);
  return { quotaBytes: Number(user.storage_quota_bytes || 0), usedBytes };
}

async function persistUsage(userId) {
  const usedBytes = SFTPService.calculateUserStorageBytes(userId);
  const user = await getRow(`SELECT storage_quota_bytes FROM users WHERE id = ?;`, [userId]);
  if (user) {
    if (usedBytes > Number(user.storage_quota_bytes || 0)) {
      await runQuery(`UPDATE users SET used_storage_bytes = ?, storage_overage_since = COALESCE(storage_overage_since, CURRENT_TIMESTAMP) WHERE id = ?;`, [usedBytes, userId]);
    } else {
      await runQuery(`UPDATE users SET used_storage_bytes = ?, storage_overage_since = NULL WHERE id = ?;`, [usedBytes, userId]);
    }
  }
  return usedBytes;
}

function assertWithinQuota(usedBytes, quotaBytes, extraBytes = 0) {
  if (usedBytes + extraBytes > quotaBytes) {
    const err = new Error(`Storage quota exceeded! Your limit is ${formatQuotaGb(quotaBytes)} GB.`);
    err.statusCode = 400;
    throw err;
  }
}

function formatQuotaGb(bytes) {
  return (Number(bytes || 0) / 1073741824).toFixed(2);
}

// Multer storage for streaming disk uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const tempDir = path.resolve(__dirname, '../../public/uploads/temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    cb(null, tempDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}_${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 } // 10 GB per single file stream limit
});

/**
 * 1. List files & folders in a directory
 */
router.get('/list', requireAuth, async (req, res) => {
  try {
    const dirPath = req.query.path || '/';
    const result = await SFTPService.listDirectory(req.user.id, dirPath);
    return res.json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * 2. Create directory
 */
router.post('/create-folder', requireAuth, async (req, res) => {
  try {
    const { path: dirPath } = req.body;
    if (!dirPath) return res.status(400).json({ error: 'Folder path is required.' });

    await SFTPService.createDirectory(req.user.id, dirPath);
    await logAudit(req.user.id, 'create_folder', { path: dirPath }, req);
    return res.json({ message: 'Folder created successfully.' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * 3. Delete files/folders (Supports single & bulk)
 */
router.post('/delete', requireAuth, async (req, res) => {
  try {
    const { paths } = req.body;
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'Paths array is required.' });
    }

    for (const p of paths) {
      await SFTPService.deletePath(req.user.id, p);
    }

    // Update real storage byte count
    await persistUsage(req.user.id);

    await logAudit(req.user.id, 'delete_files', { paths }, req);
    return res.json({ message: 'Selected items deleted successfully.' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * 4. Rename file or folder
 */
router.post('/rename', requireAuth, async (req, res) => {
  try {
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) {
      return res.status(400).json({ error: 'Old path and new path are required.' });
    }

    await SFTPService.renameOrMove(req.user.id, oldPath, newPath);
    await logAudit(req.user.id, 'rename_item', { oldPath, newPath }, req);
    return res.json({ message: 'Renamed successfully.' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * 5. Move items (Bulk move)
 */
router.post('/move', requireAuth, async (req, res) => {
  try {
    const { items, destinationDir } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0 || typeof destinationDir !== 'string') {
      return res.status(400).json({ error: 'Select at least one item and provide a destination directory.' });
    }

    const cleanDestination = destinationDir.trim() || '/';
    const { absolutePath: destinationAbs } = SFTPService.resolveUserPath(req.user.id, cleanDestination);
    if (!fs.existsSync(destinationAbs)) {
      return res.status(404).json({ error: 'Destination directory does not exist.' });
    }
    if (!fs.statSync(destinationAbs).isDirectory()) {
      return res.status(400).json({ error: 'Destination path is not a directory.' });
    }

    for (const itemPath of items) {
      const { absolutePath: sourceAbs } = SFTPService.resolveUserPath(req.user.id, itemPath);
      if (!fs.existsSync(sourceAbs)) {
        return res.status(404).json({ error: `Source path not found: ${itemPath}` });
      }
      if (sourceAbs === destinationAbs) {
        return res.status(400).json({ error: 'An item cannot be moved into its current directory.' });
      }

      const fileName = path.basename(itemPath);
      const targetPath = path.join(cleanDestination, fileName);
      const { absolutePath: targetAbs } = SFTPService.resolveUserPath(req.user.id, targetPath);
      if (fs.existsSync(targetAbs)) {
        return res.status(409).json({ error: `Destination already contains: ${fileName}` });
      }
      if (fs.statSync(sourceAbs).isDirectory() && destinationAbs.startsWith(sourceAbs + path.sep)) {
        return res.status(400).json({ error: 'A folder cannot be moved inside itself.' });
      }

      await SFTPService.renameOrMove(req.user.id, itemPath, targetPath);
    }

    await logAudit(req.user.id, 'move_items', { items, destinationDir: cleanDestination }, req);
    return res.json({ message: 'Items moved successfully.' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * 6. Copy items (Bulk copy)
 */
router.post('/copy', requireAuth, async (req, res) => {
  try {
    const { items, destinationDir } = req.body;
    if (!items || !Array.isArray(items) || !destinationDir) {
      return res.status(400).json({ error: 'Items array and destination directory are required.' });
    }

    for (const itemPath of items) {
      const fileName = path.basename(itemPath);
      const targetPath = path.join(destinationDir, fileName);
      await SFTPService.copyPath(req.user.id, itemPath, targetPath);
    }

    // Recalculate usage
    await persistUsage(req.user.id);

    await logAudit(req.user.id, 'copy_items', { items, destinationDir }, req);
    return res.json({ message: 'Items copied successfully.' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * 7. Streaming Upload with Storage Quota Enforcement
 */
router.post('/upload', requireAuth, upload.array('files'), async (req, res) => {
  try {
    const targetDir = req.body.targetDir || '/';
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files provided for upload.' });
    }

    // Check user quota before moving files
    const currentUsed = SFTPService.calculateUserStorageBytes(req.user.id);
    let incomingSize = 0;
    for (const file of req.files) {
      incomingSize += file.size;
    }

    if (currentUsed + incomingSize > req.user.storage_quota_bytes) {
      // Clean up uploaded temp files
      for (const file of req.files) {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      }
      return res.status(400).json({
        error: `Storage quota exceeded! Your limit is ${(req.user.storage_quota_bytes / 1073741824).toFixed(2)} GB.`
      });
    }

    // Move uploaded files to user SFTP directory
    for (const file of req.files) {
      const targetFilePath = path.join(targetDir, file.originalname);
      const { absolutePath: destAbs } = SFTPService.resolveUserPath(req.user.id, targetFilePath);

      fs.copyFileSync(file.path, destAbs);
      fs.unlinkSync(file.path);
    }

    // Recalculate and update storage
    await persistUsage(req.user.id);

    await logAudit(req.user.id, 'upload_files', { count: req.files.length, totalBytes: incomingSize }, req);
    return res.json({ message: 'Files uploaded successfully!', count: req.files.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 8. Download file or folder (Single or zip archive for multiple)
 */
router.get('/download', requireDownloadAuth, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'File path parameter is required.' });

    const { absolutePath } = SFTPService.resolveUserPath(req.user.id, filePath);

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'File not found.' });
    }

    const stat = fs.statSync(absolutePath);
    if (stat.isDirectory()) {
      // Download directory as temporary zip
      const tempZipName = `download_${Date.now()}.zip`;
      const { archivePath } = await ArchiveService.compress(req.user.id, [filePath], tempZipName, 'zip');
      startDownloadMonitor(req, {
        requestedUrl: req.originalUrl,
        endpoint: req.path,
        fileName: `${path.basename(filePath)}.zip`,
        filePath,
        fileSizeBytes: fs.statSync(archivePath).size
      }).then(id => watchResponse(res, id)).catch(err => console.error('Download monitor start error:', err.message));
      return res.download(archivePath, `${path.basename(filePath)}.zip`, () => {
        if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
      });
    }

    startDownloadMonitor(req, {
      requestedUrl: req.originalUrl,
      endpoint: req.path,
      fileName: path.basename(filePath),
      filePath,
      fileSizeBytes: stat.size
    }).then(id => watchResponse(res, id)).catch(err => console.error('Download monitor start error:', err.message));

    // Fire the audit log without waiting for it: a slow/contended DB write must
    // never delay the bytes going out to the browser's download manager. The
    // download itself streams first; logging happens in parallel.
    logAudit(req.user.id, 'download_file', { filePath }, req).catch(err => console.error('Audit log error:', err.message));

    const filename = path.basename(filePath);
    const mimeType = mime.lookup(absolutePath) || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Prevent nginx/other reverse proxies from buffering the whole file in
    // memory before forwarding it, which is a common cause of a download that
    // "takes forever to start" on large files.
    res.setHeader('X-Accel-Buffering', 'no');

    return res.sendFile(absolutePath, { acceptRanges: true, cacheControl: false, lastModified: false, dotfiles: 'deny' }, (err) => {
      if (!err || res.headersSent) return;
      if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found.' });
      if (err.code === 'ECONNABORTED') return;
      console.error('Download stream error:', err);
      try { res.status(err.statusCode || 500).json({ error: 'Unable to download file.' }); } catch (_) {}
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 9. Preview file (Images, text, PDF, video, audio)
 * Supports Range requests so browser video playback/seek works correctly.
 */
router.get('/preview', requirePreviewAuth, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'File path is required.' });

    const { absolutePath } = SFTPService.resolveUserPath(req.user.id, filePath);
    if (!fs.existsSync(absolutePath)) return res.status(404).json({ error: 'File not found.' });

    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return res.status(400).json({ error: 'Folders cannot be previewed.' });

    // Stream the original media immediately. Modern browsers can use HTTP Range
    // requests and begin playback without waiting for a server-side conversion.
    // Unsupported codecs are handled by /preview-transcoded as an automatic
    // frontend fallback, so compatible MP4/H.264 files stay instant.
    return streamInlineFile(req, res, absolutePath);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 9b. Live browser-compatible video fallback.
 * The original file is never modified. FFmpeg creates a fragmented MP4 stream
 * immediately and simultaneously caches the completed preview for later use.
 */
router.get('/preview-transcoded', requirePreviewAuth, async (req, res) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'File path is required.' });

    const { absolutePath } = SFTPService.resolveUserPath(req.user.id, filePath);
    if (!fs.existsSync(absolutePath)) return res.status(404).json({ error: 'File not found.' });
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile()) return res.status(400).json({ error: 'Folders cannot be previewed.' });

    const mimeType = mime.lookup(absolutePath) || '';
    if (!/^video\//i.test(mimeType)) {
      return res.status(400).json({ error: 'The selected file is not a video.' });
    }

    const safe = req.query.safe === '1' || req.query.safe === 'true';
    const result = await streamTranscodedPreview(absolutePath, res, { safe });
    if (result.cached && !res.headersSent) {
      return streamInlineFile(req, res, result.path);
    }
  } catch (err) {
    if (res.headersSent) {
      try { res.destroy(err); } catch (_) {}
      return;
    }
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 10. Start background download from a direct HTTP/HTTPS URL.
 * wget runs server-side and the resulting file is placed in the user's current directory.
 */
router.post('/download-from-url', requireAuth, async (req, res) => {
  try {
    const { url, filename, targetDir } = req.body || {};
    if (!url || !String(url).trim()) return res.status(400).json({ error: 'Download URL is required.' });

    const job = await DownloadService.startDownload({
      userId: req.user.id,
      url,
      filename,
      targetDir: typeof targetDir === 'string' && targetDir.trim() ? targetDir.trim() : '/',
      request: req
    });

    await logAudit(req.user.id, 'start_url_download', { filename: job.filename, targetPath: job.path }, req);
    return res.status(202).json({
      message: 'Download started in the background.',
      job
    });
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
});

/**
 * 11. Background download job status.
 */
router.get('/download-jobs', requireAuth, async (req, res) => {
  try {
    return res.json(await DownloadService.getUserJobs(req.user.id));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/** Remove a URL download from the user's recent-download history. */
router.delete('/download-jobs/:id', requireAuth, async (req, res) => {
  try {
    const job = await DownloadService.removeUserJob(req.user.id, req.params.id);
    return res.json({ message: 'Download removed from recent history.', job });
  } catch (err) {
    return res.status(404).json({ error: err.message });
  }
});

/** Clear all completed/failed entries from the user's URL download history. */
router.delete('/download-jobs', requireAuth, async (req, res) => {
  try {
    const result = await DownloadService.clearUserJobs(req.user.id);
    return res.json({ message: 'Download history cleared.', ...result });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 12. Archive Compression API
 */
router.post('/compress', requireAuth, async (req, res) => {
  try {
    const { items, archiveName, format } = req.body;
    if (!items || !Array.isArray(items) || !archiveName) {
      return res.status(400).json({ error: 'Items array and archive name are required.' });
    }

    await ArchiveService.compress(req.user.id, items, archiveName, format || 'zip');

    // Update storage bytes
    await persistUsage(req.user.id);

    await logAudit(req.user.id, 'compress_files', { items, archiveName, format }, req);
    return res.json({ message: 'Archive created successfully!' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

/**
 * 11. Archive Extraction API
 */
router.post('/extract', requireAuth, async (req, res) => {
  try {
    const { archivePath, targetDir } = req.body;
    if (!archivePath) return res.status(400).json({ error: 'Archive path is required.' });

    await ArchiveService.extract(req.user.id, archivePath, targetDir || '/');

    // Update storage bytes
    await persistUsage(req.user.id);

    await logAudit(req.user.id, 'extract_archive', { archivePath, targetDir }, req);
    return res.json({ message: 'Archive extracted successfully!' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

module.exports = router;
