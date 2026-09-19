const { getRow, runQuery } = require('../database/db');
const { requireAuth } = require('./auth');

/**
 * Middleware to authenticate requests via API Key or Bearer Token (for S3 & Blob API)
 * Supports:
 * - Authorization: Bearer <secret_key>
 * - x-api-key: <secret_key> or <key_id>
 * - x-blob-token: <secret_key>
 * - Query param: ?token=<key> or ?apiKey=<key>
 * - AWS Authorization Header: "AWS4-HMAC-SHA256 Credential=<key_id>/..." or "AWS <key_id>:..."
 * - Falls back to standard JWT session if called from web UI
 */
async function requireApiKeyOrSession(req, res, next) {
  try {
    let keyString = null;
    const authHeader = req.headers['authorization'] || '';

    if (authHeader.startsWith('Bearer ')) {
      keyString = authHeader.slice(7).trim();
    } else if (authHeader.startsWith('AWS4-HMAC-SHA256') || authHeader.startsWith('AWS ')) {
      // Extract AccessKeyId from Credential=<AccessKeyId>/... or AWS <AccessKeyId>:
      const credMatch = authHeader.match(/Credential=([^/]+)/) || authHeader.match(/AWS\s+([^:]+)/);
      if (credMatch) {
        keyString = credMatch[1].trim();
      }
    }

    if (!keyString) {
      keyString = req.headers['x-api-key'] || req.headers['x-blob-token'] || req.query.token || req.query.apiKey;
    }

    if (!keyString) {
      // Check if standard web session token is provided
      return requireAuth(req, res, next);
    }

    // Lookup API key in database by secret_key or key_id
    const apiKey = await getRow(
      `SELECT ak.*, u.name as user_name, u.username, u.email, u.role, u.storage_quota_bytes, u.used_storage_bytes, u.is_suspended
       FROM api_keys ak
       JOIN users u ON ak.user_id = u.id
       WHERE (ak.secret_key = ? OR ak.key_id = ?) AND ak.is_active = 1;`,
      [keyString, keyString]
    );

    if (!apiKey) {
      // Maybe keyString is a JWT token from session?
      try {
        return requireAuth(req, res, next);
      } catch (_) {
        return res.status(401).json({
          error: 'Unauthorized: Invalid or inactive API key. Provide a valid Bearer token or x-api-key header.'
        });
      }
    }

    if (apiKey.is_suspended) {
      return res.status(403).json({ error: 'Access denied: User account is suspended.' });
    }

    // Asynchronously record request count and last used timestamp
    runQuery(
      `UPDATE api_keys SET total_requests = total_requests + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = ?;`,
      [apiKey.id]
    ).catch(() => {});

    req.apiKey = apiKey;
    req.user = {
      id: apiKey.user_id,
      name: apiKey.user_name,
      username: apiKey.username,
      email: apiKey.email,
      role: apiKey.role,
      storage_quota_bytes: apiKey.storage_quota_bytes,
      used_storage_bytes: apiKey.used_storage_bytes
    };

    next();
  } catch (err) {
    return res.status(500).json({ error: 'Authentication error: ' + err.message });
  }
}

/**
 * Check if the active API key has required permission ('read', 'write', 'delete')
 */
function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.apiKey) {
      // Session authenticated users have full access
      return next();
    }
    const permissions = (req.apiKey.permissions || 'read,write,delete').split(',').map(p => p.trim().toLowerCase());
    if (permissions.includes('all') || permissions.includes(perm.toLowerCase())) {
      return next();
    }
    return res.status(403).json({
      error: `Forbidden: API key does not have '${perm}' permission. Allowed permissions: ${req.apiKey.permissions}`
    });
  };
}

module.exports = {
  requireApiKeyOrSession,
  requirePermission
};
