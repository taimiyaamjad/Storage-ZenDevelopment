const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { getRow, getAll, runQuery } = require('../database/db');
const { requireAuth, requireAdmin, logAudit } = require('../middleware/auth');
const EmailService = require('../services/emailService');
const SFTPService = require('../services/sftpService');
const { resetUserMonthlyCycle, getUserUsageSummary, DEFAULT_MONTHLY_BANDWIDTH_BYTES, DEFAULT_MONTHLY_API_REQUESTS, formatBytes } = require('../services/usageService');

async function sendAdminCreatedUserEmails(userId, name, username, email) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  await runQuery(`DELETE FROM account_email_verifications WHERE user_id = ?;`, [userId]);
  await runQuery(`INSERT INTO account_email_verifications (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+24 hours'));`, [userId, token]);
  const appUrlSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'app_url';`);
  const appUrl = appUrlSetting ? appUrlSetting.value : 'http://storage.zendevelopment.in';
  await EmailService.sendTemplatedEmail('welcome', email, { name, username });
  await EmailService.sendTemplatedEmail('verify_email', email, { name, verify_url: `${appUrl}/#verify-email?token=${token}` });
}

async function sendAdminVerificationEmail(userId, name, email) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  await runQuery(`DELETE FROM account_email_verifications WHERE user_id = ?;`, [userId]);
  await runQuery(`INSERT INTO account_email_verifications (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+24 hours'));`, [userId, token]);
  const appUrlSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'app_url';`);
  const appUrl = appUrlSetting ? appUrlSetting.value : 'http://storage.zendevelopment.in';
  await EmailService.sendTemplatedEmail('verify_email', email, { name, verify_url: `${appUrl}/#verify-email?token=${token}` });
}

const iconUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon', 'image/vnd.microsoft.icon']);
    if (!allowed.has(file.mimetype)) return cb(new Error('Only PNG, JPG, WEBP, GIF, and ICO images are allowed.'));
    cb(null, true);
  }
});

router.use(requireAuth);
router.use(requireAdmin);

/**
 * 1. Admin Stats Dashboard Overview
 */
router.get('/stats', async (req, res) => {
  try {
    const totalUsers = await getRow(`SELECT COUNT(*) as count FROM users;`);
    const activeUsers = await getRow(`SELECT COUNT(*) as count FROM users WHERE is_suspended = 0;`);
    const suspendedUsers = await getRow(`SELECT COUNT(*) as count FROM users WHERE is_suspended = 1;`);
    const suspiciousAccounts = await getRow(`SELECT COUNT(*) as count FROM users WHERE is_suspicious = 1;`);
    const activeShareLinks = await getRow(`SELECT COUNT(*) as count FROM share_links WHERE is_active = 1;`);

    // Total storage usage calculation across all users
    const allUsers = await getAll(`SELECT id, username, name, storage_quota_bytes, is_suspended FROM users;`);
    let totalStorageUsedBytes = 0;
    let totalStorageQuotaBytes = 0;
    const overUsedStorageUsers = [];

    for (const u of allUsers) {
      const realUsed = await SFTPService.calculateUserStorageBytesAsync(u.id);
      totalStorageUsedBytes += realUsed;
      totalStorageQuotaBytes += u.storage_quota_bytes;
      if (realUsed > Number(u.storage_quota_bytes || 0)) {
        const overage = realUsed - Number(u.storage_quota_bytes || 0);
        await runQuery(`UPDATE users SET used_storage_bytes = ?, storage_overage_since = COALESCE(storage_overage_since, CURRENT_TIMESTAMP) WHERE id = ?;`, [realUsed, u.id]);
        overUsedStorageUsers.push({ id: u.id, username: u.username, name: u.name, usedBytes: realUsed, quotaBytes: u.storage_quota_bytes, overageBytes: overage, suspended: !!u.is_suspended });
      } else {
        await runQuery(`UPDATE users SET used_storage_bytes = ?, storage_overage_since = NULL WHERE id = ?;`, [realUsed, u.id]);
      }
    }

    const recentRegistrations = await getAll(`SELECT id, name, username, email, is_suspicious, created_at FROM users ORDER BY created_at DESC LIMIT 5;`);
    const recentLogins = await getAll(`SELECT u.username, l.ip_v4, l.ip_v6, l.status, l.timestamp FROM login_history l JOIN users u ON l.user_id = u.id ORDER BY l.timestamp DESC LIMIT 10;`);

    return res.json({
      totalUsers: totalUsers.count,
      activeUsers: activeUsers.count,
      suspendedUsers: suspendedUsers.count,
      suspiciousAccounts: suspiciousAccounts.count,
      activeShareLinks: activeShareLinks.count,
      totalStorageUsedBytes,
      totalStorageQuotaBytes,
      recentRegistrations,
      recentLogins,
      overUsedStorageUsers
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch admin stats.' });
  }
});

/**
 * 2. User Management - List & Filter Users
 */
router.post('/users', async (req, res) => {
  try {
    const { name, username, email, password, role = 'user', storageQuotaBytes } = req.body || {};

    if (!name || !username || !email || !password) {
      return res.status(400).json({ error: 'Name, username, email, and password are required.' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }
    const normalizedRole = role === 'admin' ? 'admin' : role === 'user' ? 'user' : null;
    if (!normalizedRole) {
      return res.status(400).json({ error: 'Role must be either user or admin.' });
    }

    const normalizedUsername = String(username).trim().toLowerCase();
    const normalizedEmail = String(email).trim().toLowerCase();
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(normalizedUsername)) {
      return res.status(400).json({ error: 'Username must be 3-32 characters and use only letters, numbers, dots, underscores, or hyphens.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const existing = await getRow(`SELECT id FROM users WHERE username = ? OR email = ?;`, [normalizedUsername, normalizedEmail]);
    if (existing) {
      return res.status(409).json({ error: 'Username or email is already registered.' });
    }

    const defaultQuotaSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'default_storage_quota_bytes';`);
    const defaultQuota = defaultQuotaSetting ? parseInt(defaultQuotaSetting.value, 10) : 10737418240;
    const quota = Number.isFinite(Number(storageQuotaBytes)) && Number(storageQuotaBytes) > 0
      ? Math.floor(Number(storageQuotaBytes))
      : defaultQuota;

    const defaultBandwidthSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'default_monthly_bandwidth_bytes';`);
    const defaultBandwidth = defaultBandwidthSetting ? parseInt(defaultBandwidthSetting.value, 10) : DEFAULT_MONTHLY_BANDWIDTH_BYTES;
    const bandwidthLimit = Number.isFinite(Number(req.body.monthlyBandwidthLimitBytes)) && Number(req.body.monthlyBandwidthLimitBytes) > 0
      ? Math.floor(Number(req.body.monthlyBandwidthLimitBytes))
      : defaultBandwidth;

    const defaultApiReqSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'default_monthly_api_requests';`);
    const defaultApiReq = defaultApiReqSetting ? parseInt(defaultApiReqSetting.value, 10) : DEFAULT_MONTHLY_API_REQUESTS;
    const apiRequestsLimit = Number.isFinite(Number(req.body.monthlyApiRequestsLimit)) && Number(req.body.monthlyApiRequestsLimit) > 0
      ? Math.floor(Number(req.body.monthlyApiRequestsLimit))
      : defaultApiReq;

    const resetDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const hash = await bcrypt.hash(String(password), 10);
    const result = await runQuery(
      `INSERT INTO users (name, username, email, password_hash, role, storage_quota_bytes, monthly_bandwidth_limit_bytes, monthly_api_requests_limit, bandwidth_cycle_reset_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [String(name).trim(), normalizedUsername, normalizedEmail, hash, normalizedRole, quota, bandwidthLimit, apiRequestsLimit, resetDate]
    );

    // Initialize the user's private storage directory immediately.
    SFTPService.resolveUserPath(result.lastID, '/');
    await sendAdminCreatedUserEmails(result.lastID, String(name).trim(), normalizedUsername, normalizedEmail);

    await logAudit(req.user.id, 'admin_create_user', {
      targetUserId: result.lastID,
      username: normalizedUsername,
      role: normalizedRole,
      storageQuotaBytes: quota
    }, req);

    return res.status(201).json({
      message: 'User created successfully.',
      user: { id: result.lastID, name: String(name).trim(), username: normalizedUsername, email: normalizedEmail, role: normalizedRole, storage_quota_bytes: quota }
    });
  } catch (err) {
    console.error('Admin create user error:', err);
    if (String(err.message || '').includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Username or email is already registered.' });
    }
    return res.status(500).json({ error: 'Failed to create user.' });
  }
});

router.get('/users', async (req, res) => {
  try {
    const search = req.query.search || '';
    const filter = req.query.filter || 'all';

    let sql = `SELECT id, name, username, email, email_verified, role, storage_quota_bytes, used_storage_bytes, 
                      monthly_bandwidth_limit_bytes, used_bandwidth_bytes, monthly_api_requests_limit, used_api_requests, bandwidth_cycle_reset_at,
                      is_suspended, is_suspicious, suspicious_reason, created_at FROM users WHERE 1=1 `;
    const params = [];

    if (search) {
      sql += ` AND (name LIKE ? OR username LIKE ? OR email LIKE ?) `;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (filter === 'suspended') sql += ` AND is_suspended = 1 `;
    if (filter === 'suspicious') sql += ` AND is_suspicious = 1 `;
    if (filter === 'admin') sql += ` AND role = 'admin' `;

    sql += ` ORDER BY created_at DESC;`;

    const users = await getAll(sql, params);
    const enriched = [];
    for (const u of users) {
      const realUsedBytes = await SFTPService.calculateUserStorageBytesAsync(u.id);
      enriched.push({
        ...u,
        realUsedBytes,
        isOverQuota: realUsedBytes > Number(u.storage_quota_bytes || 0),
        bandwidthFormattedLimit: formatBytes(u.monthly_bandwidth_limit_bytes || DEFAULT_MONTHLY_BANDWIDTH_BYTES),
        bandwidthFormattedUsed: formatBytes(u.used_bandwidth_bytes || 0),
        apiRequestsFormattedLimit: Number(u.monthly_api_requests_limit || DEFAULT_MONTHLY_API_REQUESTS).toLocaleString(),
        apiRequestsFormattedUsed: Number(u.used_api_requests || 0).toLocaleString()
      });
    }

    return res.json(enriched);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

/**
 * 3. Update User (Quota, Bandwidth, API Requests, Role, Suspension Status, Username, Email, Password)
 */
router.put('/users/:id', async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user ID.' });

    const { name, username, email, role, storageQuotaBytes, monthlyBandwidthLimitBytes, monthlyApiRequestsLimit, resetMonthlyCycle: doResetCycle, isSuspended, isSuspicious, newPassword } = req.body || {};
    const user = await getRow(`SELECT * FROM users WHERE id = ?;`, [userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    if (role && !['admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Role must be either user or admin.' });
    }
    if (role === 'user' && userId === req.user.id) {
      return res.status(400).json({ error: 'You cannot remove administrator access from your own account.' });
    }

    const nextUsername = typeof username === 'string' ? username.trim().toLowerCase() : undefined;
    const nextEmail = typeof email === 'string' ? email.trim().toLowerCase() : undefined;
    const nextName = typeof name === 'string' ? name.trim() : undefined;

    if (typeof nextName !== 'undefined' && !nextName) return res.status(400).json({ error: 'Name cannot be empty.' });
    if (typeof nextUsername !== 'undefined' && !/^[a-zA-Z0-9._-]{3,32}$/.test(nextUsername)) {
      return res.status(400).json({ error: 'Username must be 3-32 characters and use only letters, numbers, dots, underscores, or hyphens.' });
    }
    if (typeof nextEmail !== 'undefined' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (typeof newPassword !== 'undefined' && newPassword !== '' && String(newPassword).length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long.' });
    }
    if (typeof storageQuotaBytes !== 'undefined' && (!(Number(storageQuotaBytes) > 0) || !Number.isFinite(Number(storageQuotaBytes)))) {
      return res.status(400).json({ error: 'Storage quota must be greater than 0.' });
    }

    if (typeof nextUsername !== 'undefined' || typeof nextEmail !== 'undefined') {
      const conflict = await getRow(
        `SELECT id, username, email FROM users WHERE id <> ? AND (username = ? OR email = ?) LIMIT 1;`,
        [userId, nextUsername ?? user.username, nextEmail ?? user.email]
      );
      if (conflict) {
        return res.status(409).json({ error: conflict.username === (nextUsername ?? user.username) ? 'Username is already in use.' : 'Email is already in use.' });
      }
    }

    if (typeof nextName !== 'undefined') await runQuery(`UPDATE users SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`, [nextName, userId]);
    if (typeof nextUsername !== 'undefined') await runQuery(`UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`, [nextUsername, userId]);
    const emailChanged = typeof nextEmail !== 'undefined' && nextEmail !== user.email;
    if (typeof nextEmail !== 'undefined') await runQuery(`UPDATE users SET email = ?, email_verified = CASE WHEN ? THEN 0 ELSE email_verified END, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`, [nextEmail, emailChanged ? 1 : 0, userId]);
    if (role) await runQuery(`UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`, [role, userId]);
    if (typeof storageQuotaBytes !== 'undefined') await runQuery(`UPDATE users SET storage_quota_bytes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`, [Math.floor(Number(storageQuotaBytes)), userId]);
    if (typeof monthlyBandwidthLimitBytes !== 'undefined' && Number(monthlyBandwidthLimitBytes) > 0) await runQuery(`UPDATE users SET monthly_bandwidth_limit_bytes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`, [Math.floor(Number(monthlyBandwidthLimitBytes)), userId]);
    if (typeof monthlyApiRequestsLimit !== 'undefined' && Number(monthlyApiRequestsLimit) > 0) await runQuery(`UPDATE users SET monthly_api_requests_limit = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`, [Math.floor(Number(monthlyApiRequestsLimit)), userId]);
    if (doResetCycle) await resetUserMonthlyCycle(userId);
    if (typeof isSuspended !== 'undefined') await runQuery(`UPDATE users SET is_suspended = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`, [isSuspended ? 1 : 0, userId]);
    if (typeof isSuspicious !== 'undefined') await runQuery(`UPDATE users SET is_suspicious = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`, [isSuspicious ? 1 : 0, userId]);

    if (newPassword) {
      const hash = await bcrypt.hash(String(newPassword), 10);
      await runQuery(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`, [hash, userId]);
    }

    if (emailChanged) {
      await sendAdminVerificationEmail(userId, nextName ?? user.name, nextEmail);
    }

    await logAudit(req.user.id, 'admin_update_user', { targetUserId: userId, updates: { ...req.body, newPassword: newPassword ? '[changed]' : undefined } }, req);
    return res.json({ message: 'User updated successfully.' });
  } catch (err) {
    console.error('Admin update user error:', err);
    if (String(err.message || '').includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Username or email is already in use.' });
    }
    return res.status(500).json({ error: 'Failed to update user.' });
  }
});

/**
 * 3b. Admin Instant Reset Monthly Bandwidth & API Usage Cycle
 */
router.post('/users/:id/reset-usage', async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user ID.' });

    const user = await getRow(`SELECT id, username FROM users WHERE id = ?;`, [userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    await resetUserMonthlyCycle(userId);
    await logAudit(req.user.id, 'admin_reset_user_usage', { targetUserId: userId, username: user.username }, req);

    const summary = await getUserUsageSummary(userId);
    return res.json({ message: `Monthly bandwidth and API usage limits reset for ${user.username}.`, summary });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reset usage: ' + err.message });
  }
});

/**
 * 4. Delete User & User Storage Directory
 */
router.delete('/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    if (parseInt(userId, 10) === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own admin account.' });
    }

    // Delete user storage directory
    try {
      const { userDir } = SFTPService.resolveUserPath(userId, '/');
      const fs = require('fs');
      if (fs.existsSync(userDir)) {
        fs.rmSync(userDir, { recursive: true, force: true });
      }
    } catch (e) {}

    await runQuery(`DELETE FROM users WHERE id = ?;`, [userId]);
    await logAudit(req.user.id, 'admin_delete_user', { targetUserId: userId }, req);
    return res.json({ message: 'User deleted successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete user.' });
  }
});

/**
 * 5. Get IP History & Login Logs
 */
router.get('/ip-history', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit || '50', 10) || 50));
    const offset = (page - 1) * limit;
    const totalRow = await getRow(`SELECT COUNT(*) AS count FROM ip_history;`);
    const history = await getAll(`
      SELECT ip.id, u.username, u.email, ip.ip_v4, ip.ip_v6, ip.action, ip.timestamp
      FROM ip_history ip JOIN users u ON ip.user_id = u.id
      ORDER BY ip.timestamp DESC LIMIT ? OFFSET ?;
    `, [limit, offset]);
    return res.json({ items: history, page, limit, total: Number(totalRow?.count || 0), pages: Math.max(1, Math.ceil(Number(totalRow?.count || 0) / limit)) });
  } catch (err) {
    console.error('IP history error:', err);
    return res.status(500).json({ error: 'Failed to fetch IP history.' });
  }
});

router.delete('/ip-history', async (req, res) => {
  try {
    await runQuery(`DELETE FROM ip_history;`);
    await runQuery(`DELETE FROM login_history;`);
    await logAudit(req.user.id, 'admin_clear_ip_logs', {}, req);
    return res.json({ message: 'IP tracking logs cleared successfully.' });
  } catch (err) {
    console.error('Clear IP logs error:', err);
    return res.status(500).json({ error: 'Failed to clear IP tracking logs.' });
  }
});

/**
 * 6. SMTP Configuration GET / POST
 */
router.get('/smtp', async (req, res) => {
  try {
    const smtp = await getRow(`SELECT host, port, username, encryption, from_email, from_name FROM smtp_config WHERE id = 1;`);
    return res.json(smtp || {});
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch SMTP settings.' });
  }
});

router.post('/smtp', async (req, res) => {
  try {
    const { host, port, username, password, encryption, fromEmail, fromName } = req.body;
    const normalizedFromEmail = String(fromEmail || username || '').trim().toLowerCase();
    if (!normalizedFromEmail) return res.status(400).json({ error: 'From Email is required. Use an address allowed by your SMTP provider.' });

    await runQuery(`
      INSERT INTO smtp_config (id, host, port, username, password, encryption, from_email, from_name, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        host=excluded.host, port=excluded.port, username=excluded.username,
        password=COALESCE(NULLIF(excluded.password, ''), smtp_config.password),
        encryption=excluded.encryption, from_email=excluded.from_email,
        from_name=excluded.from_name, updated_at=CURRENT_TIMESTAMP;
    `, [host, port || 587, username, password, encryption || 'STARTTLS', normalizedFromEmail, fromName]);

    await logAudit(req.user.id, 'admin_update_smtp', { host, port, encryption }, req);
    return res.json({ message: 'SMTP settings saved successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save SMTP settings.' });
  }
});

router.post('/smtp/test', async (req, res) => {
  try {
    const { testEmail } = req.body;
    if (!testEmail) return res.status(400).json({ error: 'Test recipient email is required.' });

    await EmailService.sendTestEmail(testEmail);
    return res.json({ message: `Test email successfully sent to ${testEmail}` });
  } catch (err) {
    return res.status(400).json({ error: `SMTP Test Failed: ${err.message}` });
  }
});

/**
 * 7. Application Settings GET / POST
 */
router.get('/settings', async (req, res) => {
  try {
    const rows = await getAll(`SELECT key, value FROM app_settings;`);
    const settingsObj = {};
    for (const r of rows) settingsObj[r.key] = r.value;
    return res.json(settingsObj);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch settings.' });
  }
});


router.post('/settings/icon', (req, res, next) => {
  iconUpload.single('icon')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Invalid website icon upload.' });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please select an image file.' });

    const uploadDir = path.resolve(__dirname, '../../public/uploads/site');
    fs.mkdirSync(uploadDir, { recursive: true });

    const oldSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'website_icon_url';`);
    const oldUrl = oldSetting?.value || '';
    const safeExt = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/x-icon': '.ico',
      'image/vnd.microsoft.icon': '.ico'
    }[req.file.mimetype];

    const fileName = `site-icon-${Date.now()}${safeExt}`;
    const targetPath = path.join(uploadDir, fileName);
    fs.writeFileSync(targetPath, req.file.buffer);

    const publicUrl = `/uploads/site/${fileName}`;
    await runQuery(
      `INSERT INTO app_settings (key, value) VALUES ('website_icon_url', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      [publicUrl]
    );

    // Remove only the previous icon from this app's managed uploads directory.
    if (oldUrl.startsWith('/uploads/site/')) {
      const oldPath = path.resolve(__dirname, '../../public', oldUrl.replace(/^\//, ''));
      if (oldPath.startsWith(uploadDir + path.sep) && oldPath !== targetPath && fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch (_) {}
      }
    }

    await logAudit(req.user.id, 'admin_update_site_icon', { url: publicUrl }, req);
    return res.json({ message: 'Website icon uploaded successfully.', iconUrl: publicUrl });
  } catch (err) {
    console.error('Website icon upload error:', err);
    return res.status(400).json({ error: err.message || 'Failed to upload website icon.' });
  }
});

router.post('/settings', async (req, res) => {
  try {
    const settings = req.body;
    for (const [key, val] of Object.entries(settings)) {
      await runQuery(`INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?;`, [key, String(val), String(val)]);
    }
    await logAudit(req.user.id, 'admin_update_settings', settings, req);
    return res.json({ message: 'Application settings saved successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to save settings.' });
  }
});

/**
 * 8. Email Templates GET / PUT
 */
router.get('/email-templates', async (req, res) => {
  try {
    const templates = await getAll(`SELECT * FROM email_templates;`);
    return res.json(templates);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch email templates.' });
  }
});

router.put('/email-templates/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const { subject, body_html } = req.body;

    await runQuery(`UPDATE email_templates SET subject = ?, body_html = ? WHERE slug = ?;`, [subject, body_html, slug]);
    await logAudit(req.user.id, 'admin_update_email_template', { slug }, req);
    return res.json({ message: 'Template updated successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update email template.' });
  }
});

/**
 * 9. Audit Logs View
 */
router.get('/audit-logs', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit || '50', 10) || 50));
    const offset = (page - 1) * limit;
    const totalRow = await getRow(`SELECT COUNT(*) AS count FROM audit_logs;`);
    const logs = await getAll(`
      SELECT a.id, u.username, a.action, a.details, a.ip_address, a.timestamp
      FROM audit_logs a LEFT JOIN users u ON a.user_id = u.id
      ORDER BY a.timestamp DESC LIMIT ? OFFSET ?;
    `, [limit, offset]);
    return res.json({ items: logs, page, limit, total: Number(totalRow?.count || 0), pages: Math.max(1, Math.ceil(Number(totalRow?.count || 0) / limit)) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch audit logs.' });
  }
});

router.delete('/audit-logs', async (req, res) => {
  try {
    await runQuery(`DELETE FROM audit_logs;`);
    return res.json({ message: 'Audit logs cleared successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to clear audit logs.' });
  }
});

/**
 * Storage Overview. Values come from the actual filesystem and user directories.
 */
router.get('/storage', async (req, res) => {
  try {
    const filesystem = await SFTPService.getFilesystemStorageStats();
    const users = await getAll(`
      SELECT id, username, email, role, storage_quota_bytes, is_suspended
      FROM users ORDER BY username COLLATE NOCASE ASC;
    `);

    const userStorage = [];
    let totalAllocatedBytes = 0;
    let totalUsedBytes = 0;

    for (const u of users) {
      const allocated = Math.max(0, Number(u.storage_quota_bytes || 0));
      const used = await SFTPService.calculateUserStorageBytesAsync(u.id);
      const remaining = Math.max(0, allocated - used);
      const overage = Math.max(0, used - allocated);
      const usagePercent = allocated > 0 ? (used / allocated) * 100 : (used > 0 ? 100 : 0);
      totalAllocatedBytes += allocated;
      totalUsedBytes += used;
      userStorage.push({
        id: u.id, username: u.username, email: u.email, role: u.role,
        allocatedBytes: allocated, usedBytes: used, remainingBytes: remaining,
        overageBytes: overage, usagePercent: Number(usagePercent.toFixed(2)),
        isOverQuota: overage > 0, status: u.is_suspended ? 'Suspended' : 'Active'
      });
      await runQuery(
        `UPDATE users SET used_storage_bytes = ?, storage_overage_since = CASE WHEN ? > storage_quota_bytes THEN COALESCE(storage_overage_since, CURRENT_TIMESTAMP) ELSE NULL END WHERE id = ?;`,
        [used, used, u.id]
      );
    }

    return res.json({
      filesystem,
      summary: {
        totalUsers: users.length,
        totalAllocatedBytes,
        totalUsedBytes,
        totalRemainingBytes: Math.max(0, totalAllocatedBytes - totalUsedBytes)
      },
      users: userStorage
    });
  } catch (err) {
    console.error('Storage overview error:', err);
    return res.status(500).json({ error: 'Unable to calculate storage information. Check filesystem permissions and storage configuration.' });
  }
});

router.get('/download-monitor-logs', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit || '50', 10) || 50));
    const offset = (page - 1) * limit;
    const totalRow = await getRow(`SELECT COUNT(*) AS count FROM download_monitor_logs;`);
    const logs = await getAll(`
      SELECT id, user_id, username, ip_address, requested_url, endpoint, file_name,
             file_path, file_id, file_size_bytes, status, http_status, user_agent,
             started_at, completed_at, error
      FROM download_monitor_logs
      ORDER BY started_at DESC LIMIT ? OFFSET ?;
    `, [limit, offset]);
    return res.json({ items: logs, page, limit, total: Number(totalRow?.count || 0), pages: Math.max(1, Math.ceil(Number(totalRow?.count || 0) / limit)) });
  } catch (err) {
    console.error('Download monitor list error:', err);
    return res.status(500).json({ error: 'Failed to fetch download monitoring logs.' });
  }
});

router.delete('/download-monitor-logs', async (req, res) => {
  try {
    await runQuery(`DELETE FROM download_monitor_logs;`);
    return res.json({ message: 'Download monitoring logs cleared successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to clear download monitoring logs.' });
  }
});

module.exports = router;
