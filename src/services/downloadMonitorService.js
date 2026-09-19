const { runQuery } = require('../database/db');
const { getClientIp } = require('../middleware/auth');

async function startDownloadMonitor(req, {
  userId = req.user?.id || null,
  username = req.user?.username || null,
  requestedUrl = req.originalUrl || req.url || null,
  endpoint = req.path || null,
  fileName = null,
  filePath = null,
  fileId = null,
  fileSizeBytes = null
} = {}) {
  const ip = getClientIp(req);
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 1000);
  const result = await runQuery(`
    INSERT INTO download_monitor_logs
      (user_id, username, ip_address, requested_url, endpoint, file_name, file_path, file_id, file_size_bytes, status, http_status, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'started', NULL, ?);
  `, [userId, username, ip, requestedUrl, endpoint, fileName, filePath, fileId, fileSizeBytes, userAgent]);
  return result.lastID;
}

async function finishDownloadMonitor(id, { status = 'completed', httpStatus = 200, error = null } = {}) {
  if (!id) return;
  try {
    await runQuery(`
      UPDATE download_monitor_logs
      SET status = ?, http_status = ?, error = ?, completed_at = CURRENT_TIMESTAMP
      WHERE id = ? AND completed_at IS NULL;
    `, [status, httpStatus, error ? String(error).slice(0, 2000) : null, id]);
  } catch (err) {
    console.error('Download monitor completion error:', err.message);
  }
}

function watchResponse(res, monitorId) {
  let finalized = false;
  const complete = (payload) => {
    if (finalized) return;
    finalized = true;
    finishDownloadMonitor(monitorId, payload);
  };
  res.once('finish', () => complete({ status: 'completed', httpStatus: res.statusCode || 200 }));
  res.once('close', () => {
    if (!res.writableEnded) complete({ status: 'aborted', httpStatus: res.statusCode || 499, error: 'Client connection closed before download completed.' });
  });
  return complete;
}

module.exports = { startDownloadMonitor, finishDownloadMonitor, watchResponse };
