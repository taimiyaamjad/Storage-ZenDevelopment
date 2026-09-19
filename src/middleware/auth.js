const jwt = require('jsonwebtoken');
const net = require('net');
const { getRow, runQuery } = require('../database/db');

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-vps-sftp-jwt-key-2026-change-me-in-prod';

/**
 * Extract IP details (IPv4 and IPv6) from HTTP Request
 */
function normalizeIp(rawIp) {
  if (!rawIp) return null;
  let ip = String(rawIp).trim().replace(/^\[|\]$/g, '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  // Strip a zone id from IPv6 link-local addresses when one is present.
  ip = ip.replace(/%[0-9A-Za-z._-]+$/, '');
  return ip || null;
}

/**
 * Extract the actual client IP from Express' trusted-proxy aware req.ip.
 * index.js configures trust proxy only for the known reverse proxy/loopback.
 * We intentionally do not parse arbitrary X-Forwarded-For ourselves.
 */
function getClientIpDetails(req) {
  const raw = normalizeIp(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress);
  if (!raw) return { ipV4: null, ipV6: null };

  if (net.isIPv4(raw)) return { ipV4: raw, ipV6: null };
  if (net.isIPv6(raw)) return { ipV4: null, ipV6: raw };

  return { ipV4: null, ipV6: null };
}

function getClientIp(req) {
  const { ipV4, ipV6 } = getClientIpDetails(req);
  return ipV4 || ipV6 || null;
}


/**
 * Audit Logger helper
 */
async function logAudit(userId, action, details = '', req = null) {
  const { ipV4 } = req ? getClientIpDetails(req) : { ipV4: '127.0.0.1' };
  try {
    await runQuery(
      `INSERT INTO audit_logs (user_id, action, details, ip_address) VALUES (?, ?, ?, ?);`,
      [userId, action, typeof details === 'object' ? JSON.stringify(details) : details, ipV4]
    );
  } catch (err) {
    console.error('Audit log error:', err);
  }
}

/**
 * Authentication Middleware: Verify JWT or API Key or Session Token
 */
async function requireAuth(req, res, next) {
  try {
    let token = null;
    const authHeader = req.headers.authorization || req.headers.Authorization || '';

    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7).trim();
    } else if (authHeader.startsWith('AWS4-HMAC-SHA256') || authHeader.startsWith('AWS ')) {
      const credMatch = authHeader.match(/Credential=([^/]+)/) || authHeader.match(/AWS\s+([^:]+)/);
      if (credMatch) token = credMatch[1].trim();
    } else if (req.cookies && req.cookies.session_token) {
      token = req.cookies.session_token;
    }

    if (!token) {
      token = req.headers['x-api-key'] || req.headers['x-blob-token'] || req.query.apiKey || req.query.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication required. No session token or API key provided.' });
    }

    // 1. Try JWT session verification first
    let user = null;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded && decoded.userId) {
        user = await getRow(
          `SELECT id, name, username, email, email_verified, role, storage_quota_bytes, used_storage_bytes, storage_overage_since, is_suspended, is_suspicious
           FROM users WHERE id = ?;`,
          [decoded.userId]
        );
      }
    } catch (_) {
      // Not a JWT, try API key lookup below
    }

    // 2. If not a valid JWT, look up as API Key in api_keys table
    if (!user) {
      const apiKey = await getRow(
        `SELECT ak.*, u.id as user_id, u.name as user_name, u.username, u.email, u.email_verified, u.role, u.storage_quota_bytes, u.used_storage_bytes, u.is_suspended, u.is_suspicious
         FROM api_keys ak
         JOIN users u ON ak.user_id = u.id
         WHERE (ak.secret_key = ? OR ak.key_id = ?) AND ak.is_active = 1;`,
        [token, token]
      );

      if (apiKey) {
        // Asynchronously update usage count
        runQuery(
          `UPDATE api_keys SET total_requests = total_requests + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = ?;`,
          [apiKey.id]
        ).catch(() => {});

        user = {
          id: apiKey.user_id,
          name: apiKey.user_name,
          username: apiKey.username,
          email: apiKey.email,
          email_verified: apiKey.email_verified,
          role: apiKey.role,
          storage_quota_bytes: apiKey.storage_quota_bytes,
          used_storage_bytes: apiKey.used_storage_bytes,
          is_suspended: apiKey.is_suspended,
          is_suspicious: apiKey.is_suspicious
        };
        req.apiKey = apiKey;
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired authentication credentials (session token or API key).' });
    }

    if (user.is_suspended) {
      return res.status(403).json({ error: 'Your account has been suspended by an administrator.' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Authentication failed: ' + err.message });
  }
}

/**
 * Admin Middleware: Enforce Admin Role
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Administrator privileges required.' });
  }
  next();
}

module.exports = {
  getClientIpDetails,
  getClientIp,
  logAudit,
  requireAuth,
  requireAdmin,
  JWT_SECRET
};
