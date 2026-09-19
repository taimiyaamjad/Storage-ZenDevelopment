const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CACHE_ROOT = path.resolve(process.env.PREVIEW_CACHE_ROOT || '/tmp/vps-sftp-preview-cache');
if (!fs.existsSync(CACHE_ROOT)) fs.mkdirSync(CACHE_ROOT, { recursive: true });

// Avoid running an unlimited number of ffmpeg processes when several users open
// incompatible videos at the same time.
const MAX_CONCURRENT_TRANSCODES = Math.max(1, Number(process.env.PREVIEW_MAX_TRANSCODES || 2));
let activeTranscodes = 0;
const waitingQueue = [];
const inflight = new Map();

function isVideoFile(filePath) {
  return /^video\//i.test(require('mime-types').lookup(filePath) || '');
}

function execProbe(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,profile,pix_fmt,width,height,level',
      filePath
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', err => reject(new Error(`ffprobe could not start: ${err.message}`)));
    child.on('close', code => {
      if (code !== 0) return reject(new Error(stderr.trim() || `ffprobe exited with code ${code}.`));
      try {
        resolve(JSON.parse(stdout || '{}'));
      } catch (_) {
        reject(new Error('ffprobe returned invalid media information.'));
      }
    });
  });
}

function isBrowserSafeMp4Probe(probe) {
  const formatNames = String(probe?.format?.format_name || '').toLowerCase().split(',');
  const video = (probe?.streams || []).find(s => s.codec_type === 'video');
  const audioStreams = (probe?.streams || []).filter(s => s.codec_type === 'audio');
  if (!video) return false;

  // This intentionally uses a conservative browser target: MP4 + H.264
  // 8-bit 4:2:0 + AAC. This avoids Chrome/Edge hardware decoder failures with
  // HEVC, 10-bit/4:2:2 H.264, unusual profiles, and codecs such as AC3.
  const h264Ok = String(video.codec_name || '').toLowerCase() === 'h264';
  const pixFmtOk = String(video.pix_fmt || '').toLowerCase() === 'yuv420p';
  const profile = String(video.profile || '').toLowerCase();
  const profileOk = !profile || ['baseline', 'main', 'high', 'constrained baseline', 'constrained high'].includes(profile);
  const containerOk = formatNames.includes('mov') || formatNames.includes('mp4') || formatNames.includes('m4a');
  const audioOk = audioStreams.every(s => String(s.codec_name || '').toLowerCase() === 'aac');

  // Very high resolution/level combinations are a frequent trigger for the
  // Chromium "GetVideoDecoderConfigCount failed" hardware-decoder error on
  // machines with older or buggy GPU drivers. Anything above a conservative
  // 1080p ceiling is routed through transcoding instead of trusting the
  // client's hardware decoder to handle it.
  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;
  const resolutionOk = width > 0 && height > 0 && width <= 1920 && height <= 1080;
  // Odd (non-even) pixel dimensions also break some hardware decoders.
  const evenDimsOk = width % 2 === 0 && height % 2 === 0;
  const levelOk = !video.level || Number(video.level) <= 42; // AVC level <= 4.2

  return h264Ok && pixFmtOk && profileOk && containerOk && audioOk && resolutionOk && evenDimsOk && levelOk;
}

function cachePathFor(sourcePath, stat, safe = false) {
  const key = crypto.createHash('sha256')
    .update(`${sourcePath}\0${stat.size}\0${stat.mtimeMs}${safe ? '\0safe' : ''}`)
    .digest('hex');
  return path.join(CACHE_ROOT, `${key}${safe ? '.safe' : ''}.mp4`);
}

// Video filter that fits large/odd-sized sources into a browser-friendly,
// even-dimensioned box without ever upscaling a smaller video.
function scaleFilter(maxWidth, maxHeight) {
  return `scale=w=${maxWidth}:h=${maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
}

// Encoder args shared by the two transcode paths below. `safe` produces a much
// more conservative stream (Baseline profile, no B-frames, capped at 720p)
// used as a last-resort fallback when even a standard H.264 High/1080p
// re-encode still trips a client's buggy hardware video decoder (the
// "GetVideoDecoderConfigCount failed" class of Chromium/driver errors).
function encodeArgs({ safe = false } = {}) {
  return safe
    ? [
        '-vf', scaleFilter(1280, 720),
        '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1',
        '-bf', '0', '-refs', '1', '-x264-params', 'cabac=0',
        '-preset', 'veryfast', '-crf', '25', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ac', '2', '-b:a', '96k'
      ]
    : [
        '-vf', scaleFilter(1920, 1080),
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1',
        '-preset', process.env.PREVIEW_FFMPEG_PRESET || 'veryfast',
        '-crf', process.env.PREVIEW_FFMPEG_CRF || '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k'
      ];
}

function runWithTranscodeSlot(task) {
  return new Promise((resolve, reject) => {
    const execute = async () => {
      activeTranscodes += 1;
      try {
        resolve(await task());
      } catch (err) {
        reject(err);
      } finally {
        activeTranscodes -= 1;
        const next = waitingQueue.shift();
        if (next) next();
      }
    };

    if (activeTranscodes < MAX_CONCURRENT_TRANSCODES) execute();
    else waitingQueue.push(execute);
  });
}

function transcodeToBrowserMp4(sourcePath, destinationPath, { safe = false } = {}) {
  return new Promise((resolve, reject) => {
    const tempOutput = `${destinationPath}.part.mp4`;
    try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch (_) {}

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', sourcePath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      ...encodeArgs({ safe }),
      '-movflags', '+faststart',
      '-y', tempOutput
    ];

    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });

    const fail = (message) => {
      try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch (_) {}
      reject(new Error(message));
    };

    child.on('error', err => fail(`ffmpeg could not start: ${err.message}`));
    child.on('close', code => {
      if (code !== 0) return fail(stderr.trim() || `ffmpeg exited with code ${code}.`);
      try {
        if (!fs.existsSync(tempOutput)) return fail('ffmpeg finished but did not create a preview file.');
        fs.renameSync(tempOutput, destinationPath);
        resolve(destinationPath);
      } catch (err) {
        fail(`Could not store the generated video preview: ${err.message}`);
      }
    });
  });
}

/**
 * Return a browser-friendly media file.
 *
 * Compatible H.264/AAC MP4 files are streamed directly. Other video formats
 * or codecs are converted to a cached H.264/AAC MP4 first. The original user
 * file is never modified.
 */
async function getBrowserPreviewPath(sourcePath, { safe = false } = {}) {
  const stat = await fs.promises.stat(sourcePath);

  if (!safe) {
    const probe = await execProbe(sourcePath);
    if (isBrowserSafeMp4Probe(probe)) {
      return { path: sourcePath, transcoded: false, probe };
    }
  }

  const cachePath = cachePathFor(sourcePath, stat, safe);
  if (fs.existsSync(cachePath)) {
    return { path: cachePath, transcoded: true };
  }

  const existing = inflight.get(cachePath);
  if (existing) {
    await existing;
    return { path: cachePath, transcoded: true };
  }

  const work = runWithTranscodeSlot(() => transcodeToBrowserMp4(sourcePath, cachePath, { safe }));
  inflight.set(cachePath, work);
  try {
    await work;
  } finally {
    inflight.delete(cachePath);
  }

  return { path: cachePath, transcoded: true };
}



/**
 * Stream a browser-compatible MP4 while ffmpeg is transcoding.
 * This is used only as a fallback when the browser cannot decode the
 * original file. Compatible videos never enter this path and stream directly.
 * The generated fragmented MP4 is also cached for future playback.
 */
async function streamTranscodedPreview(sourcePath, res, { safe = false } = {}) {
  const stat = await fs.promises.stat(sourcePath);
  const cachePath = cachePathFor(sourcePath, stat, safe);
  if (fs.existsSync(cachePath)) {
    return { cached: true, path: cachePath };
  }

  await runWithTranscodeSlot(() => new Promise((resolve, reject) => {
    const tempOutput = `${cachePath}.stream.part.mp4`;
    try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch (_) {}

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', sourcePath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      ...(safe
        ? ['-vf', scaleFilter(1280, 720), '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.1', '-bf', '0', '-refs', '1', '-x264-params', 'cabac=0']
        : ['-vf', scaleFilter(1920, 1080), '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1']),
      '-preset', process.env.PREVIEW_FFMPEG_LIVE_PRESET || 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', process.env.PREVIEW_FFMPEG_LIVE_CRF || '27',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4',
      'pipe:1'
    ];

    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const cacheStream = fs.createWriteStream(tempOutput);
    let stderr = '';
    let finished = false;
    let clientClosed = false;

    const cleanupTemp = () => {
      try { cacheStream.destroy(); } catch (_) {}
      try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch (_) {}
    };

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Accept-Ranges', 'none');
    if (!res.headersSent) res.flushHeaders?.();

    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });

    res.on('close', () => {
      if (!finished) {
        clientClosed = true;
        try { child.kill('SIGTERM'); } catch (_) {}
      }
    });

    child.stdout.on('error', () => {});
    child.stdout.pipe(cacheStream);
    child.stdout.pipe(res, { end: true });

    const finish = (err) => {
      if (finished) return;
      finished = true;
      cacheStream.end(async () => {
        if (err || clientClosed) {
          cleanupTemp();
          if (err && !res.headersSent) {
            try { res.status(500).json({ error: err.message }); } catch (_) {}
          }
          return err ? reject(err) : resolve();
        }
        try {
          if (!fs.existsSync(tempOutput)) throw new Error('ffmpeg produced no preview data.');
          fs.renameSync(tempOutput, cachePath);
          resolve();
        } catch (e) {
          cleanupTemp();
          reject(e);
        }
      });
    };

    child.on('error', e => finish(new Error(`ffmpeg could not start: ${e.message}`)));
    child.on('close', code => {
      if (code !== 0 && !clientClosed) {
        finish(new Error(stderr.trim() || `ffmpeg exited with code ${code}.`));
      } else {
        finish(null);
      }
    });
  }));

  return { cached: false, path: cachePath };
}

module.exports = {
  isVideoFile,
  getBrowserPreviewPath,
  isBrowserSafeMp4Probe,
  streamTranscodedPreview
};
