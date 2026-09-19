const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mime = require('mime-types');
const multer = require('multer');
const SFTPService = require('../services/sftpService');
const { requireApiKeyOrSession, requirePermission } = require('../middleware/apiKeyAuth');
const { runQuery, getRow } = require('../database/db');

// Multer for multipart blob upload endpoint
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 500 } // 500 MB
});

function getBaseUrl(req) {
  const host = req.get('host') || '127.0.0.1:3000';
  const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${protocol}://${host}`;
}

async function checkQuota(userId, extraBytes = 0) {
  const user = await getRow(`SELECT storage_quota_bytes FROM users WHERE id = ?;`, [userId]);
  if (!user) throw new Error('User not found.');
  const quotaBytes = Number(user.storage_quota_bytes || 0);
  const usedBytes = SFTPService.calculateUserStorageBytes(userId);
  if (usedBytes + extraBytes > quotaBytes) {
    const quotaGb = (quotaBytes / 1073741824).toFixed(2);
    const err = new Error(`Storage quota exceeded! Your limit is ${quotaGb} GB.`);
    err.statusCode = 413;
    throw err;
  }
  return { quotaBytes, usedBytes };
}

async function syncUsedStorage(userId) {
  try {
    const usedBytes = SFTPService.calculateUserStorageBytes(userId);
    await runQuery(`UPDATE users SET used_storage_bytes = ? WHERE id = ?;`, [usedBytes, userId]);
  } catch (_) {}
}

/**
 * Helper to get target path inside user's s3_storage directory
 */
function resolveBlobPath(userId, rawPathname) {
  let cleaned = String(rawPathname || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned) cleaned = 'blob_' + Date.now();
  // Safe relative path inside user's storage
  const relPath = path.join('/s3_storage', cleaned).replace(/\\/g, '/');
  const resolved = SFTPService.resolveUserPath(userId, relPath);
  return {
    pathname: cleaned,
    relativePath: relPath,
    absolutePath: resolved.absolutePath
  };
}

/**
 * 1. PUT /api/v1/blob/*pathname
 * Direct binary/raw stream upload (Vercel Blob compatible)
 */
router.put('/*pathname', requireApiKeyOrSession, requirePermission('write'), async (req, res) => {
  try {
    let rawPathname = Array.isArray(req.params.pathname) ? req.params.pathname.join('/') : (req.params.pathname || '');
    if (!rawPathname) {
      return res.status(400).json({ error: 'Blob pathname is required in URL.' });
    }

    // Check addRandomSuffix
    const addSuffix = req.query.addRandomSuffix === 'true' || req.headers['x-add-random-suffix'] === 'true';
    if (addSuffix) {
      const ext = path.extname(rawPathname);
      const base = ext ? rawPathname.slice(0, -ext.length) : rawPathname;
      const rand = crypto.randomBytes(4).toString('hex');
      rawPathname = `${base}-${rand}${ext}`;
    }

    const { pathname, absolutePath } = resolveBlobPath(req.user.id, rawPathname);
    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await checkQuota(req.user.id, 0);

    const writeStream = fs.createWriteStream(absolutePath);
    let bytesWritten = 0;

    const onFinish = async () => {
      try {
        const stat = fs.statSync(absolutePath);
        await checkQuota(req.user.id, 0);
        await syncUsedStorage(req.user.id);

        const contentType = req.headers['content-type'] || mime.lookup(pathname) || 'application/octet-stream';
        const baseUrl = getBaseUrl(req);
        const fileName = path.basename(pathname);

        return res.status(200).json({
          url: `${baseUrl}/api/v1/blob/download/${encodeURIComponent(pathname).replace(/%2F/g, '/')}`,
          downloadUrl: `${baseUrl}/api/v1/blob/download/${encodeURIComponent(pathname).replace(/%2F/g, '/')}?download=1`,
          pathname: pathname,
          contentType: contentType,
          contentDisposition: `inline; filename="${fileName}"`,
          size: stat.size,
          uploadedAt: new Date().toISOString()
        });
      } catch (err) {
        if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
        return res.status(err.statusCode || 500).json({ error: err.message });
      }
    };

    writeStream.on('finish', onFinish);
    writeStream.on('error', (err) => {
      return res.status(500).json({ error: 'Failed to write blob: ' + err.message });
    });

    if (req.body && (Buffer.isBuffer(req.body) || typeof req.body === 'string' || (typeof req.body === 'object' && Object.keys(req.body).length > 0))) {
      const buf = Buffer.isBuffer(req.body) ? req.body : (typeof req.body === 'string' ? Buffer.from(req.body) : Buffer.from(JSON.stringify(req.body)));
      writeStream.end(buf);
    } else {
      req.on('data', chunk => { bytesWritten += chunk.length; });
      req.pipe(writeStream);
    }
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * 2. POST /api/v1/blob/upload
 * Multipart form or buffer upload (Vercel Blob / standard web clients)
 */
router.post('/upload', requireApiKeyOrSession, requirePermission('write'), upload.single('file'), async (req, res) => {
  try {
    let filename = req.query.filename || (req.file && req.file.originalname) || `upload_${Date.now()}`;
    const addSuffix = req.query.addRandomSuffix === 'true';
    if (addSuffix) {
      const ext = path.extname(filename);
      const base = ext ? filename.slice(0, -ext.length) : filename;
      const rand = crypto.randomBytes(4).toString('hex');
      filename = `${base}-${rand}${ext}`;
    }

    const { pathname, absolutePath } = resolveBlobPath(req.user.id, filename);
    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    let fileSize = 0;
    if (req.file && req.file.buffer) {
      fileSize = req.file.buffer.length;
      await checkQuota(req.user.id, fileSize);
      fs.writeFileSync(absolutePath, req.file.buffer);
    } else {
      // Stream directly from req body
      await checkQuota(req.user.id, 0);
      const writeStream = fs.createWriteStream(absolutePath);
      await new Promise((resolve, reject) => {
        req.on('data', c => { fileSize += c.length; });
        req.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
      });
      await checkQuota(req.user.id, 0);
    }

    await syncUsedStorage(req.user.id);

    const contentType = req.headers['content-type'] || mime.lookup(pathname) || 'application/octet-stream';
    const baseUrl = getBaseUrl(req);
    const fileName = path.basename(pathname);

    return res.status(200).json({
      url: `${baseUrl}/api/v1/blob/download/${encodeURIComponent(pathname).replace(/%2F/g, '/')}`,
      downloadUrl: `${baseUrl}/api/v1/blob/download/${encodeURIComponent(pathname).replace(/%2F/g, '/')}?download=1`,
      pathname: pathname,
      contentType: contentType,
      contentDisposition: `inline; filename="${fileName}"`,
      size: fileSize,
      uploadedAt: new Date().toISOString()
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * 3. GET /api/v1/blob/list
 * List blobs in user's s3_storage (Vercel Blob list() compatible)
 */
router.get('/list', requireApiKeyOrSession, requirePermission('read'), async (req, res) => {
  try {
    const prefix = String(req.query.prefix || '').replace(/^\/+/, '');
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit || '100', 10)));
    const baseUrl = getBaseUrl(req);

    const s3Root = SFTPService.resolveUserPath(req.user.id, '/s3_storage').absolutePath;
    if (!fs.existsSync(s3Root)) {
      return res.json({ blobs: [], cursor: null, hasMore: false });
    }

    const blobs = [];
    function scan(currentDir, relativePrefix = '') {
      if (blobs.length >= limit) return;
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (blobs.length >= limit) break;
        const rel = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
        const full = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          scan(full, rel);
        } else if (entry.isFile()) {
          if (!prefix || rel.startsWith(prefix)) {
            const stat = fs.statSync(full);
            blobs.push({
              url: `${baseUrl}/api/v1/blob/download/${encodeURIComponent(rel).replace(/%2F/g, '/')}`,
              downloadUrl: `${baseUrl}/api/v1/blob/download/${encodeURIComponent(rel).replace(/%2F/g, '/')}?download=1`,
              pathname: rel,
              size: stat.size,
              uploadedAt: stat.mtime.toISOString(),
              contentType: mime.lookup(rel) || 'application/octet-stream'
            });
          }
        }
      }
    }

    scan(s3Root);

    return res.json({
      blobs,
      cursor: null,
      hasMore: false
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to list blobs: ' + err.message });
  }
});

/**
 * 4. GET /api/v1/blob/download/*pathname and GET /api/v1/blob/*pathname
 * Stream blob with HTTP Range support for media seeking & downloads
 */
router.get(['/download/*pathname', '/*pathname'], async (req, res) => {
  try {
    const rawPathname = Array.isArray(req.params.pathname) ? req.params.pathname.join('/') : (req.params.pathname || '');
    if (!rawPathname) return res.status(400).json({ error: 'Missing pathname.' });

    // Try finding blob across user storage or check auth
    let userId = null;
    const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
    let token = null;
    if (authHeader.startsWith('Bearer ')) token = authHeader.slice(7).trim();
    if (!token) token = req.headers['x-api-key'] || req.headers['x-blob-token'] || req.query.token || req.query.apiKey;

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded && decoded.userId) userId = decoded.userId;
      } catch (_) {}

      if (!userId) {
        const apiKey = await getRow(
          `SELECT user_id FROM api_keys WHERE (secret_key = ? OR key_id = ?) AND is_active = 1;`,
          [token, token]
        );
        if (apiKey) userId = apiKey.user_id;
      }
    }

    let targetFile = null;
    if (userId) {
      const resolved = resolveBlobPath(userId, rawPathname);
      if (fs.existsSync(resolved.absolutePath) && fs.statSync(resolved.absolutePath).isFile()) {
        targetFile = resolved.absolutePath;
      }
    }

    // Fallback: search across all users in SFTP storage root
    if (!targetFile) {
      const storageRoot = SFTPService.STORAGE_ROOT || process.env.STORAGE_ROOT || '/var/vps_storage';
      if (fs.existsSync(storageRoot)) {
        const userDirs = fs.readdirSync(storageRoot);
        for (const uDir of userDirs) {
          const check = path.join(storageRoot, uDir, 's3_storage', rawPathname);
          if (fs.existsSync(check) && fs.statSync(check).isFile()) {
            targetFile = check;
            break;
          }
        }
      }
    }

    if (!targetFile || !fs.existsSync(targetFile)) {
      return res.status(404).json({ error: 'Blob not found.' });
    }

    const stat = fs.statSync(targetFile);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is a directory, not a blob file.' });
    }

    const contentType = mime.lookup(targetFile) || 'application/octet-stream';
    const fileName = path.basename(targetFile);
    const isDownload = req.query.download === '1' || req.path.includes('/download/');
    const disposition = isDownload ? `attachment; filename="${fileName}"` : `inline; filename="${fileName}"`;

    // Handle HTTP Range header
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = end - start + 1;

      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
        'Content-Disposition': disposition,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'ETag': `"${stat.size}-${stat.mtimeMs}"`
      });

      fs.createReadStream(targetFile, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': contentType,
        'Content-Disposition': disposition,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'ETag': `"${stat.size}-${stat.mtimeMs}"`
      });

      fs.createReadStream(targetFile).pipe(res);
    }
  } catch (err) {
    return res.status(500).json({ error: 'Download error: ' + err.message });
  }
});

/**
 * 5. HEAD /api/v1/blob/*pathname
 * Metadata inspection
 */
router.head('/*pathname', async (req, res) => {
  try {
    const rawPathname = Array.isArray(req.params.pathname) ? req.params.pathname.join('/') : (req.params.pathname || '');
    const storageRoot = process.env.STORAGE_ROOT || '/tmp/vps_sftp_storage';
    let targetFile = null;

    if (fs.existsSync(storageRoot)) {
      const userDirs = fs.readdirSync(storageRoot);
      for (const uDir of userDirs) {
        const check = path.join(storageRoot, uDir, 's3_storage', rawPathname);
        if (fs.existsSync(check)) {
          targetFile = check;
          break;
        }
      }
    }

    if (!targetFile || !fs.existsSync(targetFile)) {
      return res.status(404).end();
    }

    const stat = fs.statSync(targetFile);
    res.set({
      'Content-Length': stat.size,
      'Content-Type': mime.lookup(targetFile) || 'application/octet-stream',
      'ETag': `"${stat.size}-${stat.mtimeMs}"`,
      'Last-Modified': stat.mtime.toUTCString(),
      'Accept-Ranges': 'bytes'
    });
    return res.status(200).end();
  } catch (_) {
    return res.status(500).end();
  }
});

/**
 * 6. DELETE /api/v1/blob/*pathname and POST /api/v1/blob/delete
 * Delete single or multiple blobs (Vercel Blob del() compatible)
 */
router.delete('/*pathname', requireApiKeyOrSession, requirePermission('delete'), async (req, res) => {
  try {
    const rawPathname = Array.isArray(req.params.pathname) ? req.params.pathname.join('/') : (req.params.pathname || '');
    const { pathname, absolutePath } = resolveBlobPath(req.user.id, rawPathname);

    if (!fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'Blob not found.' });
    }

    fs.unlinkSync(absolutePath);
    await syncUsedStorage(req.user.id);

    return res.json({ success: true, deleted: pathname });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete blob: ' + err.message });
  }
});

router.post('/delete', requireApiKeyOrSession, requirePermission('delete'), async (req, res) => {
  try {
    const { urls } = req.body;
    if (!Array.isArray(urls)) {
      return res.status(400).json({ error: 'Expected "urls" array.' });
    }

    let deletedCount = 0;
    for (const item of urls) {
      let pathname = item;
      try {
        if (item.startsWith('http')) {
          const u = new URL(item);
          pathname = u.pathname.replace('/api/v1/blob/download/', '').replace('/api/v1/blob/', '');
        }
        const { absolutePath } = resolveBlobPath(req.user.id, decodeURIComponent(pathname));
        if (fs.existsSync(absolutePath)) {
          fs.unlinkSync(absolutePath);
          deletedCount++;
        }
      } catch (_) {}
    }

    await syncUsedStorage(req.user.id);
    return res.json({ success: true, deletedCount });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete blobs: ' + err.message });
  }
});

module.exports = router;
