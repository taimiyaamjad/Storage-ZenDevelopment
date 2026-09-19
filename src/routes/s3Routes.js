const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mime = require('mime-types');
const SFTPService = require('../services/sftpService');
const { requireApiKeyOrSession, requirePermission } = require('../middleware/apiKeyAuth');
const { runQuery, getRow } = require('../database/db');

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
}

async function syncUsedStorage(userId) {
  try {
    const usedBytes = SFTPService.calculateUserStorageBytes(userId);
    await runQuery(`UPDATE users SET used_storage_bytes = ? WHERE id = ?;`, [usedBytes, userId]);
  } catch (_) {}
}

function resolveS3Path(userId, bucket, key) {
  const safeBucket = (bucket || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeKey = String(key || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const relPath = path.join('/s3_storage', safeBucket, safeKey).replace(/\\/g, '/');
  const resolved = SFTPService.resolveUserPath(userId, relPath);
  return {
    bucket: safeBucket,
    key: safeKey,
    relativePath: relPath,
    absolutePath: resolved.absolutePath
  };
}

/**
 * 1. GET /api/s3 - List Buckets
 */
router.get('/', requireApiKeyOrSession, requirePermission('read'), async (req, res) => {
  try {
    const s3Root = SFTPService.resolveUserPath(req.user.id, '/s3_storage').absolutePath;
    if (!fs.existsSync(s3Root)) {
      fs.mkdirSync(s3Root, { recursive: true });
    }

    const entries = fs.readdirSync(s3Root, { withFileTypes: true });
    const buckets = entries
      .filter(e => e.isDirectory())
      .map(e => {
        const stat = fs.statSync(path.join(s3Root, e.name));
        return {
          name: e.name,
          creationDate: stat.birthtime ? stat.birthtime.toISOString() : stat.mtime.toISOString()
        };
      });

    // Ensure 'default' bucket is listed
    if (!buckets.some(b => b.name === 'default')) {
      buckets.unshift({ name: 'default', creationDate: new Date().toISOString() });
    }

    if (req.headers.accept && req.headers.accept.includes('xml')) {
      res.set('Content-Type', 'application/xml');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Owner>
    <ID>${req.user.id}</ID>
    <DisplayName>${req.user.username}</DisplayName>
  </Owner>
  <Buckets>
    ${buckets.map(b => `<Bucket><Name>${b.name}</Name><CreationDate>${b.creationDate}</CreationDate></Bucket>`).join('')}
  </Buckets>
</ListAllMyBucketsResult>`;
      return res.send(xml);
    }

    return res.json({
      owner: { id: req.user.id, displayName: req.user.username },
      buckets
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 2. PUT /api/s3/:bucket - Create Bucket
 */
router.put('/:bucket', requireApiKeyOrSession, requirePermission('write'), async (req, res) => {
  try {
    const bucket = req.params.bucket;
    const { absolutePath } = resolveS3Path(req.user.id, bucket, '');
    if (!fs.existsSync(absolutePath)) {
      fs.mkdirSync(absolutePath, { recursive: true });
    }
    res.set('Location', `/${bucket}`);
    return res.status(200).send();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 3. GET /api/s3/:bucket - ListObjectsV2 in bucket
 */
router.get('/:bucket', requireApiKeyOrSession, requirePermission('read'), async (req, res) => {
  try {
    const bucket = req.params.bucket;
    const prefix = String(req.query.prefix || '').replace(/^\/+/, '');
    const maxKeys = Math.min(1000, Math.max(1, parseInt(req.query['max-keys'] || '1000', 10)));
    const { absolutePath: bucketDir } = resolveS3Path(req.user.id, bucket, '');

    const objects = [];
    if (fs.existsSync(bucketDir)) {
      function scan(currentDir, relPrefix = '') {
        if (objects.length >= maxKeys) return;
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (objects.length >= maxKeys) break;
          const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
          const full = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            scan(full, rel);
          } else if (entry.isFile()) {
            if (!prefix || rel.startsWith(prefix)) {
              const stat = fs.statSync(full);
              const md5 = crypto.createHash('md5').update(`${stat.size}-${stat.mtimeMs}`).digest('hex');
              objects.push({
                key: rel,
                lastModified: stat.mtime.toISOString(),
                eTag: `"${md5}"`,
                size: stat.size,
                storageClass: 'STANDARD'
              });
            }
          }
        }
      }
      scan(bucketDir);
    }

    if (req.headers.accept && req.headers.accept.includes('xml')) {
      res.set('Content-Type', 'application/xml');
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${bucket}</Name>
  <Prefix>${prefix}</Prefix>
  <MaxKeys>${maxKeys}</MaxKeys>
  <KeyCount>${objects.length}</KeyCount>
  <IsTruncated>false</IsTruncated>
  ${objects.map(o => `
  <Contents>
    <Key>${o.key}</Key>
    <LastModified>${o.lastModified}</LastModified>
    <ETag>${o.eTag}</ETag>
    <Size>${o.size}</Size>
    <StorageClass>${o.storageClass}</StorageClass>
  </Contents>`).join('')}
</ListBucketResult>`;
      return res.send(xml);
    }

    return res.json({
      name: bucket,
      prefix,
      maxKeys,
      keyCount: objects.length,
      isTruncated: false,
      contents: objects
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 4. PUT /api/s3/:bucket/*key - PutObject (Upload object)
 */
router.put('/:bucket/*key', requireApiKeyOrSession, requirePermission('write'), async (req, res) => {
  try {
    const bucket = req.params.bucket;
    const key = Array.isArray(req.params.key) ? req.params.key.join('/') : (req.params.key || '');
    if (!key) return res.status(400).json({ error: 'Object key is required.' });

    const { absolutePath } = resolveS3Path(req.user.id, bucket, key);
    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    await checkQuota(req.user.id, 0);

    const hash = crypto.createHash('md5');
    const writeStream = fs.createWriteStream(absolutePath);

    const onFinish = async () => {
      try {
        await checkQuota(req.user.id, 0);
        await syncUsedStorage(req.user.id);
        const etag = `"${hash.digest('hex')}"`;
        res.set({
          'ETag': etag,
          'x-amz-request-id': crypto.randomBytes(8).toString('hex'),
          'x-amz-id-2': crypto.randomBytes(16).toString('base64')
        });
        return res.status(200).send();
      } catch (err) {
        if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
        return res.status(err.statusCode || 500).json({ error: err.message });
      }
    };

    writeStream.on('finish', onFinish);
    writeStream.on('error', err => {
      return res.status(500).json({ error: 'Failed to write S3 object: ' + err.message });
    });

    if (req.body && (Buffer.isBuffer(req.body) || typeof req.body === 'string' || (typeof req.body === 'object' && Object.keys(req.body).length > 0))) {
      const data = Buffer.isBuffer(req.body)
        ? req.body
        : typeof req.body === 'string'
        ? Buffer.from(req.body)
        : Buffer.from(JSON.stringify(req.body));
      hash.update(data);
      writeStream.end(data);
    } else {
      req.on('data', chunk => {
        hash.update(chunk);
      });
      req.pipe(writeStream);
    }
  } catch (err) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * 5. GET /api/s3/:bucket/*key - GetObject (Download object)
 */
router.get('/:bucket/*key', async (req, res) => {
  try {
    const bucket = req.params.bucket;
    const key = Array.isArray(req.params.key) ? req.params.key.join('/') : (req.params.key || '');
    // Check auth or locate file
    let userId = null;
    const authHeader = req.headers['authorization'] || '';
    let token = null;
    if (authHeader.startsWith('Bearer ')) token = authHeader.slice(7).trim();
    if (!token) token = req.headers['x-api-key'] || req.headers['x-blob-token'] || req.query.token || req.query.apiKey;

    if (token) {
      const apiKey = await getRow(
        `SELECT user_id FROM api_keys WHERE (secret_key = ? OR key_id = ?) AND is_active = 1;`,
        [token, token]
      );
      if (apiKey) userId = apiKey.user_id;
    }

    let targetFile = null;
    if (userId) {
      const resolved = resolveS3Path(userId, bucket, key);
      if (fs.existsSync(resolved.absolutePath)) {
        targetFile = resolved.absolutePath;
      }
    } else {
      // Look across storage
      const storageRoot = process.env.STORAGE_ROOT || '/tmp/vps_sftp_storage';
      if (fs.existsSync(storageRoot)) {
        const userDirs = fs.readdirSync(storageRoot);
        for (const uDir of userDirs) {
          const check = path.join(storageRoot, uDir, 's3_storage', bucket, key);
          if (fs.existsSync(check)) {
            targetFile = check;
            break;
          }
        }
      }
    }

    if (!targetFile || !fs.existsSync(targetFile)) {
      return res.status(404).json({ error: 'NoSuchKey: The specified key does not exist.' });
    }

    const stat = fs.statSync(targetFile);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Key is a directory, not an object.' });
    }

    const contentType = mime.lookup(targetFile) || 'application/octet-stream';
    const etag = `"${stat.size}-${stat.mtimeMs}"`;

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
        'ETag': etag,
        'Last-Modified': stat.mtime.toUTCString()
      });

      fs.createReadStream(targetFile, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stat.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'ETag': etag,
        'Last-Modified': stat.mtime.toUTCString()
      });

      fs.createReadStream(targetFile).pipe(res);
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * 6. HEAD /api/s3/:bucket/*key - HeadObject
 */
router.head('/:bucket/*key', async (req, res) => {
  try {
    const bucket = req.params.bucket;
    const key = Array.isArray(req.params.key) ? req.params.key.join('/') : (req.params.key || '');
    const storageRoot = process.env.STORAGE_ROOT || '/tmp/vps_sftp_storage';
    let targetFile = null;

    if (fs.existsSync(storageRoot)) {
      const userDirs = fs.readdirSync(storageRoot);
      for (const uDir of userDirs) {
        const check = path.join(storageRoot, uDir, 's3_storage', bucket, key);
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
 * 7. DELETE /api/s3/:bucket/*key - DeleteObject
 */
router.delete('/:bucket/*key', requireApiKeyOrSession, requirePermission('delete'), async (req, res) => {
  try {
    const bucket = req.params.bucket;
    const key = Array.isArray(req.params.key) ? req.params.key.join('/') : (req.params.key || '');
    const { absolutePath } = resolveS3Path(req.user.id, bucket, key);

    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
      await syncUsedStorage(req.user.id);
    }

    return res.status(204).end();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete S3 object: ' + err.message });
  }
});

module.exports = router;
