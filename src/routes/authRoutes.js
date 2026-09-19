const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getRow, getAll, runQuery } = require('../database/db');
const { getClientIpDetails, logAudit, requireAuth, JWT_SECRET } = require('../middleware/auth');
const EmailService = require('../services/emailService');
const SFTPService = require('../services/sftpService');

async function sendAccountVerificationEmail(userId, name, email) {
  const token = crypto.randomBytes(32).toString('hex');
  await runQuery(`DELETE FROM account_email_verifications WHERE user_id = ?;`, [userId]);
  await runQuery(`INSERT INTO account_email_verifications (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+24 hours'));`, [userId, token]);
  const appUrlSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'app_url';`);
  const appUrl = appUrlSetting ? appUrlSetting.value : 'http://storage.zendevelopment.in';
  const verifyUrl = `${appUrl}/#verify-email?token=${token}`;
  await EmailService.sendTemplatedEmail('verify_email', email, { name, verify_url: verifyUrl });
  return token;
}

/**
 * 1. User Registration
 */
router.post('/register', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const username = (req.body.username || '').trim();
    const email = (req.body.email || '').trim();
    const password = req.body.password ? String(req.body.password) : '';
    const confirmPassword = req.body.confirmPassword !== undefined ? String(req.body.confirmPassword) : null;

    if (!name || !username || !email || !password) {
      return res.status(400).json({ error: 'All registration fields (name, username, email, password) are required.' });
    }

    if (confirmPassword !== null && password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    // Check duplicate email or username
    const existingUser = await getRow(`SELECT id FROM users WHERE email = ? OR username = ?;`, [email.toLowerCase(), username.toLowerCase()]);
    if (existingUser) {
      return res.status(400).json({ error: 'Email or Username is already registered.' });
    }

    const { ipV4, ipV6 } = getClientIpDetails(req);

    // Anti Multi-Account Check logic
    const antiMultiEnabledSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'anti_multi_account_enabled';`);
    const antiMultiEnabled = antiMultiEnabledSetting ? antiMultiEnabledSetting.value === 'true' : true;

    const normalizedIp = ipV4 || ipV6;
    if (!normalizedIp) {
      return res.status(400).json({ error: 'Unable to determine your client IP address. Please try again.' });
    }

    // Get Default storage quota setting
    const defaultQuotaSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'default_storage_quota_bytes';`);
    const defaultQuotaBytes = defaultQuotaSetting ? parseInt(defaultQuotaSetting.value, 10) : 10737418240; // 10 GB

    const hash = await bcrypt.hash(password, 10);

    // Registration and the one-IP lock are performed atomically. The unique
    // registration_ip_locks constraint closes the check-then-insert race.
    await runQuery(`BEGIN IMMEDIATE TRANSACTION;`);
    let newUserId;
    try {
      if (antiMultiEnabled) {
        const existingIp = await getRow(
          `SELECT user_id FROM ip_history WHERE action = 'registration' AND (ip_v4 = ? OR ip_v6 = ?) LIMIT 1;`,
          [ipV4 || null, ipV6 || null]
        );
        if (existingIp) {
          await runQuery(`ROLLBACK;`);
          return res.status(409).json({ error: 'Account registration is not allowed from this IP because an account has already been created from this IP address.' });
        }

      }

      const result = await runQuery(
        `INSERT INTO users (name, username, email, password_hash, role, storage_quota_bytes)
         VALUES (?, ?, ?, ?, 'user', ?);`,
        [name, username.toLowerCase(), email.toLowerCase(), hash, defaultQuotaBytes]
      );
      newUserId = result.lastID;

      if (antiMultiEnabled) {
        await runQuery(
          `INSERT INTO registration_ip_locks (user_id, ip_address, ip_version) VALUES (?, ?, ?);`,
          [newUserId, normalizedIp, ipV4 ? 4 : 6]
        );
      }

      await runQuery(
        `INSERT INTO ip_history (user_id, ip_v4, ip_v6, action) VALUES (?, ?, ?, 'registration');`,
        [newUserId, ipV4, ipV6]
      );
      await runQuery(`COMMIT;`);
    } catch (txErr) {
      try { await runQuery(`ROLLBACK;`); } catch (_) {}
      if (String(txErr.message).includes('UNIQUE constraint failed: registration_ip_locks.ip_address')) {
        return res.status(409).json({ error: 'Account registration is not allowed from this IP because an account has already been created from this IP address.' });
      }
      if (String(txErr.message).includes('UNIQUE constraint failed: users.')) {
        return res.status(409).json({ error: 'Email or Username is already registered.' });
      }
      throw txErr;
    }

    // Initialize User SFTP Storage Directory
    SFTPService.resolveUserPath(newUserId, '/');

    // Audit log
    await logAudit(newUserId, 'user_registration', { ipV4, ipV6, antiMultiAccountEnabled: antiMultiEnabled }, req);

    // Send two onboarding emails: welcome first, then email verification.
    await EmailService.sendTemplatedEmail('welcome', email, { name, username });
    await sendAccountVerificationEmail(newUserId, name, email);

    // Issue instant session token for seamless API / client onboarding
    const token = jwt.sign(
      { userId: newUserId, role: 'user' },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(201).json({
      message: 'Registration successful! Please check your email for the welcome and verification messages.',
      token,
      userId: newUserId,
      user: {
        id: newUserId,
        name,
        username: username.toLowerCase(),
        email: email.toLowerCase(),
        role: 'user',
        emailVerified: false,
        storageQuotaBytes: defaultQuotaBytes
      }
    });
  } catch (err) {
    console.error('Registration Error:', err);
    return res.status(500).json({ error: 'Server error during registration.' });
  }
});

/**
 * 2. User Login
 */
router.post('/login', async (req, res) => {
  try {
    const rawIdentifier = req.body.usernameOrEmail || req.body.username || req.body.email || req.body.identifier || req.body.user;
    const usernameOrEmail = rawIdentifier ? String(rawIdentifier).trim() : '';
    const password = req.body.password ? String(req.body.password) : '';

    if (!usernameOrEmail || !password) {
      return res.status(400).json({ error: 'Username/Email and password are required.' });
    }

    const user = await getRow(
      `SELECT * FROM users WHERE email = ? OR username = ?;`,
      [usernameOrEmail.toLowerCase(), usernameOrEmail.toLowerCase()]
    );

    const { ipV4, ipV6 } = getClientIpDetails(req);
    const userAgent = req.headers['user-agent'] || 'Unknown Device';

    if (!user) {
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    if (user.is_suspended) {
      await runQuery(`INSERT INTO login_history (user_id, ip_v4, ip_v6, user_agent, status) VALUES (?, ?, ?, ?, 'blocked');`, [user.id, ipV4, ipV6, userAgent]);
      return res.status(403).json({ error: 'Account is suspended. Please contact system administrator.' });
    }

    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      await runQuery(`INSERT INTO login_history (user_id, ip_v4, ip_v6, user_agent, status) VALUES (?, ?, ?, ?, 'failed');`, [user.id, ipV4, ipV6, userAgent]);
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    // Check if IP is new/unrecognized in user's login history
    const knownIp = await getRow(`SELECT id FROM ip_history WHERE user_id = ? AND ip_v4 = ?;`, [user.id, ipV4]);
    if (!knownIp) {
      // Send New IP Login Alert Email
      EmailService.sendTemplatedEmail('new_ip_login', user.email, {
        name: user.name,
        time: new Date().toLocaleString(),
        ip_v4: ipV4,
        ip_v6: ipV6 || 'N/A',
        user_agent: userAgent
      });
    }

    // Record IP history and Login history
    await runQuery(`INSERT INTO ip_history (user_id, ip_v4, ip_v6, action) VALUES (?, ?, ?, 'login');`, [user.id, ipV4, ipV6]);
    await runQuery(`INSERT INTO login_history (user_id, ip_v4, ip_v6, user_agent, status) VALUES (?, ?, ?, ?, 'success');`, [user.id, ipV4, ipV6, userAgent]);

    // Issue Session JWT
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    await logAudit(user.id, 'user_login', { ipV4, userAgent }, req);

    return res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: user.role,
        emailVerified: !!user.email_verified,
        storageQuotaBytes: user.storage_quota_bytes
      }
    });
  } catch (err) {
    console.error('Login Error:', err);
    return res.status(500).json({ error: 'Server error during login.' });
  }
});

/**
 * 3. Get Current User Profile & IP Info
 */
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const { ipV4, ipV6 } = getClientIpDetails(req);
    const usedBytes = SFTPService.calculateUserStorageBytes(req.user.id);

    // Update real usage in DB and record any quota overage start time.
    if (usedBytes > Number(req.user.storage_quota_bytes || 0)) {
      await runQuery(`UPDATE users SET used_storage_bytes = ?, storage_overage_since = COALESCE(storage_overage_since, CURRENT_TIMESTAMP) WHERE id = ?;`, [usedBytes, req.user.id]);
    } else {
      await runQuery(`UPDATE users SET used_storage_bytes = ?, storage_overage_since = NULL WHERE id = ?;`, [usedBytes, req.user.id]);
    }

    const recentActivity = await getAll(
      `SELECT ip_v4, ip_v6, user_agent, status, timestamp FROM login_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT 5;`,
      [req.user.id]
    );

    return res.json({
      user: {
        ...req.user,
        usedStorageBytes: usedBytes,
        emailVerified: !!req.user.email_verified,
        storageOverageSince: usedBytes > Number(req.user.storage_quota_bytes || 0) ? (req.user.storage_overage_since || null) : null,
        isStorageOverQuota: usedBytes > Number(req.user.storage_quota_bytes || 0)
      },
      currentIp: {
        ipV4,
        ipV6: ipV6 || 'N/A'
      },
      recentActivity
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to retrieve profile.' });
  }
});

/**
 * 4. Update Profile Info (Name, Username, Password)
 */
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { name, username, currentPassword, newPassword } = req.body;

    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required to set a new password.' });
      }

      const fullUser = await getRow(`SELECT password_hash FROM users WHERE id = ?;`, [req.user.id]);
      const validPass = await bcrypt.compare(currentPassword, fullUser.password_hash);
      if (!validPass) {
        return res.status(400).json({ error: 'Current password is incorrect.' });
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      await runQuery(`UPDATE users SET password_hash = ? WHERE id = ?;`, [newHash, req.user.id]);
    }

    if (name) {
      await runQuery(`UPDATE users SET name = ? WHERE id = ?;`, [name, req.user.id]);
    }

    if (username && username.toLowerCase() !== req.user.username) {
      const existing = await getRow(`SELECT id FROM users WHERE username = ? AND id != ?;`, [username.toLowerCase(), req.user.id]);
      if (existing) {
        return res.status(400).json({ error: 'Username is already taken.' });
      }
      await runQuery(`UPDATE users SET username = ? WHERE id = ?;`, [username.toLowerCase(), req.user.id]);
    }

    await logAudit(req.user.id, 'update_profile', {}, req);
    return res.json({ message: 'Profile updated successfully.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to update profile.' });
  }
});

/**
 * Account Email Verification
 */
router.post('/email/resend-verification', requireAuth, async (req, res) => {
  try {
    const user = await getRow(`SELECT id, name, email, email_verified FROM users WHERE id = ?;`, [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (user.email_verified) return res.json({ message: 'Your email is already verified.' });

    const recent = await getRow(`SELECT id FROM account_email_verifications WHERE user_id = ? AND created_at > datetime('now', '-60 seconds') ORDER BY created_at DESC LIMIT 1;`, [user.id]);
    if (recent) {
      return res.status(429).json({ error: 'Please wait 60 seconds before requesting another verification email.' });
    }

    await sendAccountVerificationEmail(user.id, user.name, user.email);
    await logAudit(user.id, 'resend_email_verification', {}, req);
    return res.json({ message: 'Verification email sent again.' });
  } catch (err) {
    console.error('Resend verification error:', err);
    return res.status(500).json({ error: 'Failed to resend verification email.' });
  }
});

router.post('/email/verify-account', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Verification token is missing.' });

    const rec = await getRow(`SELECT * FROM account_email_verifications WHERE token = ? AND expires_at > CURRENT_TIMESTAMP;`, [token]);
    if (!rec) return res.status(400).json({ error: 'Invalid or expired email verification token.' });

    await runQuery(`UPDATE users SET email_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`, [rec.user_id]);
    await runQuery(`DELETE FROM account_email_verifications WHERE user_id = ?;`, [rec.user_id]);
    await logAudit(rec.user_id, 'verify_account_email', {}, req);

    return res.json({ message: 'Your email address has been verified successfully.' });
  } catch (err) {
    console.error('Verify account email error:', err);
    return res.status(500).json({ error: 'Failed to verify email address.' });
  }
});

/**
 * 5. Email Change System with Token Verification
 */
router.post('/email/request-change', requireAuth, async (req, res) => {
  try {
    const { newEmail, password } = req.body;

    if (!newEmail || !password) {
      return res.status(400).json({ error: 'New email address and current password are required.' });
    }

    const fullUser = await getRow(`SELECT password_hash FROM users WHERE id = ?;`, [req.user.id]);
    const validPass = await bcrypt.compare(password, fullUser.password_hash);
    if (!validPass) {
      return res.status(400).json({ error: 'Password verification failed.' });
    }

    const existing = await getRow(`SELECT id FROM users WHERE email = ?;`, [newEmail.toLowerCase()]);
    if (existing) {
      return res.status(400).json({ error: 'This email is already in use by another account.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour

    await runQuery(
      `INSERT INTO email_verifications (user_id, new_email, token, expires_at) VALUES (?, ?, ?, ?);`,
      [req.user.id, newEmail.toLowerCase(), token, expiresAt]
    );

    const appUrlSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'app_url';`);
    const appUrl = appUrlSetting ? appUrlSetting.value : 'http://storage.zendevelopment.in';
    const verifyUrl = `${appUrl}/#verify-email-change?token=${token}`;

    EmailService.sendTemplatedEmail('email_change', newEmail, {
      name: req.user.name,
      verify_url: verifyUrl
    });

    await logAudit(req.user.id, 'request_email_change', { newEmail }, req);
    return res.json({ message: 'Verification link sent to your new email address.' });
  } catch (err) {
    return res.status(500).json({ error: 'Error requesting email change.' });
  }
});

router.post('/email/verify-change', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Verification token is missing.' });

    const rec = await getRow(`SELECT * FROM email_verifications WHERE token = ? AND expires_at > CURRENT_TIMESTAMP;`, [token]);
    if (!rec) {
      return res.status(400).json({ error: 'Invalid or expired email verification token.' });
    }

    await runQuery(`UPDATE users SET email = ?, email_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`, [rec.new_email, rec.user_id]);
    await runQuery(`DELETE FROM email_verifications WHERE user_id = ?;`, [rec.user_id]);

    await logAudit(rec.user_id, 'verify_email_change', { newEmail: rec.new_email }, req);
    return res.json({ message: 'Email address updated successfully!' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to verify email change.' });
  }
});

/**
 * 6. Forgot Password & Reset
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });

    const user = await getRow(`SELECT * FROM users WHERE email = ?;`, [email.toLowerCase()]);
    if (!user) {
      // Return neutral message for security
      return res.json({ message: 'If an account exists with that email, a password reset link has been sent.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour

    await runQuery(
      `INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, ?);`,
      [user.id, token, expiresAt]
    );

    const appUrlSetting = await getRow(`SELECT value FROM app_settings WHERE key = 'app_url';`);
    const appUrl = appUrlSetting ? appUrlSetting.value : 'http://storage.zendevelopment.in';
    const resetUrl = `${appUrl}/#reset-password?token=${token}`;

    EmailService.sendTemplatedEmail('password_reset', user.email, {
      name: user.name,
      reset_url: resetUrl
    });

    await logAudit(user.id, 'forgot_password_request', {}, req);
    return res.json({ message: 'If an account exists with that email, a password reset link has been sent.' });
  } catch (err) {
    return res.status(500).json({ error: 'Error processing forgot password request.' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required.' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const resetRec = await getRow(
      `SELECT * FROM password_resets WHERE token = ? AND used = 0 AND expires_at > CURRENT_TIMESTAMP;`,
      [token]
    );

    if (!resetRec) {
      return res.status(400).json({ error: 'Invalid, used, or expired reset token.' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await runQuery(`UPDATE users SET password_hash = ? WHERE id = ?;`, [hash, resetRec.user_id]);
    await runQuery(`UPDATE password_resets SET used = 1 WHERE id = ?;`, [resetRec.id]);

    await logAudit(resetRec.user_id, 'password_reset_success', {}, req);
    return res.json({ message: 'Password reset successful! You can now log in with your new password.' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to reset password.' });
  }
});

module.exports = router;
