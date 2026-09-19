const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, logAudit } = require('../middleware/auth');
const { runQuery, getRow, getAll } = require('../database/db');
const SFTPService = require('../services/sftpService');

/**
 * GET /api/keys - List all API keys for current user
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const keys = await getAll(
      `SELECT id, name, key_id, permissions, rate_limit, total_requests, last_used_at, created_at, is_active
       FROM api_keys
       WHERE user_id = ?
       ORDER BY created_at DESC;`,
      [req.user.id]
    );

    // Also get API storage stats for this user
    let apiStorageBytes = 0;
    try {
      apiStorageBytes = SFTPService.calculatePathBytes(req.user.id, '/s3_storage');
    } catch (_) {
      apiStorageBytes = 0;
    }

    const host = req.get('host') || '127.0.0.1:3000';
    const protocol = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const baseUrl = `${protocol}://${host}`;

    return res.json({
      keys,
      stats: {
        totalKeys: keys.length,
        totalRequests: keys.reduce((acc, k) => acc + (k.total_requests || 0), 0),
        apiStorageBytes,
        quotaBytes: Number(req.user.storage_quota_bytes || 0),
        usedBytes: Number(req.user.used_storage_bytes || 0)
      },
      endpoints: {
        s3Endpoint: `${baseUrl}/api/s3`,
        blobEndpoint: `${baseUrl}/api/v1/blob`,
        blobUpload: `${baseUrl}/api/v1/blob/upload`,
        blobList: `${baseUrl}/api/v1/blob/list`
      }
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch API keys: ' + err.message });
  }
});

/**
 * POST /api/keys - Generate a new API key
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, permissions } = req.body;
    const keyName = (name || 'Default API Key').trim().slice(0, 100);
    const keyPermissions = (permissions || 'read,write,delete').trim();

    // Check maximum keys per user (limit to 25 keys per user)
    const countRow = await getRow(`SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?;`, [req.user.id]);
    if (countRow && countRow.count >= 25) {
      return res.status(400).json({ error: 'Maximum API key limit reached (25 keys per user).' });
    }

    // Generate cryptographically secure tokens
    const keyId = 'zen_ak_' + crypto.randomBytes(12).toString('hex');
    const secretKey = 'zen_sk_' + crypto.randomBytes(24).toString('hex');

    const result = await runQuery(
      `INSERT INTO api_keys (user_id, name, key_id, secret_key, permissions, rate_limit)
       VALUES (?, ?, ?, ?, ?, ?);`,
      [req.user.id, keyName, keyId, secretKey, keyPermissions, 3600]
    );

    await logAudit(req.user.id, 'API_KEY_CREATED', { keyId, name: keyName }, req);

    return res.status(201).json({
      message: 'API Key created successfully! Make sure to copy your Secret Key now as you will not be able to view it again.',
      key: {
        id: result.lastID,
        name: keyName,
        key_id: keyId,
        secret_key: secretKey,
        permissions: keyPermissions,
        rate_limit: 3600,
        total_requests: 0,
        created_at: new Date().toISOString()
      }
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to create API key: ' + err.message });
  }
});

/**
 * DELETE /api/keys/:id - Revoke an API key
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const keyId = req.params.id;
    const key = await getRow(`SELECT * FROM api_keys WHERE id = ? AND user_id = ?;`, [keyId, req.user.id]);
    if (!key) {
      return res.status(404).json({ error: 'API Key not found or does not belong to you.' });
    }

    await runQuery(`DELETE FROM api_keys WHERE id = ?;`, [keyId]);
    await logAudit(req.user.id, 'API_KEY_REVOKED', { keyId: key.key_id, name: key.name }, req);

    return res.json({ message: 'API Key successfully revoked.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to revoke API key: ' + err.message });
  }
});

module.exports = router;
