const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const dbPath = path.resolve(__dirname, '../../', process.env.DB_FILE || 'data.sqlite');
const db = new sqlite3.Database(dbPath);

// WAL mode lets readers (e.g. an incoming file download request) proceed
// without waiting on writers (e.g. the once-a-second background download-job
// progress updates). Without this, the default rollback-journal mode takes an
// exclusive lock on every write and can make unrelated requests - including
// "Download" clicks - stall behind whatever write happens to be in flight.
// busy_timeout makes SQLite retry briefly instead of failing immediately with
// SQLITE_BUSY when a write does collide with another write.
db.run('PRAGMA journal_mode = WAL;');
db.run('PRAGMA busy_timeout = 5000;');
db.run('PRAGMA synchronous = NORMAL;');

// Helper wrapper for async query execution
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getRow(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function getAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

async function ensureColumn(table, column, definition) {
  const columns = await getAll(`PRAGMA table_info(${table});`);
  if (!columns.some(c => c.name === column)) {
    await runQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function initDatabase() {
  return new Promise((resolve, reject) => {
    db.serialize(async () => {
      try {
        // Enable Foreign Keys
        db.run('PRAGMA foreign_keys = ON;');

        // Users table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            storage_quota_bytes INTEGER NOT NULL DEFAULT 10737418240,
            used_storage_bytes INTEGER NOT NULL DEFAULT 0,
            is_suspended INTEGER NOT NULL DEFAULT 0,
            is_suspicious INTEGER NOT NULL DEFAULT 0,
            suspicious_reason TEXT,
            email_verified INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `);

        // Migrate existing installations that predate email verification.
        await ensureColumn('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
        await ensureColumn('users', 'storage_overage_since', 'DATETIME');
        await runQuery(`UPDATE users SET email_verified = 1 WHERE role = 'admin' AND email_verified = 0;`);

        // Account Email Verification Tokens
        await runQuery(`
          CREATE TABLE IF NOT EXISTS account_email_verifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

        // Sessions table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            ip_v4 TEXT,
            ip_v6 TEXT,
            user_agent TEXT,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

        // IP History table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS ip_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            ip_v4 TEXT,
            ip_v6 TEXT,
            action TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

        // Login History table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS login_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            ip_v4 TEXT,
            ip_v6 TEXT,
            user_agent TEXT,
            status TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

        // Share Links table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS share_links (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            file_path TEXT NOT NULL,
            is_directory INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME,
            is_active INTEGER NOT NULL DEFAULT 1,
            view_count INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

        // Password Reset Tokens
        await runQuery(`
          CREATE TABLE IF NOT EXISTS password_resets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            used INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

        // Email Verifications
        await runQuery(`
          CREATE TABLE IF NOT EXISTS email_verifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            new_email TEXT NOT NULL,
            token TEXT UNIQUE NOT NULL,
            expires_at DATETIME NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

        // SMTP Config
        await runQuery(`
          CREATE TABLE IF NOT EXISTS smtp_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            host TEXT,
            port INTEGER DEFAULT 587,
            username TEXT,
            password TEXT,
            encryption TEXT DEFAULT 'STARTTLS',
            from_email TEXT,
            from_name TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `);

        // App Settings table
        await runQuery(`
          CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
        `);

        // Email Templates
        await runQuery(`
          CREATE TABLE IF NOT EXISTS email_templates (
            slug TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            subject TEXT NOT NULL,
            body_html TEXT NOT NULL
          );
        `);

        // Background URL download jobs
        await runQuery(`
          CREATE TABLE IF NOT EXISTS download_jobs (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            url TEXT NOT NULL,
            target_path TEXT NOT NULL,
            filename TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued',
            progress INTEGER NOT NULL DEFAULT 0,
            bytes INTEGER NOT NULL DEFAULT 0,
            total_bytes INTEGER NOT NULL DEFAULT 0,
            speed_bytes_per_sec INTEGER NOT NULL DEFAULT 0,
            eta_seconds INTEGER NOT NULL DEFAULT 0,
            error TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

        // Progress metrics for background downloads (safe migration for existing databases).
        await ensureColumn('download_jobs', 'speed_bytes_per_sec', 'INTEGER NOT NULL DEFAULT 0');
        await ensureColumn('download_jobs', 'eta_seconds', 'INTEGER NOT NULL DEFAULT 0');

        // Audit Logs
        await runQuery(`
          CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            action TEXT NOT NULL,
            details TEXT,
            ip_address TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
          );
        `);

        // Atomic one-IP-per-account registration locks. This table is only
        // populated for registrations made while Anti Multi-Account Protection
        // is enabled, so disabling the feature never blocks registration.
        await runQuery(`
          CREATE TABLE IF NOT EXISTS registration_ip_locks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL UNIQUE,
            ip_address TEXT NOT NULL UNIQUE,
            ip_version INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

        // URL/share/download monitoring metadata. It intentionally stores only
        // metadata, never file contents, so downloads remain streaming.
        await runQuery(`
          CREATE TABLE IF NOT EXISTS download_monitor_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            username TEXT,
            ip_address TEXT,
            requested_url TEXT,
            endpoint TEXT,
            file_name TEXT,
            file_path TEXT,
            file_id TEXT,
            file_size_bytes INTEGER,
            status TEXT NOT NULL DEFAULT 'started',
            http_status INTEGER,
            user_agent TEXT,
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            error TEXT
          );
        `);

        // Indexes used by registration protection and admin pagination.
        await runQuery(`CREATE INDEX IF NOT EXISTS idx_registration_ip_locks_ip ON registration_ip_locks(ip_address);`);
        await runQuery(`CREATE INDEX IF NOT EXISTS idx_ip_history_timestamp ON ip_history(timestamp DESC);`);
        await runQuery(`CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp DESC);`);
        await runQuery(`CREATE INDEX IF NOT EXISTS idx_download_monitor_started ON download_monitor_logs(started_at DESC);`);
        await runQuery(`CREATE INDEX IF NOT EXISTS idx_download_monitor_user ON download_monitor_logs(user_id, started_at DESC);`);

        // Seed default app settings if missing
        const defaultSettings = [
          ['anti_multi_account_enabled', 'true'],
          ['default_storage_quota_bytes', '10737418240'],
          ['max_share_links_per_user', '3'],
          ['app_name', 'VPS Cloud Manager'],
          ['app_url', 'http://storage.zendevelopment.in'],
          ['website_title', 'VPS SFTP Cloud Manager'],
          ['website_icon_url', ''],
          ['session_timeout_hours', '24'],
          ['discord_enabled', 'false'],
          ['discord_join_url', ''],
          ['contact_email_enabled', 'false'],
          ['contact_email', '']
        ];

        for (const [key, val] of defaultSettings) {
          await runQuery(`INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?);`, [key, val]);
        }

        // Seed default email templates if missing
        const templates = [
  [
    'welcome',
    'Welcome Email',
    'Welcome to {{app_name}}!',
    `
    <div style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827;">
      <div style="max-width:600px;margin:0 auto;background:#ffffff;">

        <!-- Header -->
        <div style="background:#1f1f1f;padding:30px 25px;">
          <div style="font-size:24px;font-weight:700;line-height:1.2;">
            <span style="color:#2563eb;">Zen</span><span style="color:#ffffff;">Development</span>
          </div>
        </div>

        <!-- Content -->
        <div style="padding:30px 25px;">

          <h1 style="margin:0 0 24px 0;font-size:28px;line-height:1.25;color:#111827;font-weight:700;">
            Welcome to<br>
            {{app_name}}
          </h1>

          <p style="margin:0 0 16px 0;font-size:13px;line-height:1.7;color:#374151;">
            Hello {{name}},
          </p>

          <p style="margin:0 0 22px 0;font-size:13px;line-height:1.7;color:#374151;">
            Your account has been successfully created on {{app_name}}.
            We are excited to welcome you to our hosting platform.
          </p>

          <!-- Account Information -->
          <div style="background:#f8fafc;border-left:3px solid #2563eb;padding:18px 16px;margin:0 0 22px 0;">
            <div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:14px;">
              Account Information
            </div>

            <div style="font-size:12px;line-height:1.8;color:#374151;">
              <div>
                Username:
                <strong style="color:#111827;">{{username}}</strong>
              </div>

              <div>
                Your {{app_name}} account is now ready to use.
              </div>
            </div>
          </div>

          <p style="margin:0 0 24px 0;font-size:13px;line-height:1.7;color:#374151;">
            You can now access your hosting dashboard, deploy servers and
            manage your services from your control panel.
          </p>

          <!-- Button -->
          <div style="margin:0 0 24px 0;">
            <a href="#"
               style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;
               font-size:12px;font-weight:700;padding:10px 18px;">
              Open Control Panel
            </a>
          </div>

          <p style="margin:0 0 16px 0;font-size:12px;line-height:1.7;color:#374151;">
            Thank you for choosing {{app_name}} for your hosting needs.
            We look forward to powering your next project.
          </p>

        </div>

        <!-- Footer -->
        <div style="background:#f8fafc;border-top:1px solid #e5e7eb;padding:18px 25px;">
          <p style="margin:0 0 8px 0;font-size:10px;line-height:1.6;color:#6b7280;">
            © ${new Date().getFullYear()} {{app_name}}. All rights reserved.
          </p>

          <p style="margin:0;font-size:10px;line-height:1.6;">
            <a href="#" style="color:#2563eb;text-decoration:none;">
              Your hosting platform
            </a>
          </p>
        </div>

      </div>
    </div>
    `
  ],

  [
    'verify_email',
    'Verify Email Address',
    'Verify your email for {{app_name}}',
    `
    <div style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827;">
      <div style="max-width:600px;margin:0 auto;background:#ffffff;">

        <!-- Header -->
        <div style="background:#1f1f1f;padding:30px 25px;">
          <div style="font-size:24px;font-weight:700;line-height:1.2;">
            <span style="color:#2563eb;">Zen</span><span style="color:#ffffff;">Development</span>
          </div>
        </div>

        <!-- Content -->
        <div style="padding:30px 25px;">

          <h1 style="margin:0 0 22px 0;font-size:28px;line-height:1.25;color:#111827;">
            Verify your<br>
            email address
          </h1>

          <p style="margin:0 0 16px 0;font-size:13px;line-height:1.7;color:#374151;">
            Hello {{name}},
          </p>

          <p style="margin:0 0 24px 0;font-size:13px;line-height:1.7;color:#374151;">
            Thanks for creating your {{app_name}} account.
            Please verify your email address to finish setting up your account.
          </p>

          <div style="margin:0 0 24px 0;">
            <a href="{{verify_url}}"
               style="display:inline-block;background:#2563eb;color:#ffffff;
               padding:11px 20px;text-decoration:none;font-size:12px;font-weight:700;">
              Verify My Email
            </a>
          </div>

          <div style="background:#f8fafc;border-left:3px solid #2563eb;padding:16px;">
            <p style="margin:0;font-size:12px;line-height:1.7;color:#374151;">
              If you did not create this account, you can safely ignore this email.
            </p>
          </div>

        </div>

        <!-- Footer -->
        <div style="background:#f8fafc;border-top:1px solid #e5e7eb;padding:18px 25px;">
          <p style="margin:0;font-size:10px;line-height:1.6;color:#6b7280;">
            © ${new Date().getFullYear()} {{app_name}}. All rights reserved.
          </p>
        </div>

      </div>
    </div>
    `
  ],

  [
    'password_reset',
    'Password Reset Requested',
    'Reset your {{app_name}} Password',
    `
    <div style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827;">
      <div style="max-width:600px;margin:0 auto;background:#ffffff;">

        <!-- Header -->
        <div style="background:#1f1f1f;padding:30px 25px;">
          <div style="font-size:24px;font-weight:700;">
            <span style="color:#2563eb;">Zen</span><span style="color:#ffffff;">Development</span>
          </div>
        </div>

        <!-- Content -->
        <div style="padding:30px 25px;">

          <h1 style="margin:0 0 22px 0;font-size:28px;line-height:1.25;color:#111827;">
            Password Reset<br>
            Request
          </h1>

          <p style="margin:0 0 16px 0;font-size:13px;line-height:1.7;color:#374151;">
            Hello {{name}},
          </p>

          <p style="margin:0 0 24px 0;font-size:13px;line-height:1.7;color:#374151;">
            We received a request to reset your {{app_name}} password.
            Click the button below to create a new password.
          </p>

          <div style="margin:0 0 24px 0;">
            <a href="{{reset_url}}"
               style="display:inline-block;background:#2563eb;color:#ffffff;
               padding:11px 20px;text-decoration:none;font-size:12px;font-weight:700;">
              Reset Password
            </a>
          </div>

          <div style="background:#f8fafc;border-left:3px solid #2563eb;padding:16px;">
            <p style="margin:0;font-size:12px;line-height:1.7;color:#374151;">
              This password-reset link is valid for 1 hour.
            </p>
          </div>

        </div>

        <!-- Footer -->
        <div style="background:#f8fafc;border-top:1px solid #e5e7eb;padding:18px 25px;">
          <p style="margin:0;font-size:10px;line-height:1.6;color:#6b7280;">
            © ${new Date().getFullYear()} {{app_name}}. All rights reserved.
          </p>
        </div>

      </div>
    </div>
    `
  ],

  [
    'email_change',
    'Email Address Verification',
    'Verify your new email address',
    `
    <div style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827;">
      <div style="max-width:600px;margin:0 auto;background:#ffffff;">

        <!-- Header -->
        <div style="background:#1f1f1f;padding:30px 25px;">
          <div style="font-size:24px;font-weight:700;">
            <span style="color:#2563eb;">Zen</span><span style="color:#ffffff;">Development</span>
          </div>
        </div>

        <!-- Content -->
        <div style="padding:30px 25px;">

          <h1 style="margin:0 0 22px 0;font-size:28px;line-height:1.25;color:#111827;">
            Verify your new<br>
            email address
          </h1>

          <p style="margin:0 0 16px 0;font-size:13px;line-height:1.7;color:#374151;">
            Hello {{name}},
          </p>

          <p style="margin:0 0 24px 0;font-size:13px;line-height:1.7;color:#374151;">
            You requested to change the email address associated with
            your {{app_name}} account.
          </p>

          <div style="margin:0 0 24px 0;">
            <a href="{{verify_url}}"
               style="display:inline-block;background:#2563eb;color:#ffffff;
               padding:11px 20px;text-decoration:none;font-size:12px;font-weight:700;">
              Verify Email
            </a>
          </div>

          <div style="background:#f8fafc;border-left:3px solid #2563eb;padding:16px;">
            <p style="margin:0;font-size:12px;line-height:1.7;color:#374151;">
              If you did not request this change, please secure your account immediately.
            </p>
          </div>

        </div>

        <!-- Footer -->
        <div style="background:#f8fafc;border-top:1px solid #e5e7eb;padding:18px 25px;">
          <p style="margin:0;font-size:10px;line-height:1.6;color:#6b7280;">
            © ${new Date().getFullYear()} {{app_name}}. All rights reserved.
          </p>
        </div>

      </div>
    </div>
    `
  ],

  [
    'new_ip_login',
    'New Login Detected',
    'Security Alert: New login to {{app_name}}',
    `
    <div style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827;">
      <div style="max-width:600px;margin:0 auto;background:#ffffff;">

        <!-- Header -->
        <div style="background:#1f1f1f;padding:30px 25px;">
          <div style="font-size:24px;font-weight:700;">
            <span style="color:#2563eb;">Zen</span><span style="color:#ffffff;">Development</span>
          </div>
        </div>

        <!-- Content -->
        <div style="padding:30px 25px;">

          <h1 style="margin:0 0 22px 0;font-size:28px;line-height:1.25;color:#111827;">
            New Login<br>
            Detected
          </h1>

          <p style="margin:0 0 16px 0;font-size:13px;line-height:1.7;color:#374151;">
            Hello {{name}},
          </p>

          <p style="margin:0 0 22px 0;font-size:13px;line-height:1.7;color:#374151;">
            A new login to your {{app_name}} account was detected from
            an unrecognized IP address.
          </p>

          <!-- Login Information -->
          <div style="background:#f8fafc;border-left:3px solid #2563eb;padding:18px 16px;margin-bottom:22px;">
            <div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:14px;">
              Login Information
            </div>

            <div style="font-size:12px;line-height:2;color:#374151;">
              <div>
                <strong>Time:</strong> {{time}}
              </div>

              <div>
                <strong>IPv4:</strong> {{ip_v4}}
              </div>

              <div>
                <strong>IPv6:</strong> {{ip_v6}}
              </div>

              <div>
                <strong>Device:</strong> {{user_agent}}
              </div>
            </div>
          </div>

          <div style="background:#fff7ed;border-left:3px solid #f59e0b;padding:16px;margin-bottom:22px;">
            <p style="margin:0;font-size:12px;line-height:1.7;color:#374151;">
              If this was not you, please reset your password immediately
              and secure your account.
            </p>
          </div>

        </div>

        <!-- Footer -->
        <div style="background:#f8fafc;border-top:1px solid #e5e7eb;padding:18px 25px;">
          <p style="margin:0;font-size:10px;line-height:1.6;color:#6b7280;">
            © ${new Date().getFullYear()} {{app_name}}. All rights reserved.
          </p>
        </div>

      </div>
    </div>
    `
    ]
        ];

        for (const [slug, name, subject, body_html] of templates) {
          await runQuery(
           `
           INSERT INTO email_templates (slug, name, subject, body_html)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET
           name = excluded.name,
           subject = excluded.subject,
           body_html = excluded.body_html;
           `,
            [slug, name, subject, body_html]
           );
        }

        // Seed default Admin Account if no users exist. Wait for the INSERT to finish
        // before resolving database initialization so startup cannot race app_settings reads.
        db.get(`SELECT COUNT(*) as count FROM users;`, async (err, row) => {
          if (err) return reject(err);

          const finish = (seedErr = null) => {
            if (seedErr) return reject(seedErr);
            // Final queue barrier: everything enqueued before this callback is complete.
            db.run('SELECT 1;', barrierErr => {
              if (barrierErr) return reject(barrierErr);
              resolve();
            });
          };

          if (row && row.count === 0) {
            try {
              const hash = await bcrypt.hash('Admin@123456', 10);
              db.run(
                `INSERT INTO users (name, username, email, password_hash, role, storage_quota_bytes, email_verified) VALUES (?, ?, ?, ?, ?, ?, 1);`,
                ['System Admin', 'admin', 'admin@vpsmanager.local', hash, 'admin', 107374182400],
                insertErr => {
                  if (!insertErr) console.log('Default Admin user created: username: "admin", password: "Admin@123456"');
                  finish(insertErr);
                }
              );
            } catch (e) {
              reject(e);
            }
          } else {
            finish();
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

module.exports = {
  db,
  runQuery,
  getRow,
  getAll,
  initDatabase
};
