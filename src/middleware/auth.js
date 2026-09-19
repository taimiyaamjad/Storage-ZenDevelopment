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
 * Authentication Middleware: Verify JWT or Session Token
 */
async function requireAuth(req, res, next) {
  try {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies && req.cookies.session_token) {
      token = req.cookies.session_token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication required. No session token provided.' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await getRow(`SELECT id, name, username, email, email_verified, role, storage_quota_bytes, used_storage_bytes, storage_overage_since, is_suspended, is_suspicious FROM users WHERE id = ?;`, [decoded.userId]);

    if (!user) {
      return res.status(401).json({ error: 'User account no longer exists.' });
    }

    if (user.is_suspended) {
      return res.status(403).json({ error: 'Your account has been suspended by an administrator.' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired authentication session.' });
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
