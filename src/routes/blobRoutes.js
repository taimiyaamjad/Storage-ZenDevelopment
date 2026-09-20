const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mime = require('mime-types');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const SFTPService = require('../services/sftpService');
const { requireApiKeyOrSession, requirePermission } = require('../middleware/apiKeyAuth');
const { runQuery, getRow } = require('../database/db');
const { checkBandwidthQuota, recordBandwidthUsage, recordApiRequest } = require('../services/usageService');

// Multer for multipart blob upload endpoint
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 500 } // 500 MB
});

// Global CORS & direct cross-origin embedding headers for all blob endpoints
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
  res.setHeader('Timing-Allow-Origin', '*');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
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
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch (_) {}
  cleaned = cleaned.replace(/\\/g, '/').replace(/^\/+/, '');
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
 * Helper to locate blob file across user directory or global storage for public embed links
 */
function findBlobFile(userId, rawPathname) {
  let cleaned = String(rawPathname || '').replace(/\\/g, '/').replace(/^(\/?(download|view|raw)\/)+/i, '').replace(/^\/+/, '');
  try {
    cleaned = decodeURIComponent(cleaned);
  } catch (_) {}
  const safeRelPath = path.normalize(cleaned).replace(/^(\.\.[\/\\])+/, '').replace(/\\/g, '/');
  const storageRoot = SFTPService.STORAGE_ROOT || process.env.STORAGE_ROOT || '/tmp/vps_sftp_storage';

  // 1. If userId is provided, check user's s3_storage and root
  if (userId) {
    const userS3 = path.join(storageRoot, `user_${userId}`, 's3_storage', safeRelPath);
    if (fs.existsSync(userS3) && fs.statSync(userS3).isFile()) return { targetFile: userS3, ownerId: userId };

    const userRoot = path.join(storageRoot, `user_${userId}`, safeRelPath);
    if (fs.existsSync(userRoot) && fs.statSync(userRoot).isFile()) return { targetFile: userRoot, ownerId: userId };
  }

  // 2. Fallback: Search across all users in storage root (enables public embedding of direct links anywhere)
  if (fs.existsSync(storageRoot)) {
    const userDirs = fs.readdirSync(storageRoot);
    for (const uDir of userDirs) {
      const uDirPath = path.join(storageRoot, uDir);
      try {
        if (!fs.statSync(uDirPath).isDirectory()) continue;
        const match = uDir.match(/^user_(\d+)$/);
        const ownerId = match ? parseInt(match[1], 10) : null;

        // Check in s3_storage
        const checkS3 = path.join(uDirPath, 's3_storage', safeRelPath);
        if (fs.existsSync(checkS3) && fs.statSync(checkS3).isFile()) {
          return { targetFile: checkS3, ownerId };
        }

        // Check in root user directory
        const checkBase = path.join(uDirPath, safeRelPath);
        if (fs.existsSync(checkBase) && fs.statSync(checkBase).isFile()) {
          return { targetFile: checkBase, ownerId };
        }
      } catch (_) {}
    }
  }

  return { targetFile: null, ownerId: null };
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
        const encodedPath = encodeURIComponent(pathname).replace(/%2F/g, '/');

        return res.status(200).json({
          url: `${baseUrl}/api/v1/blob/${encodedPath}`,
          downloadUrl: `${baseUrl}/api/v1/blob/${encodedPath}?download=1`,
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
    const encodedPath = encodeURIComponent(pathname).replace(/%2F/g, '/');

    return res.status(200).json({
      url: `${baseUrl}/api/v1/blob/${encodedPath}`,
      downloadUrl: `${baseUrl}/api/v1/blob/${encodedPath}?download=1`,
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
            const encodedRel = encodeURIComponent(rel).replace(/%2F/g, '/');
            blobs.push({
              url: `${baseUrl}/api/v1/blob/${encodedRel}`,
              downloadUrl: `${baseUrl}/api/v1/blob/${encodedRel}?download=1`,
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
 * 4. GET /api/v1/blob/*pathname and aliases (/download/*, /view/*, /raw/*)
 * Direct embeddable streaming with HTTP Range, CORS, inline display & ?download=1 attachment
 */
router.get(['/download/*pathname', '/view/*pathname', '/raw/*pathname', '/*pathname'], async (req, res) => {
  try {
    let rawPathname = Array.isArray(req.params.pathname) ? req.params.pathname.join('/') : (req.params.pathname || '');
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

    const { targetFile, ownerId } = findBlobFile(userId, rawPathname);

    if (!targetFile || !fs.existsSync(targetFile)) {
      return res.status(404).json({ error: 'Blob not found.' });
    }

    const stat = fs.statSync(targetFile);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Path is a directory, not a blob file.' });
    }

    // Check bandwidth quota for the blob owner
    if (ownerId) {
      try {
        await checkBandwidthQuota(ownerId, stat.size);
      } catch (bwErr) {
        if (bwErr.status === 429) {
          return res.status(429).json({ error: bwErr.message, code: bwErr.code });
        }
      }
    }

    const contentType = mime.lookup(targetFile) || 'application/octet-stream';
    const fileName = path.basename(targetFile);
    const isDownload = req.query.download === '1' || req.query.download === 'true';
    const disposition = isDownload ? `attachment; filename="${fileName}"` : `inline; filename="${fileName}"`;

    // Standard headers for direct cross-origin website embedding
    const standardHeaders = {
      'Content-Type': contentType,
      'Content-Disposition': disposition,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cross-Origin-Embedder-Policy': 'unsafe-none',
      'Timing-Allow-Origin': '*',
      'ETag': `"${stat.size}-${stat.mtimeMs}"`,
      'Last-Modified': stat.mtime.toUTCString()
    };

    // Handle HTTP Range header (for video/audio seeking and chunked streaming)
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = end - start + 1;

      res.writeHead(206, {
        ...standardHeaders,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': chunksize
      });

      const stream = fs.createReadStream(targetFile, { start, end });
      let transferred = 0;
      stream.on('data', chunk => {
        transferred += chunk.length;
      });
      stream.on('end', () => {
        if (ownerId && transferred > 0) {
          recordBandwidthUsage(ownerId, transferred).catch(() => {});
        }
      });
      stream.pipe(res);
    } else {
      res.writeHead(200, {
        ...standardHeaders,
        'Content-Length': stat.size
      });

      const stream = fs.createReadStream(targetFile);
      let transferred = 0;
      stream.on('data', chunk => {
        transferred += chunk.length;
      });
      stream.on('end', () => {
        if (ownerId && transferred > 0) {
          recordBandwidthUsage(ownerId, transferred).catch(() => {});
        }
      });
      stream.pipe(res);
    }
  } catch (err) {
    return res.status(500).json({ error: 'Download error: ' + err.message });
  }
});

/**
 * 5. HEAD /api/v1/blob/*pathname
 * Metadata inspection with CORS
 */
router.head(['/download/*pathname', '/view/*pathname', '/raw/*pathname', '/*pathname'], async (req, res) => {
  try {
    const rawPathname = Array.isArray(req.params.pathname) ? req.params.pathname.join('/') : (req.params.pathname || '');
    const targetFile = findBlobFile(null, rawPathname);

    if (!targetFile || !fs.existsSync(targetFile)) {
      return res.status(404).end();
    }

    const stat = fs.statSync(targetFile);
    const contentType = mime.lookup(targetFile) || 'application/octet-stream';
    const fileName = path.basename(targetFile);
    const isDownload = req.query.download === '1' || req.query.download === 'true';

    res.set({
      'Content-Length': stat.size,
      'Content-Type': contentType,
      'Content-Disposition': isDownload ? `attachment; filename="${fileName}"` : `inline; filename="${fileName}"`,
      'ETag': `"${stat.size}-${stat.mtimeMs}"`,
      'Last-Modified': stat.mtime.toUTCString(),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin'
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
          pathname = u.pathname.replace('/api/v1/blob/download/', '').replace('/api/v1/blob/view/', '').replace('/api/v1/blob/raw/', '').replace('/api/v1/blob/', '');
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
