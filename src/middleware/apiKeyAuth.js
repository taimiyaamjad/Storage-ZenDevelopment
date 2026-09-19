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
  return requireAuth(req, res, next);
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
