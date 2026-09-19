const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

/**
 * Stream a local file in a browser-friendly way.
 * Express' sendFile/send module handles HTTP Range + HEAD requests correctly,
 * which is important for MP4/MOV/WebM seeking and progressive playback.
 */
function streamInlineFile(req, res, absolutePath, { cacheControl = 'private, no-store' } = {}) {
  const stat = fs.statSync(absolutePath);
  const mimeType = mime.lookup(absolutePath) || 'application/octet-stream';

  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Prevent reverse proxies such as nginx from buffering a large media stream.
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Last-Modified', stat.mtime.toUTCString());

  // sendFile implements byte ranges, correct Content-Length/Content-Range,
  // conditional requests, and HEAD without buffering the whole file in memory.
  return res.sendFile(path.resolve(absolutePath), {
    acceptRanges: true,
    cacheControl: false,
    lastModified: false,
    dotfiles: 'deny'
  }, (err) => {
    if (!err || res.headersSent) return;
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found.' });
    if (err.code === 'ECONNABORTED') return;
    console.error('Preview stream error:', err);
    try { res.status(err.statusCode || 500).json({ error: 'Unable to stream preview.' }); } catch (_) {}
  });
}

module.exports = { streamInlineFile };
