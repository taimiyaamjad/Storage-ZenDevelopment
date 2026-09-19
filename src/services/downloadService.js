const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const SFTPService = require('./sftpService');
const { getRow, getAll, runQuery } = require('../database/db');
const { startDownloadMonitor, finishDownloadMonitor } = require('./downloadMonitorService');

const jobs = new Map();
const TEMP_ROOT = path.resolve(process.env.DOWNLOAD_TEMP_ROOT || '/tmp/vps-sftp-downloads');
if (!fs.existsSync(TEMP_ROOT)) fs.mkdirSync(TEMP_ROOT, { recursive: true });

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 0) || (a >= 224);
  }
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('ff');
  }
  return true;
}

async function validateRemoteUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl).trim()); } catch (_) { throw new Error('Enter a valid download URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS download links are supported.');
  if (url.username || url.password) throw new Error('URLs with embedded usernames or passwords are not allowed.');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'metadata.google.internal') {
    throw new Error('This download host is not allowed.');
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Private or local network download addresses are not allowed.');
  } else {
    let addresses;
    try { addresses = await dns.lookup(hostname, { all: true }); }
    catch (_) { throw new Error('Could not resolve the download host.'); }
    if (!addresses.length || addresses.some(a => isPrivateIp(a.address))) {
      throw new Error('The download host resolves to a private or local network address, which is not allowed.');
    }
  }
  return url.toString();
}

function safeFilename(name, fallback = `download-${Date.now()}`) {
  let value = String(name || '').trim();
  value = path.basename(value).replace(/[\u0000<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '');
  if (!value || value === '.' || value === '..') value = fallback;
  return value.slice(0, 240);
}

function uniqueDestination(userId, targetDir, filename) {
  const { absolutePath: dirAbs } = SFTPService.resolveUserPath(userId, targetDir);
  if (!fs.existsSync(dirAbs)) fs.mkdirSync(dirAbs, { recursive: true });
  const parsed = path.parse(filename);
  let candidate = filename;
  let i = 1;
  while (fs.existsSync(path.join(dirAbs, candidate))) candidate = `${parsed.name} (${i++})${parsed.ext}`;
  return { dirAbs, filename: candidate, absolutePath: path.join(dirAbs, candidate) };
}

function clampProgress(value) { return Math.max(0, Math.min(100, Math.round(Number(value) || 0))); }

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return;
  // A download must never visually move backwards. Only a new download starts at 0.
  if (patch.progress != null) patch.progress = Math.max(job.progress || 0, clampProgress(patch.progress));
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  jobs.set(jobId, job);
  runQuery(`UPDATE download_jobs SET status = ?, progress = ?, bytes = ?, total_bytes = ?, speed_bytes_per_sec = ?, eta_seconds = ?, filename = ?, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?;`, [
    job.status, job.progress || 0, job.bytes || 0, job.totalBytes || 0,
    Math.max(0, Math.round(job.speedBytesPerSec || 0)), Math.max(0, Math.round(job.etaSeconds || 0)),
    job.filename || '', job.error || null, jobId
  ]).catch(err => console.error('Download job DB update error:', err.message));
}

function parseTotalBytes(text) {
  // wget prints e.g. "Length: 123456 (118K)" for a known Content-Length.
  let match = text.match(/(?:Length:|Content-Length:\s*)(\d+)/i);
  return match ? Number(match[1]) : null;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec < 1) return '—';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let n = bytesPerSec, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i >= 2 ? 2 : 1)} ${units[i]}`;
}

async function startDownload({ userId, url, filename, targetDir, request = null }) {
  const cleanUrl = await validateRemoteUrl(url);
  const user = await getRow(`SELECT storage_quota_bytes FROM users WHERE id = ?;`, [userId]);
  if (!user) throw new Error('User account not found.');
  const used = SFTPService.calculateUserStorageBytes(userId);
  const remaining = Number(user.storage_quota_bytes || 0) - used;
  if (remaining <= 0) throw new Error('Your storage quota is already full.');

  const requestedName = safeFilename(filename);
  const urlPathName = safeFilename(new URL(cleanUrl).pathname.split('/').filter(Boolean).pop(), requestedName);
  const finalBaseName = String(filename || '').trim() ? requestedName : urlPathName;
  const destination = uniqueDestination(userId, targetDir || '/', finalBaseName);
  const jobId = crypto.randomBytes(12).toString('hex');
  const tempPath = path.join(TEMP_ROOT, `${jobId}.part`);
  const root = SFTPService.resolveUserPath(userId, '/').userDir;
  const relativePath = path.relative(root, destination.absolutePath).replace(/\\/g, '/');
  const displayPath = '/' + relativePath.replace(/^\/+/, '');

  await runQuery(`INSERT INTO download_jobs (id, user_id, url, target_path, filename, status, progress, bytes, total_bytes, speed_bytes_per_sec, eta_seconds) VALUES (?, ?, ?, ?, ?, 'queued', 0, 0, 0, 0, 0);`, [jobId, userId, cleanUrl, displayPath, destination.filename]);
  let monitorId = null;
  if (request) {
    try {
      monitorId = await startDownloadMonitor(request, {
        requestedUrl: request.originalUrl,
        endpoint: request.path,
        fileName: destination.filename,
        filePath: displayPath
      });
    } catch (err) {
      console.error('URL download monitor start error:', err.message);
    }
  }
  const job = { id: jobId, userId, url: cleanUrl, filename: destination.filename, targetPath: displayPath, status: 'queued', progress: 0, bytes: 0, totalBytes: 0, speedBytesPerSec: 0, etaSeconds: 0, error: null, tempPath, monitorId };
  jobs.set(jobId, job);
  process.nextTick(() => runWget(job, destination.absolutePath, remaining).catch(err => {
    console.error('Background wget error:', err);
    updateJob(jobId, { status: 'failed', error: err.message, progress: 0, speedBytesPerSec: 0, etaSeconds: 0 });
    finishDownloadMonitor(job.monitorId, { status: 'failed', httpStatus: 500, error: err.message });
  }));
  return { id: jobId, filename: destination.filename, path: displayPath, status: 'queued' };
}

async function runWget(job, destinationPath, remainingBytes) {
  updateJob(job.id, { status: 'running', progress: 0 });
  // Wget does not support curl's --max-filesize option. Quota enforcement is
  // handled below by watching the temporary file and stopping wget if it grows
  // past the user's remaining storage.
  const args = [
    '--progress=bar:force:noscroll', '--server-response', '--max-redirect=5',
    '--tries=3', '--timeout=30',
    '--output-document', job.tempPath, job.url
  ];

  await new Promise((resolve) => {
    const child = spawn('wget', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    job.pid = child.pid;
    let stderr = '';
    let totalBytes = 0;
    let lastBytes = 0;
    let lastTime = Date.now();
    let smoothedSpeed = 0;
    let progressTimer = null;
    let quotaGuardTimer = null;
    let quotaExceeded = false;

    const sample = () => {
      let bytes = 0;
      try { if (fs.existsSync(job.tempPath)) bytes = fs.statSync(job.tempPath).size; } catch (_) {}
      const now = Date.now();
      const dt = Math.max(0.25, (now - lastTime) / 1000);
      const instant = Math.max(0, (bytes - lastBytes) / dt);
      if (instant > 0) smoothedSpeed = smoothedSpeed ? (smoothedSpeed * 0.65 + instant * 0.35) : instant;
      lastBytes = bytes; lastTime = now;
      const knownTotal = totalBytes || job.totalBytes || 0;
      const pct = knownTotal > 0 ? Math.max(0, Math.min(100, (bytes / knownTotal) * 100)) : 0;
      const eta = knownTotal > bytes && smoothedSpeed > 0 ? Math.ceil((knownTotal - bytes) / smoothedSpeed) : 0;
      updateJob(job.id, { bytes, totalBytes: knownTotal, progress: pct, speedBytesPerSec: smoothedSpeed, etaSeconds: eta });
    };

    progressTimer = setInterval(sample, 1000);
    quotaGuardTimer = setInterval(() => {
      try {
        if (fs.existsSync(job.tempPath)) {
          const bytes = fs.statSync(job.tempPath).size;
          if (bytes > remainingBytes) {
            quotaExceeded = true;
            child.kill('SIGKILL');
          }
        }
      } catch (_) {}
    }, 250);

    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-8000);
      const parsedTotal = parseTotalBytes(stderr);
      if (parsedTotal && parsedTotal > 0) totalBytes = parsedTotal;
    });
    child.on('error', err => {
      if (progressTimer) clearInterval(progressTimer);
      if (quotaGuardTimer) clearInterval(quotaGuardTimer);
      const monitorError = quotaExceeded ? 'Downloaded file exceeds your remaining storage quota.' : err.message;
      updateJob(job.id, { status: 'failed', error: monitorError, speedBytesPerSec: 0, etaSeconds: 0 });
      finishDownloadMonitor(job.monitorId, { status: 'failed', httpStatus: 500, error: monitorError });
      if (fs.existsSync(job.tempPath)) { try { fs.unlinkSync(job.tempPath); } catch (_) {} }
      resolve();
    });
    child.on('close', async code => {
      if (progressTimer) clearInterval(progressTimer);
      if (quotaGuardTimer) clearInterval(quotaGuardTimer);
      try {
        sample();
        if (quotaExceeded) throw new Error('Downloaded file exceeds your remaining storage quota.');
        if (code !== 0) throw new Error(stderr.trim() || `wget exited with code ${code}.`);
        if (!fs.existsSync(job.tempPath)) throw new Error('wget completed but no file was produced.');
        const stat = fs.statSync(job.tempPath);
        if (!stat.isFile()) throw new Error('Downloaded output is not a regular file.');
        if (stat.size > remainingBytes) throw new Error('Downloaded file exceeds your remaining storage quota.');
        if (fs.existsSync(destinationPath)) throw new Error('A file with this name already exists.');
        fs.renameSync(job.tempPath, destinationPath);
        const used = SFTPService.calculateUserStorageBytes(job.userId);
        const user = await getRow(`SELECT storage_quota_bytes FROM users WHERE id = ?;`, [job.userId]);
        if (user) await runQuery(`UPDATE users SET used_storage_bytes = ?, storage_overage_since = CASE WHEN ? > storage_quota_bytes THEN COALESCE(storage_overage_since, CURRENT_TIMESTAMP) ELSE NULL END WHERE id = ?;`, [used, used, job.userId]);
        updateJob(job.id, { status: 'completed', progress: 100, bytes: stat.size, totalBytes: totalBytes || stat.size, speedBytesPerSec: 0, etaSeconds: 0 });
        finishDownloadMonitor(job.monitorId, { status: 'completed', httpStatus: 200 });
      } catch (err) {
        if (fs.existsSync(job.tempPath)) { try { fs.unlinkSync(job.tempPath); } catch (_) {} }
        updateJob(job.id, { status: 'failed', error: err.message, speedBytesPerSec: 0, etaSeconds: 0 });
        finishDownloadMonitor(job.monitorId, { status: 'failed', httpStatus: 500, error: err.message });
      }
      resolve();
    });
  });
}

async function getUserJobs(userId) {
  return getAll(`SELECT id, target_path, filename, status, progress, bytes, total_bytes, speed_bytes_per_sec, eta_seconds, error, created_at, updated_at FROM download_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20;`, [userId]);
}

async function removeUserJob(userId, jobId) {
  const job = await getRow(`SELECT id, status, filename FROM download_jobs WHERE id = ? AND user_id = ?;`, [jobId, userId]);
  if (!job) throw new Error('Download history item not found.');
  await runQuery(`DELETE FROM download_jobs WHERE id = ? AND user_id = ?;`, [jobId, userId]);
  // Do not cancel a running wget: this button only removes the history card.
  return job;
}

// Clears finished/failed history entries, keeping anything still queued or
// running so an in-progress download never disappears from the list.
async function clearUserJobs(userId) {
  const result = await runQuery(`DELETE FROM download_jobs WHERE user_id = ? AND status NOT IN ('queued', 'running');`, [userId]);
  return { removed: result.changes || 0 };
}

module.exports = { startDownload, getUserJobs, removeUserJob, clearUserJobs, formatSpeed };
