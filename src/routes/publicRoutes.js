const express = require('express');
const router = express.Router();
const { getAll } = require('../database/db');

// Public, non-sensitive application branding/config used before authentication.
router.get('/settings', async (req, res) => {
  try {
    const rows = await getAll(`
      SELECT key, value
      FROM app_settings
      WHERE key IN ('app_name', 'website_title', 'website_icon_url', 'discord_enabled', 'discord_join_url', 'contact_email_enabled', 'contact_email')
    ;`);

    const settings = {};
    for (const row of rows) settings[row.key] = row.value;

    const title = settings.website_title || settings.app_name || 'VPS SFTP Cloud Manager';
    return res.json({
      appName: settings.app_name || title,
      websiteTitle: title,
      websiteIconUrl: settings.website_icon_url || '',
      discordEnabled: String(settings.discord_enabled || '').toLowerCase() === 'true',
      discordJoinUrl: String(settings.discord_enabled || '').toLowerCase() === 'true' ? (settings.discord_join_url || '') : '',
      contactEmailEnabled: String(settings.contact_email_enabled || '').toLowerCase() === 'true',
      contactEmail: String(settings.contact_email_enabled || '').toLowerCase() === 'true' ? (settings.contact_email || '') : ''
    });
  } catch (err) {
    console.error('Public settings error:', err);
    return res.status(500).json({ error: 'Failed to fetch public settings.' });
  }
});

module.exports = router;
