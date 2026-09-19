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
 * Supports:
 * - 'full', 'all', '*' => read, write, delete
 * - 'read_write', 'read-write', 'rw' => read, write
 * - 'read_only', 'read-only', 'readonly', 'ro' => read
 * - Comma-separated: 'read,write,delete', 'read,write', etc.
 */
function hasPermission(rawPermissions, requiredPerm) {
  if (!rawPermissions) return true; // Default full access if unspecified
  
  const perm = String(requiredPerm).toLowerCase().trim();
  const raw = String(rawPermissions).toLowerCase().trim();

  // Full wildcard access
  if (raw === 'full' || raw === 'all' || raw === '*' || raw === 'admin' || raw === 'root') {
    return true;
  }

  // Parse comma or whitespace separated tokens
  const tokens = raw.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);

  for (const token of tokens) {
    if (token === 'full' || token === 'all' || token === '*' || token === 'admin' || token === 'root') {
      return true;
    }
    if (token === 'read_write' || token === 'read-write' || token === 'rw') {
      if (perm === 'read' || perm === 'write') return true;
    }
    if (token === 'read_only' || token === 'read-only' || token === 'readonly' || token === 'ro') {
      if (perm === 'read') return true;
    }
    if (token === perm) {
      return true;
    }
  }

  return false;
}

function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.apiKey) {
      // Session authenticated users have full access
      return next();
    }
    if (hasPermission(req.apiKey.permissions, perm)) {
      return next();
    }
    return res.status(403).json({
      error: `Forbidden: API key does not have '${perm}' permission. Allowed permissions: ${req.apiKey.permissions}`
    });
  };
}

module.exports = {
  requireApiKeyOrSession,
  requirePermission,
  hasPermission
};
