/**
 * VPS SFTP File Management Web Application - Full SPA Core Logic
 */

const AppState = {
  token: localStorage.getItem('vps_token') || null,
  user: JSON.parse(localStorage.getItem('vps_user') || 'null'),
  currentPath: '/',
  files: [],
  selectedPaths: [],
  viewMode: 'grid', // 'grid' or 'list'
  currentTab: 'files', // 'dashboard', 'files', 'shares', 'profile', 'admin'
  searchQuery: '',
  isDarkMode: true,
  adminTab: 'overview', // 'overview', 'users', 'storage', 'download-monitor', 'ip-history', 'smtp', 'settings', 'details', 'audit-logs', 'console'
  adminUsers: [],
  adminStats: null,
  activeShareLinks: [],
  publicShareData: null,
  fileRefreshLockedUntil: 0,
  fileRefreshCountdownTimer: null,
  downloadJobsTimer: null,
  previewObjectUrl: null,
  quotaRequestId: 0,
  displayedQuotaPercent: 0
};

// Global Toast Notification Helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container') || createToastContainer();
  const toast = document.createElement('div');
  const bgClass = type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-emerald-600' : 'bg-blue-600';
  
  toast.className = `${bgClass} text-white px-4 py-3 rounded-lg shadow-xl text-sm font-medium flex items-center gap-2 transform transition-all duration-300 translate-y-2 opacity-0 z-50`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  }, 10);

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function createToastContainer() {
  const c = document.createElement('div');
  c.id = 'toast-container';
  c.className = 'fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-sm w-full';
  document.body.appendChild(c);
  return c;
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Public application branding (title + favicon)
async function loadPublicBranding() {
  try {
    const res = await fetch('/api/public/settings', { cache: 'no-store' });
    const settings = await res.json();
    if (!res.ok) throw new Error(settings.error || 'Failed to load app settings');

    const title = settings.websiteTitle || settings.appName || 'VPS SFTP Cloud Manager';
    document.title = title;

    if (settings.websiteIconUrl) {
      let link = document.querySelector('link[data-site-favicon]');
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        link.dataset.siteFavicon = 'true';
        document.head.appendChild(link);
      }
      link.href = `${settings.websiteIconUrl}?v=${Date.now()}`;
    }
  } catch (_) {
    // Keep static defaults if public settings are unavailable.
  }
}

// API Fetch Helper
async function apiRequest(endpoint, options = {}) {
  const headers = options.headers || {};
  if (AppState.token) {
    headers['Authorization'] = `Bearer ${AppState.token}`;
  }
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }

  options.headers = headers;

  try {
    const res = await fetch(`/api${endpoint}`, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && AppState.token) {
        logoutUser();
        showToast('Session expired. Please log in again.', 'error');
      }
      throw new Error(data.error || 'API Request failed');
    }
    return data;
  } catch (err) {
    throw err;
  }
}

function logoutUser() {
  AppState.token = null;
  AppState.user = null;
  localStorage.removeItem('vps_token');
  localStorage.removeItem('vps_user');
  renderApp();
}

// Router & App Render Engine
function renderApp() {
  const root = document.getElementById('app');
  if (!root) return;

  // Check Hash for Public Share or Password Reset links
  const hash = window.location.hash;
  if (hash.startsWith('#public-share')) {
    renderPublicShareView(root);
    return;
  }
  if (hash.startsWith('#reset-password')) {
    renderResetPasswordView(root);
    return;
  }
  if (hash.startsWith('#verify-email?')) {
    renderVerifyEmailView(root);
    return;
  }
  if (hash.startsWith('#verify-email-change')) {
    renderVerifyEmailChangeView(root);
    return;
  }

  if (!AppState.token || !AppState.user) {
    renderAuthView(root);
  } else {
    renderDashboardLayout(root);
  }

  if (window.lucide) {
    lucide.createIcons();
  }
}

async function renderPublicShareView(root) {
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const token = params.get('token');
  root.innerHTML = `
    <div class="min-h-screen flex items-center justify-center p-4 bg-slate-950">
      <div class="w-full max-w-xl glass-card p-7 rounded-2xl shadow-2xl border border-slate-800">
        <div class="flex items-center gap-3 mb-6">
          <div class="w-11 h-11 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400"><i data-lucide="share-2" class="w-5 h-5"></i></div>
          <div><h1 class="text-lg font-bold text-white">Shared File</h1><p class="text-xs text-slate-500">Secure public share link</p></div>
        </div>
        <div id="public-share-content" class="text-sm text-slate-300">Loading shared content...</div>
      </div>
    </div>`;
  if (window.lucide) lucide.createIcons();
  if (!token) {
    document.getElementById('public-share-content').innerHTML = '<div class="text-red-300">Share token is missing.</div>';
    return;
  }
  try {
    const res = await fetch(`/api/share/public/${encodeURIComponent(token)}?info=1`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Share link is unavailable.');
    const canPreview = !data.isDirectory && (String(data.mimeType || '').startsWith('image/') || String(data.mimeType || '').startsWith('video/'));
    document.getElementById('public-share-content').innerHTML = `
      <div class="rounded-xl bg-slate-900/70 border border-slate-800 p-4 space-y-3">
        <div><div class="text-xs text-slate-500">Name</div><div class="text-base font-semibold text-white break-all">${escapeHtml(data.fileName)}</div></div>
        <div class="grid grid-cols-2 gap-3 text-xs"><div><span class="text-slate-500">Type:</span> ${data.isDirectory ? 'Folder' : escapeHtml(data.mimeType || 'File')}</div><div><span class="text-slate-500">Size:</span> ${data.isDirectory ? 'Folder' : formatBytes(data.sizeBytes)}</div></div>
        ${data.expiresAt ? `<div class="text-xs text-amber-300">Expires: ${new Date(data.expiresAt).toLocaleString()}</div>` : '<div class="text-xs text-emerald-300">No expiration</div>'}
      </div>
      <div class="flex flex-wrap gap-2 mt-4">
        ${canPreview ? `<button onclick="openPublicSharePreview('${encodeURIComponent(token)}','${escapeHtml(data.fileName)}','${escapeHtml(data.mimeType || '')}')" class="inline-flex items-center gap-2 bg-sky-600 hover:bg-sky-500 text-white font-bold px-4 py-2.5 rounded-lg text-sm"><i data-lucide="${String(data.mimeType || '').startsWith('video/') ? 'play-circle' : 'image'}" class="w-4 h-4"></i> Preview</button>` : ''}
        <a href="/api/share/public/${encodeURIComponent(token)}" class="inline-flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-4 py-2.5 rounded-lg text-sm"><i data-lucide="download" class="w-4 h-4"></i> Download ${data.isDirectory ? 'Folder' : 'File'}</a>
      </div>`;
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    document.getElementById('public-share-content').innerHTML = `<div class="text-red-300">${escapeHtml(err.message)}</div>`;
  }
}

function formatMediaTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function createVideoPlayerMarkup(videoId, sourceUrl, title) {
  return `
    <div class="w-full max-w-5xl mx-auto rounded-2xl overflow-hidden border border-slate-800 bg-black shadow-2xl" data-media-player="1" data-title="${escapeHtml(title)}">
      <div class="relative bg-black min-h-[240px] flex items-center justify-center">
        <video id="${videoId}" src="${sourceUrl}" class="block w-full max-h-[72vh] object-contain bg-black" playsinline preload="auto"></video>
        <div id="${videoId}-loading" class="absolute inset-0 flex items-center justify-center bg-black/35 pointer-events-none">
          <div class="flex items-center gap-2 text-xs text-slate-200 bg-slate-950/70 px-3 py-2 rounded-full border border-slate-800">
            <i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i><span>Loading video…</span>
          </div>
        </div>
      </div>
      <div class="px-3 py-3 bg-slate-950 border-t border-slate-800 space-y-2">
        <input id="${videoId}-seek" type="range" min="0" max="1000" value="0" class="w-full accent-cyan-500 cursor-pointer" aria-label="Seek video">
        <div class="flex items-center gap-2 text-xs text-slate-300">
          <button id="${videoId}-play" type="button" class="w-9 h-9 rounded-lg bg-slate-800 hover:bg-slate-700 flex items-center justify-center" title="Play / Pause">
            <i data-lucide="play" class="w-4 h-4"></i>
          </button>
          <span id="${videoId}-time" class="tabular-nums min-w-[86px]">0:00 / 0:00</span>
          <button id="${videoId}-mute" type="button" class="w-9 h-9 rounded-lg hover:bg-slate-800 flex items-center justify-center" title="Mute">
            <i data-lucide="volume-2" class="w-4 h-4"></i>
          </button>
          <input id="${videoId}-volume" type="range" min="0" max="1" step="0.01" value="1" class="w-20 accent-cyan-500" aria-label="Volume">
          <div class="flex-1"></div>
          <select id="${videoId}-speed" class="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white" title="Playback speed">
            <option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option>
          </select>
          <button id="${videoId}-pip" type="button" class="w-9 h-9 rounded-lg hover:bg-slate-800 flex items-center justify-center" title="Picture in Picture">
            <i data-lucide="picture-in-picture-2" class="w-4 h-4"></i>
          </button>
          <button id="${videoId}-fullscreen" type="button" class="w-9 h-9 rounded-lg hover:bg-slate-800 flex items-center justify-center" title="Fullscreen">
            <i data-lucide="maximize" class="w-4 h-4"></i>
          </button>
        </div>
      </div>
    </div>`;
}

function setupVideoPlayer(videoId, directUrl, fallbackUrl, safeFallbackUrl, downloadUrl) {
  const video = document.getElementById(videoId);
  if (!video) return;
  const player = video.closest('[data-media-player]');
  const loading = document.getElementById(`${videoId}-loading`);
  const seek = document.getElementById(`${videoId}-seek`);
  const time = document.getElementById(`${videoId}-time`);
  const play = document.getElementById(`${videoId}-play`);
  const mute = document.getElementById(`${videoId}-mute`);
  const volume = document.getElementById(`${videoId}-volume`);
  const speed = document.getElementById(`${videoId}-speed`);
  const pip = document.getElementById(`${videoId}-pip`);
  const fullscreen = document.getElementById(`${videoId}-fullscreen`);

  // Playback is attempted in tiers: the original file streams instantly if the
  // browser can decode it; if the browser's decoder rejects it (including
  // hardware-decoder failures such as Chromium's "GetVideoDecoderConfigCount
  // failed"), we retry against a server-transcoded H.264 High/1080p stream;
  // if that ALSO fails (a stubborn hardware/driver issue), we retry once more
  // against a maximally conservative Baseline/720p stream before giving up.
  let tier = 0;
  const tiers = [directUrl, fallbackUrl, safeFallbackUrl].filter(Boolean);

  const icon = (button, name) => {
    if (!button) return;
    button.innerHTML = `<i data-lucide="${name}" class="w-4 h-4"></i>`;
    if (window.lucide) lucide.createIcons();
  };
  const setLoading = (message, show = true) => {
    if (!loading) return;
    loading.classList.toggle('hidden', !show);
    const span = loading.querySelector('span');
    if (span) span.textContent = message;
  };
  const updateTime = () => {
    if (!time) return;
    time.textContent = `${formatMediaTime(video.currentTime)} / ${formatMediaTime(video.duration)}`;
    if (seek && Number.isFinite(video.duration) && video.duration > 0) {
      seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
    }
  };

  play?.addEventListener('click', async () => {
    try {
      if (video.paused) await video.play();
      else video.pause();
    } catch (_) {}
  });
  mute?.addEventListener('click', () => {
    video.muted = !video.muted;
    icon(mute, video.muted || video.volume === 0 ? 'volume-x' : 'volume-2');
  });
  volume?.addEventListener('input', () => {
    video.volume = Number(volume.value);
    video.muted = video.volume === 0;
    icon(mute, video.muted ? 'volume-x' : 'volume-2');
  });
  speed?.addEventListener('change', () => { video.playbackRate = Number(speed.value); });
  seek?.addEventListener('input', () => {
    if (Number.isFinite(video.duration) && video.duration > 0) {
      video.currentTime = (Number(seek.value) / 1000) * video.duration;
    }
  });
  pip?.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (video.requestPictureInPicture) await video.requestPictureInPicture();
    } catch (_) {}
  });
  fullscreen?.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (player?.requestFullscreen) await player.requestFullscreen();
    } catch (_) {}
  });
  video.addEventListener('play', () => icon(play, 'pause'));
  video.addEventListener('pause', () => icon(play, 'play'));
  video.addEventListener('timeupdate', updateTime);
  video.addEventListener('durationchange', updateTime);
  video.addEventListener('loadedmetadata', () => { updateTime(); setLoading('', false); });
  video.addEventListener('canplay', () => setLoading('', false));
  video.addEventListener('waiting', () => setLoading('Buffering…', true));
  video.addEventListener('playing', () => setLoading('', false));

  const loadTier = (index, resume) => {
    tier = index;
    video.removeAttribute('src');
    video.src = tiers[tier];
    video.preload = 'auto';
    video.load();
    if (resume) {
      // A tier switch happens after the person already pressed play, so
      // resuming automatically continues their original request instead of
      // silently sitting at 0:00 until they click play again.
      video.addEventListener('canplay', () => { video.play().catch(() => {}); }, { once: true });
    }
  };

  const giveUp = () => {
    const code = video.error?.code || 0;
    const detail = video.error?.message || 'Unsupported media codec or a corrupted video stream.';
    setLoading('', false);
    const body = video.closest('[data-media-player]')?.parentElement;
    if (body) {
      const notice = document.createElement('div');
      notice.className = 'mt-3 text-xs text-amber-300 bg-amber-950/40 border border-amber-900/50 rounded-xl px-3 py-3 flex flex-col gap-2';
      notice.innerHTML = `
        <div>This video's format isn't supported by your browser/GPU on this device, even after converting it. This is usually a browser hardware-acceleration issue, not a problem with the file.</div>
        <div class="flex flex-wrap gap-2">
          ${downloadUrl ? `<a href="${downloadUrl}" class="inline-flex items-center gap-1.5 bg-cyan-600 hover:bg-cyan-500 text-white font-semibold px-3 py-1.5 rounded-lg"><i data-lucide="download" class="w-3.5 h-3.5"></i> Download instead</a>` : ''}
        </div>`;
      body.appendChild(notice);
      if (window.lucide) lucide.createIcons();
    }
    showToast(`Video preview failed (${code}): ${detail}`, 'error');
  };

  video.addEventListener('error', () => {
    if (tier < tiers.length - 1) {
      setLoading(tier === 0 ? 'Preparing a browser-compatible preview…' : 'Trying a more compatible format…', true);
      loadTier(tier + 1, true);
      return;
    }
    giveUp();
  });

  setLoading('Opening video…', true);
  loadTier(0, false);
}

function openPublicSharePreview(token, fileName, mimeType) {
  closeFilePreview();
  const drawer = document.createElement('div');
  drawer.id = 'file-preview-drawer';
  drawer.className = 'fixed right-0 top-0 h-full bg-slate-950 border-l border-slate-800 shadow-2xl z-[80] flex flex-col';
  const previewUrl = `/api/share/public/${token}?preview=1`;
  const isVideo = String(mimeType || '').startsWith('video/');
  drawer.innerHTML = `
    <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800 bg-slate-950/95 shrink-0">
      <div class="min-w-0">
        <div class="text-xs text-slate-500">Shared Preview</div>
        <div class="text-sm font-semibold text-white truncate" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
      </div>
      <button onclick="closeFilePreview()" class="p-2 rounded-lg bg-slate-800 hover:bg-red-600/80 text-slate-300 hover:text-white shrink-0" title="Close preview">
        <i data-lucide="x" class="w-5 h-5"></i>
      </button>
    </div>
    <div class="flex-1 overflow-auto p-4 flex items-center justify-center bg-black/20">
      ${isVideo
        ? createVideoPlayerMarkup('public-share-preview-video', previewUrl, fileName)
        : `<img src="${previewUrl}" alt="${escapeHtml(fileName)}" class="preview-media mx-auto" />`}
    </div>
    <div class="px-4 py-3 border-t border-slate-800 text-[11px] text-slate-500 shrink-0">Public shared preview</div>
  `;
  document.body.appendChild(drawer);
  if (window.lucide) lucide.createIcons();
  if (isVideo) {
    setupVideoPlayer(
      'public-share-preview-video',
      previewUrl,
      `${previewUrl}&transcoded=1`,
      `${previewUrl}&transcoded=1&safe=1`,
      `/api/share/public/${token}`
    );
  }
}

async function renderVerifyEmailView(root) {
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const token = params.get('token');
  root.innerHTML = `
    <div class="min-h-screen flex items-center justify-center p-4 bg-slate-950">
      <div class="w-full max-w-md glass-card p-8 rounded-2xl shadow-2xl border border-slate-800 text-center">
        <div id="verify-email-status" class="text-sm text-slate-300">Verifying your email...</div>
      </div>
    </div>`;
  if (!token) {
    document.getElementById('verify-email-status').innerHTML = '<div class="text-red-300">Verification token is missing.</div>';
    return;
  }
  try {
    const res = await fetch('/api/auth/email/verify-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Verification failed.');
    if (AppState.user) {
      AppState.user.emailVerified = true;
      localStorage.setItem('vps_user', JSON.stringify(AppState.user));
    }
    document.getElementById('verify-email-status').innerHTML = `
      <div class="text-emerald-300 font-semibold">${escapeHtml(data.message)}</div>
      <button onclick="window.location.hash=''; renderApp()" class="mt-5 bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs px-4 py-2.5 rounded-lg">Continue</button>`;
  } catch (err) {
    document.getElementById('verify-email-status').innerHTML = `
      <div class="text-red-300 font-semibold">${escapeHtml(err.message)}</div>
      <button onclick="window.location.hash=''; renderApp()" class="mt-5 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs px-4 py-2.5 rounded-lg">Back</button>`;
  }
}

async function renderVerifyEmailChangeView(root) {
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const token = params.get('token');
  root.innerHTML = `
    <div class="min-h-screen flex items-center justify-center p-4 bg-slate-950">
      <div class="w-full max-w-md glass-card p-8 rounded-2xl shadow-2xl border border-slate-800 text-center">
        <div id="verify-change-status" class="text-sm text-slate-300">Verifying your new email...</div>
      </div>
    </div>`;
  if (!token) {
    document.getElementById('verify-change-status').innerHTML = '<div class="text-red-300">Verification token is missing.</div>';
    return;
  }
  try {
    const res = await fetch('/api/auth/email/verify-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Verification failed.');
    document.getElementById('verify-change-status').innerHTML = `
      <div class="text-emerald-300 font-semibold">${escapeHtml(data.message)}</div>
      <button onclick="window.location.hash=''; renderApp()" class="mt-5 bg-sky-600 hover:bg-sky-500 text-white font-bold text-xs px-4 py-2.5 rounded-lg">Continue</button>`;
  } catch (err) {
    document.getElementById('verify-change-status').innerHTML = `
      <div class="text-red-300 font-semibold">${escapeHtml(err.message)}</div>
      <button onclick="window.location.hash=''; renderApp()" class="mt-5 bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs px-4 py-2.5 rounded-lg">Back</button>`;
  }
}

// ==========================================
// 1. AUTHENTICATION VIEWS (Login / Register / Reset)
// ==========================================
function renderAuthView(container) {
  container.innerHTML = `
    <div class="min-h-screen flex items-center justify-center p-4 bg-slate-950">
      <div class="w-full max-w-md glass-card p-8 rounded-2xl shadow-2xl border border-slate-800">
        
        <div class="text-center mb-8">
          <div class="inline-flex p-3 rounded-2xl bg-sky-500/10 text-sky-400 mb-3 border border-sky-500/20">
            <i data-lucide="server" class="w-8 h-8"></i>
          </div>
          <h1 class="text-2xl font-bold text-white tracking-tight">VPS SFTP Cloud</h1>
          <p class="text-slate-400 text-sm mt-1">Production VPS File Manager & Admin Portal</p>
        </div>

        <div class="flex border-b border-slate-800 mb-6">
          <button id="tab-login-btn" onclick="switchAuthTab('login')" class="flex-1 py-2 text-sm font-semibold text-sky-400 border-b-2 border-sky-400">Login</button>
          <button id="tab-register-btn" onclick="switchAuthTab('register')" class="flex-1 py-2 text-sm font-semibold text-slate-400 hover:text-white">Register</button>
        </div>

        <!-- Login Form -->
        <form id="auth-login-form" onsubmit="handleLoginSubmit(event)">
          <div class="space-y-4">
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Username or Email</label>
              <input type="text" id="login-input-user" required class="w-full bg-slate-900/80 border border-slate-700/80 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500" placeholder="example or user@domain.com">
            </div>

            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Password</label>
              <input type="password" id="login-input-pass" required class="w-full bg-slate-900/80 border border-slate-700/80 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-sky-500 focus:ring-1 focus:ring-sky-500" placeholder="••••••••">
            </div>

            <div class="flex justify-end">
              <button type="button" onclick="openForgotPasswordModal()" class="text-xs text-sky-400 hover:underline">Forgot password?</button>
            </div>

            <button type="submit" class="w-full bg-sky-600 hover:bg-sky-500 text-white font-medium py-2.5 rounded-lg text-sm shadow-lg shadow-sky-600/30 transition-all flex items-center justify-center gap-2">
              <i data-lucide="log-in" class="w-4 h-4"></i> Sign In
            </button>
          </div>
        </form>

        <!-- Register Form -->
        <form id="auth-register-form" onsubmit="handleRegisterSubmit(event)" class="hidden">
          <div class="space-y-3">
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Full Name</label>
              <input type="text" id="reg-name" required class="w-full bg-slate-900/80 border border-slate-700/80 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500" placeholder="example">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Username</label>
              <input type="text" id="reg-username" required class="w-full bg-slate-900/80 border border-slate-700/80 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500" placeholder="example123">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Email Address</label>
              <input type="email" id="reg-email" required class="w-full bg-slate-900/80 border border-slate-700/80 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500" placeholder="example@gmail.com">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Password</label>
              <input type="password" id="reg-password" required minlength="6" class="w-full bg-slate-900/80 border border-slate-700/80 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500" placeholder="••••••••">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Confirm Password</label>
              <input type="password" id="reg-confirm" required class="w-full bg-slate-900/80 border border-slate-700/80 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500" placeholder="••••••••">
            </div>

            <button type="submit" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2.5 rounded-lg text-sm shadow-lg shadow-emerald-600/30 transition-all flex items-center justify-center gap-2 mt-2">
              <i data-lucide="user-plus" class="w-4 h-4"></i> Create Account
            </button>
          </div>
        </form>

      </div>
    </div>
  `;
}

function switchAuthTab(tab) {
  const loginForm = document.getElementById('auth-login-form');
  const regForm = document.getElementById('auth-register-form');
  const loginBtn = document.getElementById('tab-login-btn');
  const regBtn = document.getElementById('tab-register-btn');

  if (tab === 'login') {
    loginForm.classList.remove('hidden');
    regForm.classList.add('hidden');
    loginBtn.className = 'flex-1 py-2 text-sm font-semibold text-sky-400 border-b-2 border-sky-400';
    regBtn.className = 'flex-1 py-2 text-sm font-semibold text-slate-400 hover:text-white';
  } else {
    loginForm.classList.add('hidden');
    regForm.classList.remove('hidden');
    regBtn.className = 'flex-1 py-2 text-sm font-semibold text-sky-400 border-b-2 border-sky-400';
    loginBtn.className = 'flex-1 py-2 text-sm font-semibold text-slate-400 hover:text-white';
  }
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const usernameOrEmail = document.getElementById('login-input-user').value.trim();
  const password = document.getElementById('login-input-pass').value;

  try {
    const data = await apiRequest('/auth/login', {
      method: 'POST',
      body: { usernameOrEmail, password }
    });

    AppState.token = data.token;
    AppState.user = data.user;
    localStorage.setItem('vps_token', data.token);
    localStorage.setItem('vps_user', JSON.stringify(data.user));

    showToast('Logged in successfully!', 'success');
    renderApp();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleRegisterSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('reg-name').value.trim();
  const username = document.getElementById('reg-username').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirmPassword = document.getElementById('reg-confirm').value;

  try {
    const data = await apiRequest('/auth/register', {
      method: 'POST',
      body: { name, username, email, password, confirmPassword }
    });

    showToast(data.message, 'success');
    switchAuthTab('login');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// 2. DASHBOARD & MAIN NAVIGATION LAYOUT
// ==========================================
function renderDashboardLayout(container) {
  const isDark = AppState.isDarkMode;
  const bgMain = isDark ? 'bg-slate-900 text-slate-100' : 'bg-slate-100 text-slate-900';

  container.innerHTML = `
    <div class="min-h-screen flex flex-col md:flex-row ${bgMain}">
      <!-- Sidebar -->
      <aside id="sidebar" class="w-full md:w-64 bg-slate-950 border-r border-slate-800 flex flex-col justify-between p-4 flex-shrink-0">
        <div>
          <!-- Brand Logo -->
          <div class="brand-block flex items-center gap-3 px-2 py-3 mb-6">
            <div class="p-2 bg-sky-500/20 text-sky-400 rounded-xl border border-sky-500/30">
              <i data-lucide="hard-drive" class="w-6 h-6"></i>
            </div>
            <div>
              <h2 class="font-bold text-white leading-none">ZenStorage</h2>
              <span class="text-xs text-slate-400">SFTP Cloud Storage</span>
            </div>
          </div>

          <!-- Nav Items -->
          <nav class="space-y-1">
            <button onclick="navigateTab('dashboard')" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${AppState.currentTab === 'dashboard' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-white'}">
              <i data-lucide="layout-dashboard" class="w-4 h-4"></i> Dashboard
            </button>
            <button onclick="navigateTab('files')" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${AppState.currentTab === 'files' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-white'}">
              <i data-lucide="folder" class="w-4 h-4"></i> File Manager
            </button>
            <button onclick="navigateTab('shares')" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${AppState.currentTab === 'shares' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-white'}">
              <i data-lucide="share-2" class="w-4 h-4"></i> Share Links
            </button>
            <button onclick="navigateTab('profile')" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${AppState.currentTab === 'profile' ? 'bg-sky-600 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-white'}">
              <i data-lucide="user" class="w-4 h-4"></i> Profile & IP Info
            </button>

            ${AppState.user && AppState.user.role === 'admin' ? `
              <div class="pt-4 mt-4 border-t border-slate-800">
                <span class="px-3 text-[10px] uppercase font-bold text-sky-400 tracking-wider">Admin Portal</span>
                <button onclick="navigateTab('admin')" class="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all mt-1 ${AppState.currentTab === 'admin' ? 'bg-amber-600 text-white' : 'text-amber-400 hover:bg-slate-900'}">
                  <i data-lucide="shield-alert" class="w-4 h-4"></i> System Admin
                </button>
              </div>
            ` : ''}
          </nav>
        </div>

        <!-- Storage Quota Widget -->
        <div class="desktop-quota mt-8 pt-4 border-t border-slate-800 space-y-3">
          <div id="sidebar-quota-widget" class="glass-card p-3 rounded-xl border border-slate-800">
            <div class="flex justify-between text-xs text-slate-400 mb-1">
              <span>Storage Used</span>
              <span id="quota-percent-text">0%</span>
            </div>
            <div class="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
              <div id="quota-bar" class="bg-sky-500 h-full rounded-full transition-all" style="width: 0%"></div>
            </div>
            <div class="text-[11px] text-slate-400 mt-2 text-center" id="quota-detail-text">
              Loading...
            </div>
          </div>

          <div id="mobile-account" class="flex items-center justify-between px-2 pt-2">
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-full bg-sky-500/20 text-sky-400 flex items-center justify-center text-xs font-bold uppercase">
                ${AppState.user.username.substring(0, 2)}
              </div>
              <div class="text-xs">
                <div class="font-bold text-white truncate max-w-[100px]">${escapeHtml(AppState.user.name)}</div>
                <div class="text-slate-400 capitalize">${AppState.user.role}</div>
              </div>
            </div>

            <button onclick="logoutUser()" title="Logout" class="p-2 text-slate-400 hover:text-red-400 rounded-lg hover:bg-slate-900 transition-all">
              <i data-lucide="log-out" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
      </aside>

      <!-- Main Content Container -->
      <main class="flex-1 flex flex-col min-w-0 overflow-hidden">
        <!-- Top Nav Bar -->
        <header id="main-header" class="bg-slate-950/80 border-b border-slate-800 px-4 sm:px-6 py-4 backdrop-blur-md space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-3 min-w-0">
              <h1 class="text-lg font-bold text-white capitalize flex items-center gap-2 truncate">
                ${AppState.currentTab === 'files' ? 'File Manager' : AppState.currentTab}
              </h1>
            </div>

            <div class="flex items-center gap-3 shrink-0">
              <button onclick="toggleDarkMode()" class="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-all">
                <i data-lucide="${AppState.isDarkMode ? 'sun' : 'moon'}" class="w-5 h-5"></i>
              </button>
            </div>
          </div>
          <div id="email-verification-banner"></div>
        </header>

        <!-- Main Body Tab Views -->
        <div id="tab-content-area" class="flex-1 overflow-y-auto p-6 custom-scrollbar">
          <!-- Rendered dynamically -->
        </div>
      </main>
    </div>
  `;

  updateQuotaWidget();
  renderEmailVerificationBanner();
  renderTabContent();
}

function navigateTab(tabName) {
  AppState.currentTab = tabName;
  renderApp();
}

function toggleDarkMode() {
  AppState.isDarkMode = !AppState.isDarkMode;
  document.documentElement.classList.toggle('dark', AppState.isDarkMode);
  renderApp();
}

function renderStorageOveruseBanner(user) {
  const header = document.getElementById('main-header');
  if (!header) return;
  let el = document.getElementById('storage-overuse-banner');
  const used = Number(user?.usedStorageBytes || 0);
  const quota = Number(user?.storage_quota_bytes || 0);
  const over = used > quota;
  if (!over) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'storage-overuse-banner'; header.appendChild(el); }
  el.innerHTML = `<div class="rounded-xl border border-red-500/40 bg-red-500/10 px-3 sm:px-4 py-3 flex items-start gap-3">
    <div class="mt-0.5 text-red-400 shrink-0"><i data-lucide="triangle-alert" class="w-5 h-5"></i></div>
    <div><div class="text-sm font-semibold text-red-200">Your stored files have crossed the allocated storage limit.</div>
    <div class="text-xs text-red-100/80 mt-0.5">You are using ${escapeHtml(formatBytes(used))} of ${escapeHtml(formatBytes(quota))}. Please free up the extra storage. Continued overuse may result in account deletion after the 3-day grace period.</div></div>
  </div>`;
  if (window.lucide) lucide.createIcons();
}

function renderEmailVerificationBanner() {
  const el = document.getElementById('email-verification-banner');
  if (!el) return;
  if (!AppState.user || AppState.user.emailVerified) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 sm:px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
      <div class="flex items-start gap-3 min-w-0">
        <div class="mt-0.5 text-amber-400 shrink-0"><i data-lucide="triangle-alert" class="w-5 h-5"></i></div>
        <div class="min-w-0"><div class="text-sm font-semibold text-amber-200">Please verify your email address</div><div class="text-xs text-amber-100/70 mt-0.5 break-words">${escapeHtml(AppState.user.email)} · Verify your email before using storage.</div></div>
      </div>
      <div class="flex flex-wrap gap-2 shrink-0">
        <button onclick="resendVerificationEmail()" id="resend-verify-header" class="bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold text-xs px-3 py-2 rounded-lg">Resend Verify Email</button>
      </div>
    </div>`;
  if (window.lucide) lucide.createIcons();
}

async function resendVerificationEmail() {
  const btn = document.getElementById('resend-verify-header');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  try {
    const data = await apiRequest('/auth/email/resend-verification', { method: 'POST' });
    showToast(data.message, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Resend Verify Email'; }
  }
}

async function updateQuotaWidget() {
  const requestId = ++AppState.quotaRequestId;
  try {
    const profile = await apiRequest('/auth/profile');
    // Ignore an older response that arrived after a newer request.
    if (requestId !== AppState.quotaRequestId) return;
    AppState.user.usedStorageBytes = profile.user.usedStorageBytes;
    AppState.user.storage_quota_bytes = profile.user.storage_quota_bytes;
    AppState.user.emailVerified = !!profile.user.emailVerified;
    localStorage.setItem('vps_user', JSON.stringify(AppState.user));
    renderEmailVerificationBanner();
    renderStorageOveruseBanner(profile.user);

    const used = Math.max(0, Number(profile.user.usedStorageBytes) || 0);
    const total = Math.max(1, Number(profile.user.storage_quota_bytes) || 10737418240);
    const percent = Math.min(100, Math.round((used / total) * 100));

    const qBar = document.getElementById('quota-bar');
    const qPercentText = document.getElementById('quota-percent-text');
    const qDetailText = document.getElementById('quota-detail-text');

    if (qBar) qBar.style.width = `${percent}%`;
    if (qPercentText) qPercentText.innerText = `${percent}%`;
    if (qDetailText) qDetailText.innerText = `${formatBytes(used)} / ${formatBytes(total)}`;
    AppState.displayedQuotaPercent = percent;
  } catch (e) {}
}

function renderTabContent() {
  const area = document.getElementById('tab-content-area');
  if (!area) return;

  if (AppState.currentTab === 'dashboard') {
    renderDashboardTab(area);
  } else if (AppState.currentTab === 'files') {
    renderFileManagerTab(area);
  } else if (AppState.currentTab === 'shares') {
    renderShareLinksTab(area);
  } else if (AppState.currentTab === 'profile') {
    renderProfileTab(area);
  } else if (AppState.currentTab === 'admin') {
    renderAdminPortalTab(area);
  }
}

// ==========================================
// 3. FILE MANAGER COMPONENT (Upload, Operations, Compression)
// ==========================================
async function renderFileManagerTab(container) {
  container.innerHTML = `
    <div class="space-y-4">
      <!-- File Action Bar -->
      <div class="flex flex-wrap items-center justify-between gap-3 glass-card p-4 rounded-2xl border border-slate-800">
        <div class="flex flex-wrap items-center gap-2">
          <!-- Upload Button -->
          <label class="bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold px-4 py-2.5 rounded-xl cursor-pointer flex items-center gap-2 shadow-lg shadow-sky-600/20 transition-all">
            <i data-lucide="upload-cloud" class="w-4 h-4"></i> Upload Files
            <input type="file" id="file-upload-input" multiple onchange="handleFileUpload(event)" class="hidden">
          </label>

          <!-- Create Folder -->
          <button onclick="openCreateFolderModal()" class="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-3.5 py-2.5 rounded-xl flex items-center gap-2 transition-all">
            <i data-lucide="folder-plus" class="w-4 h-4"></i> New Folder
          </button>

          <!-- Refresh -->
          <button id="file-refresh-button" onclick="refreshFileManager()" class="bg-slate-800 hover:bg-slate-700 text-slate-200 p-2.5 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed" title="Refresh">
            <i data-lucide="refresh-cw" class="w-4 h-4"></i>
          </button>
        </div>

        <!-- Bulk Action Buttons (Visible when items selected) -->
        <div id="bulk-actions" class="hidden flex items-center gap-2">
          <button onclick="handleBulkDelete()" class="bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5 transition-all">
            <i data-lucide="trash-2" class="w-4 h-4"></i> Delete Selected (<span id="selected-count">0</span>)
          </button>
          <button onclick="openCompressModal()" class="bg-purple-600/20 hover:bg-purple-600 text-purple-400 hover:text-white text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5 transition-all">
            <i data-lucide="archive" class="w-4 h-4"></i> Compress
          </button>
          <button onclick="openMoveSelectedPrompt()" class="bg-cyan-600/20 hover:bg-cyan-600 text-cyan-400 hover:text-white text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5 transition-all">
            <i data-lucide="folder-input" class="w-4 h-4"></i> Move
          </button>
        </div>

        <!-- Search & View Toggle -->
        <div class="flex items-center gap-2">
          <div class="relative">
            <i data-lucide="search" class="w-4 h-4 absolute left-3 top-2.5 text-slate-400"></i>
            <input type="text" id="file-search-input" oninput="handleFileSearch(event)" placeholder="Search files..." class="bg-slate-900 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs text-white focus:outline-none focus:border-sky-500 w-48">
          </div>

          <div class="flex bg-slate-900 p-1 rounded-xl border border-slate-800">
            <button onclick="setFileViewMode('grid')" class="p-1.5 rounded-lg ${AppState.viewMode === 'grid' ? 'bg-sky-600 text-white' : 'text-slate-400'}" title="Grid View">
              <i data-lucide="grid" class="w-4 h-4"></i>
            </button>
            <button onclick="setFileViewMode('list')" class="p-1.5 rounded-lg ${AppState.viewMode === 'list' ? 'bg-sky-600 text-white' : 'text-slate-400'}" title="List View">
              <i data-lucide="list" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
      </div>

      <!-- Download from URL -->
      <div class="glass-card p-4 rounded-2xl border border-slate-800">
        <div class="flex items-start gap-3 mb-4">
          <div class="w-9 h-9 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 shrink-0">
            <i data-lucide="cloud-download" class="w-4 h-4"></i>
          </div>
          <div>
            <h3 class="text-sm font-bold text-white">Download from URL</h3>
            <p class="text-xs text-slate-500 mt-1">Paste a direct HTTP/HTTPS file link. The server will run <span class="font-mono text-cyan-300">wget</span> in the background and save the finished file in this directory.</p>
          </div>
        </div>

        <form onsubmit="startUrlDownload(event)" class="grid grid-cols-1 lg:grid-cols-[1fr_240px_auto] gap-2">
          <input id="url-download-link" type="url" required placeholder="https://example.com/file.zip" class="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-cyan-500">
          <input id="url-download-filename" type="text" placeholder="File name (optional)" maxlength="240" class="w-full bg-slate-900 border border-slate-800 rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-cyan-500">
          <button type="submit" class="bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold px-4 py-2.5 rounded-xl flex items-center justify-center gap-2">
            <i data-lucide="download" class="w-4 h-4"></i> Start Download
          </button>
        </form>

        <div class="mt-3 rounded-xl bg-slate-950/50 border border-slate-800 p-3">
          <p class="text-[11px] leading-5 text-slate-400">
            <span class="font-semibold text-slate-300">How it works:</span>
            1) Your link is checked, 2) <span class="font-mono text-cyan-300">wget</span> downloads it on the VPS in the background,
            3) the completed file is moved into your current folder, and 4) your file list and storage usage are refreshed.
            If the URL does not provide a useful filename, enter one in the File name box. Existing names are automatically made unique.
          </p>
        </div>
        <div id="url-download-jobs" class="mt-3"></div>
      </div>

      <!-- Breadcrumbs Path Navigator -->
      <div id="file-breadcrumbs" class="flex items-center gap-1 text-xs text-slate-400 bg-slate-950/40 px-4 py-2.5 rounded-xl border border-slate-800">
        <!-- Rendered dynamically -->
      </div>

      <!-- Upload Progress Container -->
      <div id="upload-progress-container" class="hidden glass-card p-4 rounded-xl border border-sky-500/30">
        <div class="flex justify-between text-xs font-semibold text-sky-400 mb-1">
          <span id="upload-status-text">Uploading files...</span>
          <span id="upload-percentage">0%</span>
        </div>
        <div class="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
          <div id="upload-progress-bar" class="bg-sky-500 h-full transition-all" style="width: 0%"></div>
        </div>
      </div>

      <!-- File Grid / List Container -->
      <div id="file-list-container" class="min-h-[300px]">
        <div class="flex items-center justify-center p-12 text-slate-400 text-sm">
          <i data-lucide="loader-2" class="w-6 h-6 animate-spin mr-2"></i> Loading directory...
        </div>
      </div>
    </div>
  `;

  updateFileRefreshButton();
  fetchFileList();
  loadUrlDownloadJobs();
}

async function fetchFileList({ clearSelection = true } = {}) {
  try {
    const cacheBust = Date.now();
    const data = await apiRequest(`/files/list?path=${encodeURIComponent(AppState.currentPath)}&_=${cacheBust}`);
    AppState.files = Array.isArray(data.files) ? data.files : [];
    if (clearSelection) AppState.selectedPaths = [];
    renderBreadcrumbs(data.currentPath || AppState.currentPath);
    renderFileItems();
    updateBulkActionVisibility();
    return data;
  } catch (err) {
    showToast(err.message, 'error');
    throw err;
  }
}

function updateFileRefreshButton() {
  const button = document.getElementById('file-refresh-button');
  if (!button) return;

  const remaining = Math.max(0, AppState.fileRefreshLockedUntil - Date.now());
  if (remaining > 0) {
    button.disabled = true;
    button.title = `Refresh available in ${Math.ceil(remaining / 1000)}s`;
  } else {
    button.disabled = false;
    button.title = 'Refresh';
    if (AppState.fileRefreshCountdownTimer) {
      clearInterval(AppState.fileRefreshCountdownTimer);
      AppState.fileRefreshCountdownTimer = null;
    }
  }
}

function startFileRefreshCooldown() {
  AppState.fileRefreshLockedUntil = Date.now() + 10000;
  updateFileRefreshButton();
  if (AppState.fileRefreshCountdownTimer) clearInterval(AppState.fileRefreshCountdownTimer);
  AppState.fileRefreshCountdownTimer = setInterval(() => {
    updateFileRefreshButton();
    if (Date.now() >= AppState.fileRefreshLockedUntil) {
      clearInterval(AppState.fileRefreshCountdownTimer);
      AppState.fileRefreshCountdownTimer = null;
    }
  }, 250);
}

async function refreshFileManager() {
  const button = document.getElementById('file-refresh-button');
  if (!button || button.disabled || Date.now() < AppState.fileRefreshLockedUntil) {
    updateFileRefreshButton();
    return;
  }

  button.disabled = true;
  button.classList.add('opacity-60', 'cursor-wait');
  const spinUntil = Date.now() + 1000;
  const spinTimer = window.setInterval(() => {
    const currentButton = document.getElementById('file-refresh-button');
    const currentIcon = currentButton?.querySelector('svg');
    if (currentIcon) currentIcon.classList.toggle('animate-spin', Date.now() < spinUntil);
    if (Date.now() >= spinUntil) {
      window.clearInterval(spinTimer);
      currentIcon?.classList.remove('animate-spin');
      currentButton?.classList.remove('cursor-wait');
    }
  }, 100);
  startFileRefreshCooldown();

  try {
    await fetchFileList({ clearSelection: true });
    showToast('File list refreshed.', 'success');
  } catch (_) {
    // fetchFileList already shows the error toast.
  } finally {
    window.setTimeout(() => {
      const currentButton = document.getElementById('file-refresh-button');
      currentButton?.querySelector('svg')?.classList.remove('animate-spin');
      currentButton?.classList.remove('opacity-60', 'cursor-wait');
      updateFileRefreshButton();
    }, 1000);
  }
}

function renderBreadcrumbs(currentPath) {
  const container = document.getElementById('file-breadcrumbs');
  if (!container) return;

  const parts = currentPath.split('/').filter(Boolean);
  let html = `<button onclick="navigateToPath('/')" class="hover:text-sky-400 font-semibold flex items-center gap-1"><i data-lucide="home" class="w-3.5 h-3.5"></i> Root</button>`;

  let accumPath = '';
  parts.forEach((p, idx) => {
    accumPath += '/' + p;
    const target = accumPath;
    html += ` <span class="text-slate-600">/</span> <button onclick="navigateToPath('${target}')" class="hover:text-sky-400 font-semibold">${escapeHtml(p)}</button>`;
  });

  container.innerHTML = html;
  if (window.lucide) lucide.createIcons();
}

function navigateToPath(targetPath) {
  AppState.currentPath = targetPath;
  fetchFileList();
}

function renderFileItems() {
  const container = document.getElementById('file-list-container');
  if (!container) return;

  const query = AppState.searchQuery.toLowerCase();
  const filtered = AppState.files.filter(f => f.name.toLowerCase().includes(query));

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="flex flex-col items-center justify-center p-16 text-center text-slate-500 glass-card rounded-2xl">
        <i data-lucide="folder-open" class="w-12 h-12 mb-3 text-slate-600"></i>
        <p class="text-sm font-medium">This directory is empty</p>
        <p class="text-xs mt-1">Upload files or create folders to get started.</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  if (AppState.viewMode === 'grid') {
    container.className = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4';
    container.innerHTML = filtered.map(file => {
      const isSelected = AppState.selectedPaths.includes(file.path);
      const icon = file.isDirectory ? 'folder' : getFileIcon(file.name);
      const iconColor = file.isDirectory ? 'text-amber-400' : 'text-sky-400';

      return `
        <div class="glass-card p-4 rounded-xl relative group hover:border-sky-500/50 transition-all cursor-pointer ${isSelected ? 'border-sky-500 bg-sky-500/10' : ''}" onclick="toggleSelectFile('${file.path}', event)">
          
          <div class="flex items-center justify-between mb-3">
            <input type="checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleSelectFile('${file.path}')" class="rounded border-slate-700 text-sky-600">
            
            <!-- Context Menu Button -->
            <button onclick="event.stopPropagation(); openFileContextMenu('${file.path}', ${file.isDirectory}, event)" class="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800">
              <i data-lucide="more-vertical" class="w-4 h-4"></i>
            </button>
          </div>

          <div class="flex flex-col items-center text-center" onclick="event.stopPropagation(); ${file.isDirectory ? `navigateToPath('${file.path}')` : `openFilePreview('${file.path}')`}">
            <i data-lucide="${icon}" class="w-10 h-10 ${iconColor} mb-2"></i>
            <div class="text-xs font-semibold text-slate-200 truncate w-full" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
            <div class="text-[10px] text-slate-500 mt-1">${file.isDirectory ? 'Folder' : formatBytes(file.size)}</div>
          </div>
        </div>
      `;
    }).join('');
  } else {
    // List View
    container.className = 'glass-card rounded-2xl overflow-hidden divide-y divide-slate-800/60';
    container.innerHTML = `
      <div class="px-4 py-3 bg-slate-950/60 flex items-center text-xs font-semibold text-slate-400">
        <span class="w-8"></span>
        <span class="flex-1">Name</span>
        <span class="w-32">Size</span>
        <span class="w-40">Modified</span>
        <span class="w-16 text-right">Actions</span>
      </div>
      ${filtered.map(file => {
        const isSelected = AppState.selectedPaths.includes(file.path);
        const icon = file.isDirectory ? 'folder' : getFileIcon(file.name);
        const iconColor = file.isDirectory ? 'text-amber-400' : 'text-sky-400';

        return `
          <div class="px-4 py-3 flex items-center text-xs hover:bg-slate-800/40 transition-all ${isSelected ? 'bg-sky-500/10' : ''}">
            <input type="checkbox" ${isSelected ? 'checked' : ''} onclick="toggleSelectFile('${file.path}')" class="w-4 h-4 rounded border-slate-700 text-sky-600 mr-3">
            
            <div class="flex-1 flex items-center gap-3 cursor-pointer" onclick="${file.isDirectory ? `navigateToPath('${file.path}')` : `openFilePreview('${file.path}')`}">
              <i data-lucide="${icon}" class="w-5 h-5 ${iconColor}"></i>
              <span class="font-medium text-slate-200 hover:text-sky-400">${escapeHtml(file.name)}</span>
            </div>

            <span class="w-32 text-slate-400">${file.isDirectory ? '--' : formatBytes(file.size)}</span>
            <span class="w-40 text-slate-400">${new Date(file.mtime).toLocaleString()}</span>

            <div class="w-16 text-right">
              <button onclick="openFileContextMenu('${file.path}', ${file.isDirectory}, event)" class="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800">
                <i data-lucide="more-vertical" class="w-4 h-4"></i>
              </button>
            </div>
          </div>
        `;
      }).join('')}
    `;
  }

  if (window.lucide) lucide.createIcons();
}

function getFileIcon(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return 'image';
  if (['zip', 'tar', 'gz', '7z', 'rar'].includes(ext)) return 'archive';
  if (['mp4', 'mkv', 'avi', 'mov'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'flac'].includes(ext)) return 'music';
  if (['pdf'].includes(ext)) return 'file-text';
  if (['js', 'ts', 'html', 'css', 'json', 'py', 'sh'].includes(ext)) return 'code';
  return 'file';
}

function updateBulkActionVisibility() {
  const bulkDiv = document.getElementById('bulk-actions');
  const countSpan = document.getElementById('selected-count');
  if (!bulkDiv) return;

  if (AppState.selectedPaths.length > 0) {
    bulkDiv.classList.remove('hidden');
    if (countSpan) countSpan.innerText = AppState.selectedPaths.length;
  } else {
    bulkDiv.classList.add('hidden');
    if (countSpan) countSpan.innerText = '0';
  }
}

function toggleSelectFile(filePath) {
  const idx = AppState.selectedPaths.indexOf(filePath);
  if (idx > -1) {
    AppState.selectedPaths.splice(idx, 1);
  } else {
    AppState.selectedPaths.push(filePath);
  }

  updateBulkActionVisibility();
  renderFileItems();
}

function setFileViewMode(mode) {
  AppState.viewMode = mode;
  renderFileItems();
}

function handleFileSearch(e) {
  AppState.searchQuery = e.target.value;
  renderFileItems();
}

// Upload Handling
async function handleFileUpload(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  const formData = new FormData();
  formData.append('targetDir', AppState.currentPath);
  for (let i = 0; i < files.length; i++) {
    formData.append('files', files[i]);
  }

  const progContainer = document.getElementById('upload-progress-container');
  const progBar = document.getElementById('upload-progress-bar');
  const progPct = document.getElementById('upload-percentage');

  if (progContainer) progContainer.classList.remove('hidden');

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files/upload', true);
    if (AppState.token) xhr.setRequestHeader('Authorization', `Bearer ${AppState.token}`);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 100);
        if (progBar) progBar.style.width = `${percent}%`;
        if (progPct) progPct.innerText = `${percent}%`;
      }
    };

    xhr.onload = () => {
      if (progContainer) progContainer.classList.add('hidden');
      if (xhr.status === 200) {
        showToast('Files uploaded successfully!', 'success');
        fetchFileList();
        updateQuotaWidget();
      } else {
        const res = JSON.parse(xhr.responseText || '{}');
        showToast(res.error || 'Upload failed', 'error');
      }
    };

    xhr.send(formData);
  } catch (err) {
    if (progContainer) progContainer.classList.add('hidden');
    showToast(err.message, 'error');
  }
}

// ==========================================
// 4. MODALS & CONTEXT MENUS (Create Folder, Share Link, Extract)
// ==========================================
function openCreateFolderModal() {
  const name = prompt('Enter new folder name:');
  if (!name || !name.trim()) return;

  const targetPath = AppState.currentPath.endsWith('/')
    ? AppState.currentPath + name.trim()
    : AppState.currentPath + '/' + name.trim();

  apiRequest('/files/create-folder', {
    method: 'POST',
    body: { path: targetPath }
  })
  .then(() => {
    showToast('Folder created!', 'success');
    fetchFileList();
  })
  .catch(err => showToast(err.message, 'error'));
}

function openFileContextMenu(filePath, isDirectory, e) {
  const existing = document.getElementById('file-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'file-context-menu';
  menu.className = 'fixed bg-slate-950 border border-slate-800 rounded-xl shadow-2xl p-2 z-50 text-xs w-48 space-y-1';

  const ext = filePath.toLowerCase();
  const isArchive = ext.endsWith('.zip') || ext.endsWith('.tar') || ext.endsWith('.tar.gz') || ext.endsWith('.7z');

  menu.innerHTML = `
    <button onclick="downloadSingleFile('${filePath}')" class="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-800 flex items-center gap-2 text-slate-200">
      <i data-lucide="download" class="w-3.5 h-3.5 text-sky-400"></i> Download
    </button>

    <button onclick="createShareLinkModal('${filePath}')" class="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-800 flex items-center gap-2 text-slate-200">
      <i data-lucide="share-2" class="w-3.5 h-3.5 text-emerald-400"></i> Create Share Link
    </button>

    <button onclick="renameFilePrompt('${filePath}')" class="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-800 flex items-center gap-2 text-slate-200">
      <i data-lucide="edit-3" class="w-3.5 h-3.5 text-amber-400"></i> Rename
    </button>

    <button onclick="moveFilePrompt('${filePath}')" class="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-800 flex items-center gap-2 text-slate-200">
      <i data-lucide="folder-input" class="w-3.5 h-3.5 text-cyan-400"></i> Move to...
    </button>

    ${isArchive ? `
      <button onclick="extractArchivePrompt('${filePath}')" class="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-800 flex items-center gap-2 text-purple-400">
        <i data-lucide="file-archive" class="w-3.5 h-3.5"></i> Extract Archive
      </button>
    ` : ''}

    <button onclick="deleteSingleFile('${filePath}')" class="w-full text-left px-3 py-2 rounded-lg hover:bg-slate-800 flex items-center gap-2 text-red-400">
      <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Delete
    </button>
  `;

  document.body.appendChild(menu);
  if (window.lucide) lucide.createIcons();

  // Keep the three-dot menu fully visible on desktop and mobile.
  const gap = 8;
  const menuRect = menu.getBoundingClientRect();
  let left = e.clientX;
  let top = e.clientY;
  if (left + menuRect.width > window.innerWidth - gap) left = Math.max(gap, e.clientX - menuRect.width);
  if (top + menuRect.height > window.innerHeight - gap) top = Math.max(gap, window.innerHeight - menuRect.height - gap);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const dismiss = () => {
    menu.remove();
    document.removeEventListener('click', dismiss);
  };
  setTimeout(() => document.addEventListener('click', dismiss), 50);
}

async function downloadSingleFile(filePath) {
  try {
    if (!AppState.token) throw new Error('Your session has expired. Please log in again.');

    // IMPORTANT: do not fetch() + blob() here. That forces the browser to wait
    // for the ENTIRE large file before starting the download and can consume
    // huge amounts of RAM. A normal same-origin attachment URL lets Chromium
    // stream the file directly to its download manager immediately.
    const downloadUrl = `/api/files/download?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(AppState.token)}`;
    const frame = document.createElement('iframe');
    frame.style.position = 'fixed';
    frame.style.width = '1px';
    frame.style.height = '1px';
    frame.style.opacity = '0';
    frame.style.pointerEvents = 'none';
    frame.setAttribute('aria-hidden', 'true');
    frame.src = downloadUrl;
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), 120000);

    const filename = filePath.split('/').filter(Boolean).pop() || 'download';
    showToast(`Download started: ${filename}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openMoveSelectedPrompt() {
  if (!AppState.selectedPaths.length) return showToast('Select at least one file or folder first.', 'error');
  const destinationDir = prompt('Enter destination directory (example: / or /Testing):', AppState.currentPath || '/');
  if (destinationDir === null) return;
  const normalized = destinationDir.trim() || '/';

  apiRequest('/files/move', {
    method: 'POST',
    body: { items: [...AppState.selectedPaths], destinationDir: normalized }
  })
    .then(() => {
      showToast(`Selected items moved to ${normalized}`, 'success');
      AppState.selectedPaths = [];
      fetchFileList();
      updateQuotaWidget();
    })
    .catch(err => showToast(err.message, 'error'));
}

function moveFilePrompt(filePath) {
  const currentDir = filePath.substring(0, filePath.lastIndexOf('/')) || '/';
  const destinationDir = prompt('Enter destination directory (example: / or /Testing):', AppState.currentPath || currentDir);
  if (destinationDir === null) return;
  const normalized = destinationDir.trim() || '/';

  apiRequest('/files/move', {
    method: 'POST',
    body: { items: [filePath], destinationDir: normalized }
  })
    .then(() => {
      showToast(`Moved to ${normalized}`, 'success');
      AppState.selectedPaths = AppState.selectedPaths.filter(p => p !== filePath);
      fetchFileList();
      updateQuotaWidget();
    })
    .catch(err => showToast(err.message, 'error'));
}

function renameFilePrompt(oldPath) {
  const oldName = oldPath.split('/').pop();
  const newName = prompt('Enter new name:', oldName);
  if (!newName || newName === oldName) return;

  const parentDir = oldPath.substring(0, oldPath.lastIndexOf('/')) || '/';
  const newPath = parentDir.endsWith('/') ? parentDir + newName : parentDir + '/' + newName;

  apiRequest('/files/rename', {
    method: 'POST',
    body: { oldPath, newPath }
  })
  .then(() => {
    showToast('Item renamed!', 'success');
    fetchFileList();
  })
  .catch(err => showToast(err.message, 'error'));
}

function deleteSingleFile(filePath) {
  if (!confirm(`Are you sure you want to delete ${filePath.split('/').pop()}?`)) return;

  apiRequest('/files/delete', {
    method: 'POST',
    body: { paths: [filePath] }
  })
  .then(() => {
    showToast('Deleted successfully!', 'success');
    fetchFileList();
    updateQuotaWidget();
  })
  .catch(err => showToast(err.message, 'error'));
}

function handleBulkDelete() {
  if (AppState.selectedPaths.length === 0) return;
  if (!confirm(`Delete ${AppState.selectedPaths.length} selected items permanently?`)) return;

  apiRequest('/files/delete', {
    method: 'POST',
    body: { paths: AppState.selectedPaths }
  })
  .then(() => {
    showToast('Selected items deleted!', 'success');
    fetchFileList();
    updateQuotaWidget();
  })
  .catch(err => showToast(err.message, 'error'));
}

function openCompressModal() {
  const archiveName = prompt('Enter archive filename (e.g. backup.zip):', 'archive.zip');
  if (!archiveName) return;

  apiRequest('/files/compress', {
    method: 'POST',
    body: {
      items: AppState.selectedPaths,
      archiveName,
      format: archiveName.endsWith('.tar.gz') ? 'tar.gz' : archiveName.split('.').pop()
    }
  })
  .then(() => {
    showToast('Archive created successfully!', 'success');
    fetchFileList();
    updateQuotaWidget();
  })
  .catch(err => showToast(err.message, 'error'));
}

function extractArchivePrompt(archivePath) {
  const targetDir = prompt('Extract to directory (leave blank for current directory):', AppState.currentPath);
  if (targetDir === null) return;

  apiRequest('/files/extract', {
    method: 'POST',
    body: { archivePath, targetDir: targetDir || AppState.currentPath }
  })
  .then(() => {
    showToast('Archive extracted successfully!', 'success');
    fetchFileList();
    updateQuotaWidget();
  })
  .catch(err => showToast(err.message, 'error'));
}

function createShareLinkModal(filePath) {
  const durationStr = prompt('Link expiration duration in hours (e.g. 1, 24, 168 for 7 days, 0 for unlimited):', '24');
  if (durationStr === null) return;

  apiRequest('/share/create', {
    method: 'POST',
    body: { filePath, durationHours: parseInt(durationStr, 10) }
  })
  .then(data => {
    prompt('Public Share Link Created! Copy your link below:', data.shareUrl);
  })
  .catch(err => showToast(err.message, 'error'));
}

async function openFilePreview(filePath) {
  try {
    if (!AppState.token) throw new Error('Your session has expired. Please log in again.');

    const fileName = filePath.split('/').filter(Boolean).pop() || 'Preview';
    const previewUrl = `/api/files/preview?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(AppState.token)}&_=${Date.now()}`;
    const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'];
    const videoExts = ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv'];
    const isImage = imageExts.includes(ext);
    const isVideo = videoExts.includes(ext);

    closeFilePreview();
    const drawer = document.createElement('div');
    drawer.id = 'file-preview-drawer';
    drawer.className = 'fixed right-0 top-0 h-full bg-slate-950 border-l border-slate-800 shadow-2xl z-[80] flex flex-col translate-x-0';
    drawer.innerHTML = `
      <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800 bg-slate-950/95 shrink-0">
        <div class="min-w-0">
          <div class="text-xs text-slate-500">Preview</div>
          <div class="text-sm font-semibold text-white truncate" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
        </div>
        <button onclick="closeFilePreview()" class="p-2 rounded-lg bg-slate-800 hover:bg-red-600/80 text-slate-300 hover:text-white shrink-0" title="Close preview">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>
      </div>
      <div id="file-preview-body" class="flex-1 overflow-auto p-4 flex items-center justify-center bg-black/20">
        ${isImage
          ? `<img src="${previewUrl}" alt="${escapeHtml(fileName)}" class="preview-media mx-auto" />`
          : isVideo
            ? createVideoPlayerMarkup('file-preview-video', previewUrl, fileName)
            : `<div class="text-sm text-slate-400 flex items-center gap-2"><i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Loading preview...</div>`}
      </div>
      <div class="px-4 py-3 border-t border-slate-800 text-[11px] text-slate-500 shrink-0">
        Preview is read-only. Use Download from the file menu to save a copy to your device.
      </div>
    `;
    document.body.appendChild(drawer);
    if (window.lucide) lucide.createIcons();

    if (isVideo) {
      setupVideoPlayer(
        'file-preview-video',
        previewUrl,
        `/api/files/preview-transcoded?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(AppState.token)}`,
        `/api/files/preview-transcoded?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(AppState.token)}&safe=1`,
        `/api/files/download?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(AppState.token)}`
      );
    }

    // Images/videos stream directly from the preview endpoint. This avoids downloading
    // a large video into browser memory and lets the browser use HTTP range requests.
    if (isImage || isVideo) return;

    const res = await fetch(previewUrl, { headers: { Authorization: `Bearer ${AppState.token}` }, cache: 'no-store' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Preview could not be loaded.');
    }

    const contentType = (res.headers.get('content-type') || '').split(';')[0].toLowerCase();
    const body = document.getElementById('file-preview-body');
    if (!body) return;

    if (contentType === 'application/pdf') {
      body.innerHTML = `<iframe src="${previewUrl}" class="w-full h-full min-h-[70vh] rounded-xl bg-white border border-slate-800"></iframe>`;
    } else if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('javascript')) {
      const text = await res.text();
      body.innerHTML = `<pre class="w-full whitespace-pre-wrap break-words text-xs leading-5 text-slate-300 bg-slate-900 rounded-xl p-4 overflow-auto">${escapeHtml(text)}</pre>`;
    } else {
      body.innerHTML = `<div class="text-center text-slate-400 text-sm p-6"><i data-lucide="file-question" class="w-10 h-10 mx-auto mb-3 text-slate-600"></i><p>This file type cannot be previewed.</p></div>`;
      if (window.lucide) lucide.createIcons();
    }
  } catch (err) {
    const body = document.getElementById('file-preview-body');
    if (body) body.innerHTML = `<div class="text-center text-red-300 text-sm p-6">${escapeHtml(err.message)}</div>`;
    else showToast(err.message, 'error');
  }
}

function closeFilePreview() {
  const drawer = document.getElementById('file-preview-drawer');
  if (drawer) drawer.remove();
  if (AppState.previewObjectUrl) {
    URL.revokeObjectURL(AppState.previewObjectUrl);
    AppState.previewObjectUrl = null;
  }
}

async function startUrlDownload(event) {
  event.preventDefault();
  const urlInput = document.getElementById('url-download-link');
  const nameInput = document.getElementById('url-download-filename');
  const url = urlInput?.value.trim();
  const filename = nameInput?.value.trim() || '';

  if (!url) return showToast('Enter a direct download URL.', 'error');

  try {
    const data = await apiRequest('/files/download-from-url', {
      method: 'POST',
      body: { url, filename, targetDir: AppState.currentPath }
    });
    showToast(`Download started: ${data.job.filename}`, 'success');
    if (urlInput) urlInput.value = '';
    if (nameInput) nameInput.value = '';
    await loadUrlDownloadJobs();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function formatEta(seconds) {
  seconds = Math.max(0, Math.round(Number(seconds) || 0));
  if (!seconds) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function formatDownloadSpeed(bytesPerSec) {
  return bytesPerSec ? `${formatBytes(bytesPerSec)}/s` : '—';
}

async function removeUrlDownloadJob(jobId) {
  try {
    await apiRequest(`/files/download-jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    await loadUrlDownloadJobs();
    showToast('Removed from recent downloads.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function clearUrlDownloadJobs() {
  try {
    await apiRequest('/files/download-jobs', { method: 'DELETE' });
    await loadUrlDownloadJobs();
    showToast('Download history cleared.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadUrlDownloadJobs() {
  const container = document.getElementById('url-download-jobs');
  if (!container) return;

  try {
    const jobs = await apiRequest('/files/download-jobs');
    const active = jobs.some(j => j.status === 'queued' || j.status === 'running');

    if (!jobs.length) {
      container.innerHTML = '';
    } else {
      container.innerHTML = `
        <div class="flex items-center justify-between gap-3 mb-2">
          <div class="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Recent URL Downloads</div>
          <div class="flex items-center gap-2">
            <div class="text-[10px] text-slate-600">Click ✕ to remove an item</div>
            <button type="button" onclick="clearUrlDownloadJobs()" class="text-[10px] font-semibold text-slate-500 hover:text-red-400 underline decoration-dotted">Clear finished</button>
          </div>
        </div>
        <div class="space-y-2">
          ${jobs.slice(0, 20).map(j => {
            const progress = Math.max(0, Math.min(100, Number(j.progress || 0)));
            const statusClass = j.status === 'completed' ? 'text-emerald-400' : j.status === 'failed' ? 'text-red-400' : 'text-cyan-400';
            const bytes = Number(j.bytes || 0);
            const total = Number(j.total_bytes || 0);
            const speed = Number(j.speed_bytes_per_sec || 0);
            const eta = Number(j.eta_seconds || 0);
            const statusText = j.status === 'completed' ? 'Completed' : j.status === 'failed' ? `Failed: ${escapeHtml(j.error || 'Unknown error')}` : (j.status === 'queued' ? 'Queued' : 'Downloading');
            const detail = j.status === 'running' ? `${formatBytes(bytes)}${total ? ` / ${formatBytes(total)}` : ''} · ${formatDownloadSpeed(speed)} · ETA ${formatEta(eta)}` : (j.status === 'completed' ? `${formatBytes(bytes)} downloaded` : '');
            return `
              <div class="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                    <div class="text-xs font-medium text-slate-200 truncate" title="${escapeHtml(j.filename)}">${escapeHtml(j.filename)}</div>
                    <div class="text-[10px] text-slate-500 truncate">${escapeHtml(j.target_path)}</div>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <span class="text-[10px] font-semibold ${statusClass} text-right">${statusText}</span>
                    <button type="button" onclick="removeUrlDownloadJob('${escapeHtml(j.id)}')" class="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-red-600/80 transition" title="Remove from recent downloads" aria-label="Remove download">
                      <i data-lucide="x" class="w-3.5 h-3.5"></i>
                    </button>
                  </div>
                </div>
                ${j.status === 'running' || j.status === 'queued' ? `
                  <div class="mt-2 flex items-center justify-between gap-3 text-[10px]">
                    <span class="text-slate-400 font-mono">${j.status === 'queued' ? 'Waiting to start…' : detail}</span>
                    <span class="text-cyan-300 font-semibold">${progress}%</span>
                  </div>
                  <div class="mt-1.5 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div class="h-full bg-cyan-500 transition-[width] duration-500" style="width:${progress}%"></div>
                  </div>` : ''}
                ${j.status === 'completed' ? `<div class="mt-1 text-[10px] text-slate-500">${detail}</div>` : ''}
              </div>`;
          }).join('')}
        </div>`;
      if (window.lucide) lucide.createIcons();
    }

    if (active) {
      if (AppState.downloadJobsTimer) clearTimeout(AppState.downloadJobsTimer);
      AppState.downloadJobsTimer = setTimeout(loadUrlDownloadJobs, 1000);
    } else if (AppState.downloadJobsTimer) {
      clearTimeout(AppState.downloadJobsTimer);
      AppState.downloadJobsTimer = null;
    }

    if (jobs.some(j => j.status === 'completed' && Date.now() - new Date(j.updated_at).getTime() < 5000)) {
      fetchFileList({ clearSelection: false }).catch(() => {});
      updateQuotaWidget();
    }
  } catch (err) {
    // The normal file manager should remain usable if job status cannot be loaded.
  }
}

// ==========================================
// 5. SHARE LINKS TAB COMPONENT
// ==========================================
async function renderShareLinksTab(container) {
  container.innerHTML = `
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-lg font-bold text-white">Active Share Links</h2>
          <p class="text-xs text-slate-400">Manage your public share links and expiration limits (Default Max: 3 Links)</p>
        </div>
        <button onclick="renderShareLinksTab(document.getElementById('tab-content-area'))" class="p-2 bg-slate-800 text-slate-300 rounded-xl hover:bg-slate-700">
          <i data-lucide="refresh-cw" class="w-4 h-4"></i>
        </button>
      </div>

      <div id="share-links-list" class="glass-card rounded-2xl overflow-hidden">
        <div class="p-8 text-center text-slate-400 text-sm">Loading share links...</div>
      </div>
    </div>
  `;

  try {
    const links = await apiRequest('/share/my-links');
    const listDiv = document.getElementById('share-links-list');
    if (!listDiv) return;

    if (links.length === 0) {
      listDiv.innerHTML = `
        <div class="p-12 text-center text-slate-500">
          <i data-lucide="link" class="w-10 h-10 mb-2 text-slate-600 inline-block"></i>
          <p class="text-sm font-medium">No share links created yet</p>
          <p class="text-xs mt-1">Right-click any file in the File Manager to generate a share link.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    listDiv.innerHTML = `
      <div class="divide-y divide-slate-800/60">
        <div class="px-4 py-3 bg-slate-950/60 flex items-center text-xs font-semibold text-slate-400">
          <span class="flex-1">File Path</span>
          <span class="w-36">Expires</span>
          <span class="w-24 text-center">Views</span>
          <span class="w-24 text-center">Status</span>
          <span class="w-28 text-right">Actions</span>
        </div>
        ${links.map(l => `
          <div class="px-4 py-3 flex items-center text-xs">
            <div class="flex-1 truncate font-medium text-slate-200">
              ${escapeHtml(l.file_path)}
            </div>
            <span class="w-36 text-slate-400">${l.expires_at ? new Date(l.expires_at).toLocaleString() : 'Never'}</span>
            <span class="w-24 text-center font-bold text-sky-400">${l.view_count}</span>
            <span class="w-24 text-center">
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${l.is_active && !l.isExpired ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'}">
                ${l.is_active && !l.isExpired ? 'Active' : 'Expired'}
              </span>
            </span>
            <div class="w-28 text-right flex items-center justify-end gap-2">
              <button onclick="navigator.clipboard.writeText('${l.shareUrl}'); showToast('Share URL copied!', 'success');" class="p-1.5 text-slate-400 hover:text-sky-400 rounded-lg hover:bg-slate-800" title="Copy Link">
                <i data-lucide="copy" class="w-4 h-4"></i>
              </button>
              <button onclick="revokeShareLink('${l.id}')" class="p-1.5 text-slate-400 hover:text-red-400 rounded-lg hover:bg-slate-800" title="Revoke Link">
                <i data-lucide="trash-2" class="w-4 h-4"></i>
              </button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function revokeShareLink(token) {
  if (!confirm('Revoke this share link?')) return;
  apiRequest('/share/revoke', {
    method: 'POST',
    body: { token }
  })
  .then(() => {
    showToast('Share link revoked!', 'success');
    renderShareLinksTab(document.getElementById('tab-content-area'));
  })
  .catch(err => showToast(err.message, 'error'));
}

// ==========================================
// 6. DASHBOARD & PROFILE COMPONENT
// ==========================================
async function renderDashboardTab(container) {
  container.innerHTML = `
    <div class="space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div class="glass-card p-6 rounded-2xl border border-slate-800">
          <div class="flex items-center justify-between mb-4">
            <span class="text-xs font-semibold text-slate-400 uppercase">Storage Quota</span>
            <i data-lucide="pie-chart" class="w-5 h-5 text-sky-400"></i>
          </div>
          <div class="text-2xl font-bold text-white mb-2" id="dash-storage-text">Loading...</div>
          <div class="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
            <div id="dash-storage-bar" class="bg-sky-500 h-full rounded-full" style="width: 0%"></div>
          </div>
        </div>

        <div class="glass-card p-6 rounded-2xl border border-slate-800">
          <div class="flex items-center justify-between mb-4">
            <span class="text-xs font-semibold text-slate-400 uppercase">Active Shares</span>
            <i data-lucide="share-2" class="w-5 h-5 text-emerald-400"></i>
          </div>
          <div class="text-2xl font-bold text-white" id="dash-share-count">0 / 3 Active</div>
          <p class="text-xs text-slate-500 mt-2">Max active share link limit</p>
        </div>

        <div class="glass-card p-6 rounded-2xl border border-slate-800">
          <div class="flex items-center justify-between mb-4">
            <span class="text-xs font-semibold text-slate-400 uppercase">Current Session IP</span>
            <i data-lucide="shield-check" class="w-5 h-5 text-purple-400"></i>
          </div>
          <div class="text-lg font-bold text-white font-mono" id="dash-ip-text">Detecting...</div>
          <p class="text-xs text-slate-500 mt-2">IPv4 & IPv6 Tracking Active</p>
        </div>
      </div>

      <div class="glass-card p-6 rounded-2xl border border-slate-800">
        <h3 class="text-sm font-bold text-white mb-4 flex items-center gap-2">
          <i data-lucide="clock" class="w-4 h-4 text-sky-400"></i> Recent Login Activity
        </h3>
        <div id="dash-recent-logins" class="text-xs text-slate-400">Loading recent logins...</div>
      </div>
      <div id="dash-contact-details" class="grid md:grid-cols-2 gap-4"></div>
    </div>
  `;

  if (window.lucide) lucide.createIcons();

  try {
    const profile = await apiRequest('/auth/profile');
    const links = await apiRequest('/share/my-links');

    const used = profile.user.usedStorageBytes || 0;
    const total = profile.user.storage_quota_bytes || 10737418240;
    const pct = Math.min(100, Math.round((used / total) * 100));

    document.getElementById('dash-storage-text').innerText = `${formatBytes(used)} / ${formatBytes(total)}`;
    document.getElementById('dash-storage-bar').style.width = `${pct}%`;
    document.getElementById('dash-share-count').innerText = `${links.filter(l => l.is_active && !l.isExpired).length} / 3 Active`;
    document.getElementById('dash-ip-text').innerText = profile.currentIp.ipV4;

    const loginDiv = document.getElementById('dash-recent-logins');
    if (loginDiv) {
      loginDiv.innerHTML = `
        <div class="divide-y divide-slate-800/60">
          ${profile.recentActivity.map(a => `
            <div class="py-2.5 flex items-center justify-between">
              <span class="font-mono text-slate-200">${a.ip_v4} ${a.ip_v6 ? `(${a.ip_v6})` : ''}</span>
              <span class="text-slate-500 truncate max-w-[200px]">${escapeHtml(a.user_agent)}</span>
              <span class="text-slate-400">${new Date(a.timestamp).toLocaleString()}</span>
            </div>
          `).join('')}
        </div>
      `;
    }
    const publicSettings = await fetch('/api/public/settings', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null);
    const details = document.getElementById('dash-contact-details');
    if (details && publicSettings) {
      const cards = [];
      if (publicSettings.discordEnabled && publicSettings.discordJoinUrl) {
        cards.push(`<div class="glass-card p-5 rounded-2xl border border-indigo-500/20 bg-indigo-500/5 flex items-center justify-between gap-4"><div class="flex items-center gap-3"><div class="w-11 h-11 rounded-xl bg-indigo-500/15 flex items-center justify-center text-indigo-300"><i data-lucide="message-circle" class="w-5 h-5"></i></div><div><div class="text-sm font-bold text-white">Discord Community</div><div class="text-xs text-slate-400 mt-1">Join our Discord server.</div></div></div><a href="${escapeHtml(publicSettings.discordJoinUrl)}" target="_blank" rel="noopener noreferrer" class="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold px-4 py-2 rounded-lg">Join</a></div>`);
      }
      if (publicSettings.contactEmailEnabled && publicSettings.contactEmail) {
        cards.push(`<div class="glass-card p-5 rounded-2xl border border-sky-500/20 bg-sky-500/5 flex items-center justify-between gap-4"><div class="flex items-center gap-3"><div class="w-11 h-11 rounded-xl bg-sky-500/15 flex items-center justify-center text-sky-300"><i data-lucide="mail" class="w-5 h-5"></i></div><div><div class="text-sm font-bold text-white">Contact</div><div class="text-xs text-slate-400 mt-1">${escapeHtml(publicSettings.contactEmail)}</div></div></div><a href="mailto:${escapeHtml(publicSettings.contactEmail)}" class="bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold px-4 py-2 rounded-lg">Email</a></div>`);
      }
      details.innerHTML = cards.join('');
      if (window.lucide) lucide.createIcons();
    }
  } catch (err) {}
}

async function renderProfileTab(container) {
  container.innerHTML = `
    <div class="max-w-2xl mx-auto space-y-6">
      <div class="glass-card p-6 rounded-2xl border border-slate-800 space-y-4">
        <h3 class="text-lg font-bold text-white border-b border-slate-800 pb-3">User Profile Information</h3>
        
        <form onsubmit="handleProfileUpdate(event)" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Full Name</label>
            <input type="text" id="prof-name" value="${escapeHtml(AppState.user.name)}" class="w-full bg-slate-900 border border-slate-800 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-sky-500">
          </div>

          <div>
            <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Username</label>
            <input type="text" id="prof-username" value="${escapeHtml(AppState.user.username)}" class="w-full bg-slate-900 border border-slate-800 rounded-lg px-4 py-2.5 text-sm text-white focus:outline-none focus:border-sky-500">
          </div>

          <div class="pt-4 border-t border-slate-800">
            <h4 class="text-xs font-bold uppercase text-sky-400 mb-3">Change Password (Optional)</h4>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-xs text-slate-400 mb-1">Current Password</label>
                <input type="password" id="prof-curr-pass" class="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white">
              </div>
              <div>
                <label class="block text-xs text-slate-400 mb-1">New Password</label>
                <input type="password" id="prof-new-pass" class="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white">
              </div>
            </div>
          </div>

          <button type="submit" class="bg-sky-600 hover:bg-sky-500 text-white font-medium text-xs px-5 py-2.5 rounded-lg shadow-lg shadow-sky-600/20">
            Save Profile Changes
          </button>
        </form>
      </div>

      <!-- Email Verification System -->
      <div class="glass-card p-6 rounded-2xl border border-slate-800 space-y-4">
        <h3 class="text-sm font-bold text-white border-b border-slate-800 pb-3">Email Address Verification</h3>
        <p class="text-xs text-slate-400">Current Email: <span class="font-bold text-white">${escapeHtml(AppState.user.email)}</span></p>

        <form onsubmit="handleEmailChangeRequest(event)" class="space-y-3">
          <div>
            <label class="block text-xs text-slate-400 mb-1">New Email Address</label>
            <input type="email" id="email-new-input" required class="w-full bg-slate-900 border border-slate-800 rounded-lg px-4 py-2 text-sm text-white" placeholder="newemail@example.com">
          </div>
          <div>
            <label class="block text-xs text-slate-400 mb-1">Current Password Verification</label>
            <input type="password" id="email-pass-input" required class="w-full bg-slate-900 border border-slate-800 rounded-lg px-4 py-2 text-sm text-white">
          </div>
          <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs px-4 py-2 rounded-lg">
            Send Email Verification Link
          </button>
        </form>
      </div>
    </div>
  `;
}

async function handleProfileUpdate(e) {
  e.preventDefault();
  const name = document.getElementById('prof-name').value;
  const username = document.getElementById('prof-username').value;
  const currentPassword = document.getElementById('prof-curr-pass').value;
  const newPassword = document.getElementById('prof-new-pass').value;

  try {
    await apiRequest('/auth/profile', {
      method: 'PUT',
      body: { name, username, currentPassword, newPassword }
    });
    AppState.user.name = name;
    AppState.user.username = username;
    localStorage.setItem('vps_user', JSON.stringify(AppState.user));
    showToast('Profile updated!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleEmailChangeRequest(e) {
  e.preventDefault();
  const newEmail = document.getElementById('email-new-input').value;
  const password = document.getElementById('email-pass-input').value;

  try {
    const data = await apiRequest('/auth/email/request-change', {
      method: 'POST',
      body: { newEmail, password }
    });
    showToast(data.message, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================
// 7. SYSTEM ADMIN PORTAL (VPS PTY Console, Users, SMTP, Logs)
// ==========================================
async function renderAdminPortalTab(container) {
  container.innerHTML = `
    <div class="space-y-6">
      <!-- Admin Navigation Sub-Tabs -->
      <div class="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
        <button onclick="switchAdminSubTab('overview')" class="px-4 py-2 rounded-lg text-xs font-bold transition-all ${AppState.adminTab === 'overview' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}">Overview Stats</button>
        <button onclick="switchAdminSubTab('users')" class="px-4 py-2 rounded-lg text-xs font-bold transition-all ${AppState.adminTab === 'users' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}">User Management</button>
        <button onclick="switchAdminSubTab('storage')" class="px-4 py-2 rounded-lg text-xs font-bold transition-all ${AppState.adminTab === 'storage' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}">Storage</button>
        <button onclick="switchAdminSubTab('download-monitor')" class="px-4 py-2 rounded-lg text-xs font-bold transition-all ${AppState.adminTab === 'download-monitor' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}">URL Downloads</button>
        <button onclick="switchAdminSubTab('ip-history')" class="px-4 py-2 rounded-lg text-xs font-bold transition-all ${AppState.adminTab === 'ip-history' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}">IP Tracking</button>
        <button onclick="switchAdminSubTab('smtp')" class="px-4 py-2 rounded-lg text-xs font-bold transition-all ${AppState.adminTab === 'smtp' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}">SMTP Config</button>
        <button onclick="switchAdminSubTab('details')" class="px-4 py-2 rounded-lg text-xs font-bold transition-all ${AppState.adminTab === 'details' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}">Details</button>
        <button onclick="switchAdminSubTab('settings')" class="px-4 py-2 rounded-lg text-xs font-bold transition-all ${AppState.adminTab === 'settings' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}">App Settings</button>
        <button onclick="switchAdminSubTab('audit-logs')" class="px-4 py-2 rounded-lg text-xs font-bold transition-all ${AppState.adminTab === 'audit-logs' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}">Audit Logs</button>
        
        <!-- VPS Console Button -->
        <button onclick="switchAdminSubTab('console')" class="ml-auto bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 shadow-lg shadow-emerald-600/20">
          <i data-lucide="terminal" class="w-4 h-4"></i> VPS SSH Console
        </button>
      </div>

      <div id="admin-subtab-area">
        <!-- Rendered dynamically -->
      </div>
    </div>
  `;

  if (window.lucide) lucide.createIcons();
  renderAdminSubTabContent();
}

function switchAdminSubTab(tab) {
  AppState.adminTab = tab;
  renderAdminSubTabContent();
}

async function renderAdminSubTabContent() {
  const area = document.getElementById('admin-subtab-area');
  if (!area) return;

  area.innerHTML = '<div class="glass-card p-6 rounded-2xl border border-slate-800 text-sm text-slate-400">Loading...</div>';

  try {
    if (AppState.adminTab === 'overview') {
      const stats = await apiRequest('/admin/stats');
      area.innerHTML = `
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div class="glass-card p-5 rounded-xl border border-slate-800"><div class="text-xs text-slate-400 uppercase font-semibold">Total Users</div><div class="text-2xl font-bold text-white mt-1">${stats.totalUsers}</div></div>
          <div class="glass-card p-5 rounded-xl border border-slate-800"><div class="text-xs text-slate-400 uppercase font-semibold">Active Users</div><div class="text-2xl font-bold text-emerald-400 mt-1">${stats.activeUsers}</div></div>
          <div class="glass-card p-5 rounded-xl border border-slate-800"><div class="text-xs text-slate-400 uppercase font-semibold">Suspended Users</div><div class="text-2xl font-bold text-red-400 mt-1">${stats.suspendedUsers}</div></div>
          <div class="glass-card p-5 rounded-xl border border-slate-800"><div class="text-xs text-slate-400 uppercase font-semibold">Suspicious Flagged</div><div class="text-2xl font-bold text-amber-400 mt-1">${stats.suspiciousAccounts}</div></div>
        </div>
        <div class="grid lg:grid-cols-2 gap-4 mt-4">
          <div class="glass-card p-5 rounded-2xl border border-slate-800">
            <h3 class="text-sm font-bold text-white mb-3">Recent Registrations</h3>
            <div class="space-y-2">${(stats.recentRegistrations || []).map(u => `<div class="flex justify-between gap-3 text-xs"><span class="text-slate-200 truncate">${escapeHtml(u.username)}</span><span class="text-slate-500">${new Date(u.created_at).toLocaleString()}</span></div>`).join('') || '<div class="text-xs text-slate-500">No registrations yet.</div>'}</div>
          </div>
          <div class="glass-card p-5 rounded-2xl border border-slate-800">
            <h3 class="text-sm font-bold text-white mb-3">Recent Logins</h3>
            <div class="space-y-2">${(stats.recentLogins || []).map(l => `<div class="flex justify-between gap-3 text-xs"><span class="text-slate-200 truncate">${escapeHtml(l.username)} · ${escapeHtml(l.status)}</span><span class="text-slate-500">${escapeHtml(l.ip_v4 || l.ip_v6 || 'unknown')}</span></div>`).join('') || '<div class="text-xs text-slate-500">No logins yet.</div>'}</div>
          </div>
        </div>
        <div class="glass-card p-5 rounded-2xl border border-red-500/20 mt-4">
          <div class="flex items-center justify-between mb-3"><h3 class="text-sm font-bold text-white">Storage Alerts</h3><span class="text-xs text-slate-500">Over used storage</span></div>
          <div class="space-y-2">${(stats.overUsedStorageUsers || []).map(u => `<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"><span class="text-red-400 font-bold">${escapeHtml(u.username)} — over used storage</span><span class="text-slate-400">${formatBytes(u.usedBytes)} / ${formatBytes(u.quotaBytes)} (+${formatBytes(u.overageBytes)})</span></div>`).join('') || '<div class="text-xs text-slate-500">No users are currently over quota.</div>'}</div>
        </div>
      `;
    } else if (AppState.adminTab === 'users') {
      const users = await apiRequest('/admin/users');
      AppState.adminUsers = users;
      area.innerHTML = `
        <div class="space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div><h3 class="text-sm font-bold text-white">User Management</h3><p class="text-xs text-slate-500 mt-1">Create users, change roles, manage storage and account status.</p></div>
            <button onclick="openCreateUserModal()" class="bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-2">
              <i data-lucide="user-plus" class="w-4 h-4"></i> Create New User
            </button>
          </div>
          <div class="glass-card rounded-2xl overflow-hidden border border-slate-800">
            <div class="admin-table-scroll"><div class="min-w-[1160px]">
              <div class="px-4 py-3 bg-slate-950/60 flex items-center text-xs font-semibold text-slate-400">
                <span class="w-12">ID</span><span class="flex-1">User</span><span class="w-32">Role</span><span class="w-44">Storage Quota</span><span class="w-28 text-center">Email</span><span class="w-28 text-center">Status</span><span class="w-44 text-right">Actions</span>
              </div>
              <div class="divide-y divide-slate-800/60">
                ${users.map(u => {
                  const isSelf = AppState.user && Number(u.id) === Number(AppState.user.id);
                  return `
                  <div class="px-4 py-3 flex items-center text-xs">
                    <span class="w-12 text-slate-500">#${u.id}</span>
                    <div class="flex-1 min-w-0"><div class="font-bold text-white truncate">${escapeHtml(u.name)} (${escapeHtml(u.username)}) ${isSelf ? '<span class="text-[10px] text-amber-400">YOU</span>' : ''}</div><div class="text-slate-400 truncate">${escapeHtml(u.email)}</div></div>
                    <div class="w-40">
                      <select ${isSelf ? 'disabled' : ''} onchange="changeUserRole('${u.id}', this.value)" class="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1.5 text-xs text-white ${isSelf ? 'opacity-50 cursor-not-allowed' : ''}">
                        <option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option>
                        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
                      </select>
                    </div>
                    <span class="w-44 ${u.isOverQuota ? 'text-red-400 font-bold' : 'text-slate-300'}">${u.isOverQuota ? 'Over used storage · ' : ''}${formatBytes(u.realUsedBytes)} / ${formatBytes(u.storage_quota_bytes)}</span>
                    <span class="w-28 text-center"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${u.email_verified ? 'bg-emerald-500/20 text-emerald-400' : 'bg-amber-500/20 text-amber-300'}">${u.email_verified ? 'Verified' : 'Not Verified'}</span></span>
                    <span class="w-28 text-center"><span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${u.is_suspended ? 'bg-red-500/20 text-red-400' : 'bg-emerald-500/20 text-emerald-400'}">${u.is_suspended ? 'Suspended' : 'Active'}</span></span>
                    <div class="w-44 text-right flex items-center justify-end gap-1">
                      <button onclick="openEditUserModal('${u.id}')" class="p-1.5 text-slate-400 hover:text-sky-400 rounded-lg" title="Edit User"><i data-lucide="pencil" class="w-4 h-4"></i></button>
                      <button onclick="editUserQuotaPrompt('${u.id}', '${u.storage_quota_bytes}')" class="p-1.5 text-slate-400 hover:text-amber-400 rounded-lg" title="Edit Storage Quota"><i data-lucide="hard-drive" class="w-4 h-4"></i></button>
                      <button onclick="toggleUserSuspend('${u.id}', ${u.is_suspended})" class="p-1.5 text-slate-400 hover:text-red-400 rounded-lg" title="Suspend/Unsuspend"><i data-lucide="${u.is_suspended ? 'check-circle' : 'ban'}" class="w-4 h-4"></i></button>
                      ${!isSelf ? `<button onclick="deleteUserPrompt('${u.id}', '${escapeHtml(u.username)}')" class="p-1.5 text-slate-400 hover:text-red-500 rounded-lg" title="Delete User"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
                    </div>
                  </div>`;
                }).join('')}
              </div>
            </div></div>
          </div>
        </div>
      `;
    } else if (AppState.adminTab === 'storage') {
      const data = await apiRequest('/admin/storage');
      const fsd = data.filesystem || {};
      const summary = data.summary || {};
      const pct = Math.min(100, Math.max(0, Number(fsd.usagePercent || 0)));
      const fmt = b => formatBytes(Number(b || 0));
      area.innerHTML = `
        <div class="space-y-4">
          <div class="flex items-center justify-between gap-3">
            <div><h3 class="text-sm font-bold text-white">Storage Overview</h3><p class="text-xs text-slate-500 mt-1">Real filesystem usage and independent user quota usage.</p></div>
            <button onclick="renderAdminSubTabContent()" class="bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-2 rounded-lg text-xs font-bold">Refresh</button>
          </div>
          <div class="glass-card p-5 rounded-2xl border border-slate-800">
            <div class="flex items-center justify-between mb-2"><span class="text-sm font-bold text-white">VPS Storage</span><span class="text-sm font-bold ${pct >= 90 ? 'text-red-400' : 'text-emerald-400'}">${pct.toFixed(1)}%</span></div>
            <div class="h-3 rounded-full bg-slate-900 overflow-hidden border border-slate-800"><div class="h-full ${pct >= 90 ? 'bg-red-500' : 'bg-amber-500'}" style="width:${pct}%"></div></div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 text-xs">
              <div><div class="text-slate-500">Total</div><div class="text-white font-bold mt-1">${fmt(fsd.totalBytes)}</div></div>
              <div><div class="text-slate-500">Used</div><div class="text-white font-bold mt-1">${fmt(fsd.usedBytes)}</div></div>
              <div><div class="text-slate-500">Free</div><div class="text-white font-bold mt-1">${fmt(fsd.freeBytes)}</div></div>
              <div><div class="text-slate-500">Available</div><div class="text-white font-bold mt-1">${fmt(fsd.availableBytes)}</div></div>
            </div>
          </div>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div class="glass-card p-4 rounded-xl border border-slate-800"><div class="text-xs text-slate-500">Total Users</div><div class="text-xl font-bold text-white mt-1">${summary.totalUsers || 0}</div></div>
            <div class="glass-card p-4 rounded-xl border border-slate-800"><div class="text-xs text-slate-500">Total Allocated</div><div class="text-xl font-bold text-white mt-1">${fmt(summary.totalAllocatedBytes)}</div></div>
            <div class="glass-card p-4 rounded-xl border border-slate-800"><div class="text-xs text-slate-500">Total User Used</div><div class="text-xl font-bold text-white mt-1">${fmt(summary.totalUsedBytes)}</div></div>
            <div class="glass-card p-4 rounded-xl border border-slate-800"><div class="text-xs text-slate-500">Total Remaining</div><div class="text-xl font-bold text-white mt-1">${fmt(summary.totalRemainingBytes)}</div></div>
          </div>
          <div class="glass-card rounded-2xl border border-slate-800 overflow-hidden">
            <div class="px-5 py-4 border-b border-slate-800"><h3 class="text-sm font-bold text-white">User Storage</h3><p class="text-xs text-slate-500 mt-1">Actual files versus configured quota.</p></div>
            <div class="admin-table-scroll"><table class="min-w-[1050px] w-full text-xs"><thead><tr class="text-left text-slate-500 border-b border-slate-800"><th class="p-3">User</th><th class="p-3">Email</th><th class="p-3">Role</th><th class="p-3">Allocated</th><th class="p-3">Used</th><th class="p-3">Remaining</th><th class="p-3">Usage</th><th class="p-3">Status</th></tr></thead><tbody class="divide-y divide-slate-800/60">
              ${(data.users || []).map(u => `<tr><td class="p-3 font-semibold text-white">${escapeHtml(u.username)}</td><td class="p-3 text-slate-400">${escapeHtml(u.email)}</td><td class="p-3 text-slate-300">${escapeHtml(u.role)}</td><td class="p-3">${fmt(u.allocatedBytes)}</td><td class="p-3 ${u.isOverQuota ? 'text-red-400 font-bold' : 'text-slate-200'}">${fmt(u.usedBytes)}${u.isOverQuota ? ` · Overused by ${fmt(u.overageBytes)}` : ''}</td><td class="p-3 text-slate-300">${fmt(u.remainingBytes)}</td><td class="p-3 ${u.isOverQuota ? 'text-red-400 font-bold' : 'text-slate-300'}">${Number(u.usagePercent || 0).toFixed(1)}%</td><td class="p-3">${escapeHtml(u.status)}</td></tr>`).join('') || '<tr><td colspan="8" class="p-8 text-center text-slate-500">No users found.</td></tr>'}
            </tbody></table></div>
          </div>
        </div>`;
    } else if (AppState.adminTab === 'download-monitor') {
      const result = await apiRequest('/admin/download-monitor-logs?limit=50&page=1');
      const logs = result.items || [];
      area.innerHTML = `
        <div class="glass-card rounded-2xl border border-slate-800 overflow-hidden">
          <div class="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-3"><div><h3 class="text-sm font-bold text-white">URL Download Monitoring</h3><p class="text-xs text-slate-500 mt-1">Download/share endpoint metadata only; file contents are never stored in logs.</p></div><div class="flex items-center gap-2"><span class="text-xs text-slate-500">${result.total || 0} records</span><button onclick="clearAdminLogs('download-monitor')" class="bg-red-600/15 hover:bg-red-600/25 text-red-300 border border-red-500/20 px-3 py-2 rounded-lg text-xs font-bold">Clear Logs</button></div></div>
          <div class="admin-table-scroll"><table class="min-w-[1500px] w-full text-xs"><thead><tr class="text-left text-slate-500 border-b border-slate-800"><th class="p-3">Time</th><th class="p-3">User</th><th class="p-3">IP</th><th class="p-3">File</th><th class="p-3">Size</th><th class="p-3">Endpoint</th><th class="p-3">Status</th><th class="p-3">HTTP</th><th class="p-3">Completed</th><th class="p-3">Error</th></tr></thead><tbody class="divide-y divide-slate-800/60">
          ${logs.map(l => `<tr><td class="p-3 text-slate-500 whitespace-nowrap">${new Date(l.started_at).toLocaleString()}</td><td class="p-3 text-slate-200">${escapeHtml(l.username || 'Public')}</td><td class="p-3 font-mono text-sky-300">${escapeHtml(l.ip_address || '—')}</td><td class="p-3 text-white">${escapeHtml(l.file_name || l.file_path || '—')}</td><td class="p-3 text-slate-300">${fmtBytesForAdmin(l.file_size_bytes)}</td><td class="p-3 text-slate-400 max-w-[350px] truncate" title="${escapeHtml(l.requested_url || '')}">${escapeHtml(l.endpoint || l.requested_url || '—')}</td><td class="p-3 ${l.status === 'completed' ? 'text-emerald-400' : l.status === 'failed' ? 'text-red-400' : 'text-amber-300'} font-semibold">${escapeHtml(l.status)}</td><td class="p-3">${escapeHtml(String(l.http_status || '—'))}</td><td class="p-3 text-slate-500">${l.completed_at ? new Date(l.completed_at).toLocaleString() : '—'}</td><td class="p-3 text-red-300 max-w-[300px] truncate">${escapeHtml(l.error || '—')}</td></tr>`).join('') || '<tr><td colspan="10" class="p-8 text-center text-slate-500">No download records found.</td></tr>'}
          </tbody></table></div>
        </div>`;
    } else if (AppState.adminTab === 'ip-history') {
      const historyResult = await apiRequest('/admin/ip-history?limit=50&page=1');
      const loginHistory = historyResult.items || [];
      area.innerHTML = `
        <div class="space-y-4">
          <div class="glass-card p-5 rounded-2xl border border-slate-800">
            <div class="flex items-center justify-between gap-3 mb-4"><div><h3 class="text-sm font-bold text-white">IP Tracking</h3><p class="text-xs text-slate-500 mt-1">Known registration/login IP addresses.</p></div><div class="flex items-center gap-2"><span class="text-xs text-slate-500">${historyResult.total || 0} records</span><button onclick="clearAdminLogs('ip-history')" class="bg-red-600/15 hover:bg-red-600/25 text-red-300 border border-red-500/20 px-3 py-2 rounded-lg text-xs font-bold">Clear Logs</button></div></div>
            <div class="admin-table-scroll"><table class="min-w-[820px] w-full text-xs"><thead><tr class="text-left text-slate-500 border-b border-slate-800"><th class="py-3 pr-3">User</th><th class="py-3 pr-3">IPv4</th><th class="py-3 pr-3">IPv6</th><th class="py-3 pr-3">Action</th><th class="py-3">Time</th></tr></thead><tbody class="divide-y divide-slate-800/60">
              ${loginHistory.map(r => `<tr><td class="py-3 pr-3"><div class="font-semibold text-slate-200">${escapeHtml(r.username)}</div><div class="text-slate-500">${escapeHtml(r.email)}</div></td><td class="py-3 pr-3 font-mono text-sky-300">${escapeHtml(r.ip_v4 || '—')}</td><td class="py-3 pr-3 font-mono text-cyan-300">${escapeHtml(r.ip_v6 || '—')}</td><td class="py-3 pr-3"><span class="px-2 py-1 rounded-md bg-slate-800 text-slate-300">${escapeHtml(r.action)}</span></td><td class="py-3 text-slate-500">${new Date(r.timestamp).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="5" class="py-8 text-center text-slate-500">No IP records found.</td></tr>'}
            </tbody></table></div>
          </div>
        </div>`;
    } else if (AppState.adminTab === 'smtp') {
      const smtp = await apiRequest('/admin/smtp');
      area.innerHTML = `
        <div class="max-w-xl glass-card p-6 rounded-2xl border border-slate-800 space-y-4">
          <h3 class="text-sm font-bold text-white border-b border-slate-800 pb-2">SMTP Server Settings</h3>
          <form onsubmit="handleSaveSmtp(event)" class="space-y-3 text-xs">
            <div><label class="block text-slate-400 mb-1">SMTP Host</label><input type="text" id="smtp-host" value="${escapeHtml(smtp.host)}" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white"></div>
            <div class="grid grid-cols-2 gap-3"><div><label class="block text-slate-400 mb-1">Port</label><input type="number" id="smtp-port" value="${smtp.port || 587}" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white"></div><div><label class="block text-slate-400 mb-1">Encryption</label><select id="smtp-enc" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white"><option value="STARTTLS" ${smtp.encryption === 'STARTTLS' ? 'selected' : ''}>STARTTLS</option><option value="SSL/TLS" ${smtp.encryption === 'SSL/TLS' ? 'selected' : ''}>SSL/TLS</option><option value="NONE" ${smtp.encryption === 'NONE' ? 'selected' : ''}>None</option></select></div></div>
            <div><label class="block text-slate-400 mb-1">Username</label><input type="text" id="smtp-user" value="${escapeHtml(smtp.username)}" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white"></div>
            <div><label class="block text-slate-400 mb-1">From Email</label><input type="email" id="smtp-from-email" value="${escapeHtml(smtp.from_email || smtp.username || '')}" placeholder="support@example.com" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white"><p class="text-[11px] text-slate-500 mt-1">For Zoho, use the same mailbox/domain address allowed to send mail.</p></div>
            <div><label class="block text-slate-400 mb-1">From Name</label><input type="text" id="smtp-from-name" value="${escapeHtml(smtp.from_name || '')}" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white"></div>
            <div><label class="block text-slate-400 mb-1">Password</label><input type="password" id="smtp-pass" placeholder="Leave blank to keep current password" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2 text-white"></div>
            <div class="flex flex-wrap gap-2 pt-2"><button type="submit" class="bg-amber-600 text-white font-bold px-4 py-2 rounded-lg">Save Settings</button><button type="button" onclick="testSmtpPrompt()" class="bg-slate-800 text-slate-300 font-bold px-4 py-2 rounded-lg">Send Test Email</button></div>
          </form>
        </div>`;
    } else if (AppState.adminTab === 'settings') {
      const settings = await apiRequest('/admin/settings');
      const enabled = String(settings.anti_multi_account_enabled) === 'true';
      const quotaGb = (parseInt(settings.default_storage_quota_bytes || '10737418240', 10) / 1073741824).toFixed(2);
      area.innerHTML = `
        <form onsubmit="handleSaveAppSettings(event)" class="max-w-2xl space-y-4">
          <div class="glass-card p-6 rounded-2xl border border-slate-800 space-y-4">
            <div><h3 class="text-sm font-bold text-white">Application Settings</h3><p class="text-xs text-slate-500 mt-1">Changes are stored in the database and used by the application.</p></div>
            <label class="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-900/60 border border-slate-800"><span><span class="block text-xs font-semibold text-white">Anti multi-account protection</span><span class="block text-[11px] text-slate-500 mt-1">Block registrations from a known IP.</span></span><input id="setting-anti-multi" type="checkbox" ${enabled ? 'checked' : ''} class="w-4 h-4 accent-sky-500"></label>
            <div class="grid sm:grid-cols-2 gap-4"><div><label class="block text-xs text-slate-400 mb-1">Application Name</label><input id="setting-app-name" value="${escapeHtml(settings.app_name || '')}" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div><div><label class="block text-xs text-slate-400 mb-1">Website Title</label><input id="setting-website-title" value="${escapeHtml(settings.website_title || settings.app_name || '')}" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div></div>
            <div><label class="block text-xs text-slate-400 mb-1">Application URL</label><input id="setting-app-url" value="${escapeHtml(settings.app_url || '')}" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
            <div class="flex flex-wrap items-center gap-4 p-3 rounded-xl bg-slate-950/50 border border-slate-800"><div class="w-12 h-12 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center overflow-hidden shrink-0">${settings.website_icon_url ? `<img src="${escapeHtml(settings.website_icon_url)}" alt="Website icon" class="w-full h-full object-contain">` : '<i data-lucide="image" class="w-5 h-5 text-slate-500"></i>'}</div><div class="flex-1 min-w-[180px]"><div class="text-sm font-semibold text-white">Website Icon</div><div class="text-xs text-slate-500 mt-1">PNG, JPG, WEBP, GIF or ICO, maximum 2 MB.</div></div><input id="setting-website-icon-file" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon,.ico" class="hidden" onchange="uploadWebsiteIcon(event)"><button type="button" onclick="document.getElementById('setting-website-icon-file').click()" class="bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold px-4 py-2 rounded-lg text-xs">Upload Icon</button></div>
            <div class="grid sm:grid-cols-3 gap-4"><div><label class="block text-xs text-slate-400 mb-1">Default Storage (GB)</label><input id="setting-quota-gb" type="number" min="1" step="0.01" value="${quotaGb}" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div><div><label class="block text-xs text-slate-400 mb-1">Max Share Links/User</label><input id="setting-max-shares" type="number" min="1" value="${escapeHtml(settings.max_share_links_per_user || '3')}" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div><div><label class="block text-xs text-slate-400 mb-1">Session Timeout (Hours)</label><input id="setting-timeout" type="number" min="1" value="${escapeHtml(settings.session_timeout_hours || '24')}" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div></div>
            <button type="submit" class="bg-amber-600 hover:bg-amber-500 text-white font-bold px-4 py-2.5 rounded-lg">Save Application Settings</button>
          </div>
        </form>`;
    } else if (AppState.adminTab === 'details') {
      const settings = await apiRequest('/admin/settings');
      area.innerHTML = `
        <form onsubmit="handleSaveAdminDetails(event)" class="max-w-2xl space-y-4">
          <div class="glass-card p-6 rounded-2xl border border-slate-800 space-y-4">
            <div><h3 class="text-sm font-bold text-white">Details</h3><p class="text-xs text-slate-500 mt-1">Control which contact details appear on the user dashboard.</p></div>
            <label class="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-900/60 border border-slate-800"><span><span class="block text-xs font-semibold text-white">Show Discord section</span><span class="block text-[11px] text-slate-500 mt-1">Show the Discord logo and Join button on the dashboard.</span></span><input id="details-discord-enabled" type="checkbox" ${String(settings.discord_enabled) === 'true' ? 'checked' : ''} class="w-4 h-4 accent-sky-500"></label>
            <div><label class="block text-xs text-slate-400 mb-1">Discord Join Link</label><input id="details-discord-url" type="url" value="${escapeHtml(settings.discord_join_url || '')}" placeholder="https://discord.gg/yourserver" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
            <label class="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-900/60 border border-slate-800"><span><span class="block text-xs font-semibold text-white">Show Contact Email</span><span class="block text-[11px] text-slate-500 mt-1">Show a contact email card on the dashboard.</span></span><input id="details-contact-enabled" type="checkbox" ${String(settings.contact_email_enabled) === 'true' ? 'checked' : ''} class="w-4 h-4 accent-sky-500"></label>
            <div><label class="block text-xs text-slate-400 mb-1">Contact Email</label><input id="details-contact-email" type="email" value="${escapeHtml(settings.contact_email || '')}" placeholder="support@example.com" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
            <button type="submit" class="bg-amber-600 hover:bg-amber-500 text-white font-bold px-4 py-2.5 rounded-lg">Save Details</button>
          </div>
        </form>`;
    } else if (AppState.adminTab === 'audit-logs') {
      const auditResult = await apiRequest('/admin/audit-logs?limit=50&page=1');
      const logs = auditResult.items || [];
      area.innerHTML = `
        <div class="glass-card rounded-2xl border border-slate-800 overflow-hidden">
          <div class="px-5 py-4 border-b border-slate-800 flex items-center justify-between"><div><h3 class="text-sm font-bold text-white">Audit Logs</h3><p class="text-xs text-slate-500 mt-1">Recent administrative and user actions.</p></div><div class="flex items-center gap-2"><span class="text-xs text-slate-500">${auditResult.total || 0} records</span><button onclick="clearAdminLogs('audit-logs')" class="bg-red-600/15 hover:bg-red-600/25 text-red-300 border border-red-500/20 px-3 py-2 rounded-lg text-xs font-bold">Clear Logs</button></div></div>
          <div class="admin-table-scroll"><table class="min-w-[900px] w-full text-xs"><thead><tr class="text-left text-slate-500 border-b border-slate-800"><th class="p-3">Time</th><th class="p-3">User</th><th class="p-3">Action</th><th class="p-3">IP</th><th class="p-3">Details</th></tr></thead><tbody class="divide-y divide-slate-800/60">
            ${logs.map(log => `<tr><td class="p-3 text-slate-500 whitespace-nowrap">${new Date(log.timestamp).toLocaleString()}</td><td class="p-3 text-slate-200">${escapeHtml(log.username || 'System')}</td><td class="p-3"><span class="px-2 py-1 rounded-md bg-amber-500/10 text-amber-300">${escapeHtml(log.action)}</span></td><td class="p-3 font-mono text-sky-300">${escapeHtml(log.ip_address || '—')}</td><td class="p-3 text-slate-400 max-w-[420px] truncate" title="${escapeHtml(log.details || '')}">${escapeHtml(log.details || '—')}</td></tr>`).join('') || '<tr><td colspan="5" class="p-8 text-center text-slate-500">No audit logs found.</td></tr>'}
          </tbody></table></div>
        </div>`;
    } else {
      area.innerHTML = '<div class="glass-card p-6 rounded-2xl border border-slate-800 text-sm text-slate-500">This admin section is not available yet.</div>';
    }
  } catch (err) {
    area.innerHTML = `<div class="glass-card p-6 rounded-2xl border border-red-500/20 bg-red-500/5"><div class="text-sm font-semibold text-red-300">Failed to load this admin section</div><div class="text-xs text-slate-400 mt-2">${escapeHtml(err.message)}</div><button onclick="renderAdminSubTabContent()" class="mt-4 px-3 py-2 rounded-lg bg-slate-800 text-slate-200 text-xs font-semibold">Retry</button></div>`;
  }

  if (window.lucide) lucide.createIcons();
}

function fmtBytesForAdmin(value) {
  const n = Number(value || 0);
  if (!n) return '—';
  return formatBytes(n);
}

async function clearAdminLogs(type) {
  const messages = {
    'audit-logs': 'Are you sure you want to permanently clear all audit logs? This action cannot be undone.',
    'ip-history': 'Are you sure you want to permanently clear all IP tracking logs? This action cannot be undone.',
    'download-monitor': 'Are you sure you want to permanently clear all URL download monitoring logs? This action cannot be undone.'
  };
  const endpoints = {
    'audit-logs': '/admin/audit-logs',
    'ip-history': '/admin/ip-history',
    'download-monitor': '/admin/download-monitor-logs'
  };
  if (!confirm(messages[type])) return;
  try {
    await apiRequest(endpoints[type], { method: 'DELETE' });
    showToast('Logs cleared successfully.', 'success');
    await renderAdminSubTabContent();
  } catch (err) {
    showToast(err.message || 'Failed to clear logs.', 'error');
  }
}

async function uploadWebsiteIcon(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) return showToast('Please select an image file.', 'error');
  if (file.size > 2 * 1024 * 1024) return showToast('Website icon must be 2 MB or smaller.', 'error');

  const formData = new FormData();
  formData.append('icon', file);
  try {
    const result = await apiRequest('/admin/settings/icon', { method: 'POST', body: formData });
    showToast('Website icon uploaded!', 'success');
    applyWebsiteBranding(result.iconUrl, document.getElementById('setting-website-title')?.value.trim());
    await renderAdminSubTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function applyWebsiteBranding(iconUrl, title) {
  if (title) document.title = title;
  if (iconUrl) {
    let link = document.querySelector('link[data-site-favicon]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.dataset.siteFavicon = 'true';
      document.head.appendChild(link);
    }
    link.href = `${iconUrl}?v=${Date.now()}`;
  }
}

async function handleSaveAppSettings(e) {
  e.preventDefault();
  const quotaGb = parseFloat(document.getElementById('setting-quota-gb')?.value || '0');
  if (!(quotaGb > 0)) return showToast('Storage quota must be greater than 0.', 'error');

  try {
    await apiRequest('/admin/settings', {
      method: 'POST',
      body: {
        anti_multi_account_enabled: document.getElementById('setting-anti-multi').checked ? 'true' : 'false',
        default_storage_quota_bytes: String(Math.round(quotaGb * 1073741824)),
        max_share_links_per_user: String(Math.max(1, parseInt(document.getElementById('setting-max-shares').value || '1', 10))),
        app_name: document.getElementById('setting-app-name').value.trim(),
        website_title: document.getElementById('setting-website-title').value.trim(),
        app_url: document.getElementById('setting-app-url').value.trim(),
        session_timeout_hours: String(Math.max(1, parseInt(document.getElementById('setting-timeout').value || '24', 10)))
      }
    });
    applyWebsiteBranding(null, document.getElementById('setting-website-title').value.trim());
    showToast('Application settings saved!', 'success');
    renderAdminSubTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderTerminalConsole(container) {
  container.innerHTML = `
    <div class="glass-card p-4 rounded-2xl border border-slate-800 space-y-3">
      <div class="flex items-center justify-between">
        <h3 class="text-sm font-bold text-white flex items-center gap-2">
          <i data-lucide="terminal" class="w-4 h-4 text-emerald-400"></i> VPS SSH Terminal Session
        </h3>
        <span class="text-xs text-emerald-400 font-mono flex items-center gap-1">
          <span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span> Live PTY Connected
        </span>
      </div>

      <!-- Xterm Terminal Wrapper Container -->
      <div id="terminal-container" class="w-full h-96 bg-black rounded-xl p-2 border border-slate-800 overflow-hidden"></div>
    </div>
  `;

  setTimeout(() => {
    initXtermTerminal();
  }, 100);
}

function initXtermTerminal() {
  const container = document.getElementById('terminal-container');
  if (!container || !window.Terminal) return;

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    theme: {
      background: '#000000',
      foreground: '#f8fafc'
    }
  });

  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  fitAddon.fit();

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/api/admin/console?token=${AppState.token}`;
  const ws = new WebSocket(wsUrl);

  ws.onmessage = (event) => term.write(event.data);
  term.onData((data) => ws.readyState === WebSocket.OPEN && ws.send(data));

  window.addEventListener('resize', () => fitAddon.fit());
}

function openCreateUserModal() {
  const existing = document.getElementById('create-user-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'create-user-modal';
  modal.className = 'fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="w-full max-w-lg glass-card rounded-2xl border border-slate-700 shadow-2xl p-6">
      <div class="flex items-center justify-between mb-5"><div><h3 class="text-base font-bold text-white">Create New User</h3><p class="text-xs text-slate-500 mt-1">Create a normal user or a new administrator account.</p></div><button type="button" onclick="document.getElementById('create-user-modal')?.remove()" class="text-slate-400 hover:text-white"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <form onsubmit="handleCreateUser(event)" class="space-y-3">
        <div class="grid sm:grid-cols-2 gap-3">
          <div><label class="block text-xs text-slate-400 mb-1">Full Name</label><input id="create-user-name" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
          <div><label class="block text-xs text-slate-400 mb-1">Username</label><input id="create-user-username" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
        </div>
        <div><label class="block text-xs text-slate-400 mb-1">Email</label><input id="create-user-email" type="email" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
        <div class="grid sm:grid-cols-2 gap-3">
          <div><label class="block text-xs text-slate-400 mb-1">Password</label><input id="create-user-password" type="password" minlength="6" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
          <div><label class="block text-xs text-slate-400 mb-1">Role</label><select id="create-user-role" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"><option value="user">User</option><option value="admin">Admin</option></select></div>
        </div>
        <div><label class="block text-xs text-slate-400 mb-1">Storage Quota (GB)</label><input id="create-user-quota" type="number" min="0.01" step="0.01" value="10" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
        <div class="flex justify-end gap-2 pt-3"><button type="button" onclick="document.getElementById('create-user-modal')?.remove()" class="px-4 py-2.5 rounded-lg bg-slate-800 text-slate-300 text-xs font-bold">Cancel</button><button type="submit" class="px-4 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold">Create User</button></div>
      </form>
    </div>`;
  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();
}

async function handleCreateUser(e) {
  e.preventDefault();
  const quotaGb = parseFloat(document.getElementById('create-user-quota')?.value || '0');
  if (!(quotaGb > 0)) return showToast('Storage quota must be greater than 0.', 'error');
  try {
    await apiRequest('/admin/users', {
      method: 'POST',
      body: {
        name: document.getElementById('create-user-name').value.trim(),
        username: document.getElementById('create-user-username').value.trim(),
        email: document.getElementById('create-user-email').value.trim(),
        password: document.getElementById('create-user-password').value,
        role: document.getElementById('create-user-role').value,
        storageQuotaBytes: Math.round(quotaGb * 1073741824)
      }
    });
    document.getElementById('create-user-modal')?.remove();
    showToast('User created successfully.', 'success');
    await renderAdminSubTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openEditUserModal(userId) {
  const user = (AppState.adminUsers || []).find(u => Number(u.id) === Number(userId));
  if (!user) return showToast('User details could not be found.', 'error');

  document.getElementById('edit-user-modal')?.remove();
  const isSelf = AppState.user && Number(AppState.user.id) === Number(user.id);
  const modal = document.createElement('div');
  modal.id = 'edit-user-modal';
  modal.className = 'fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="w-full max-w-lg glass-card rounded-2xl border border-slate-700 shadow-2xl p-6 max-h-[90vh] overflow-y-auto">
      <div class="flex items-center justify-between mb-5"><div><h3 class="text-base font-bold text-white">Edit User</h3><p class="text-xs text-slate-500 mt-1">Update name, username, email, password, role and storage.</p></div><button type="button" onclick="document.getElementById('edit-user-modal')?.remove()" class="text-slate-400 hover:text-white"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <form onsubmit="handleEditUser(event, ${Number(user.id)})" class="space-y-3">
        <div class="grid sm:grid-cols-2 gap-3"><div><label class="block text-xs text-slate-400 mb-1">Full Name</label><input id="edit-user-name" value="${escapeHtml(user.name)}" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div><div><label class="block text-xs text-slate-400 mb-1">Username</label><input id="edit-user-username" value="${escapeHtml(user.username)}" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div></div>
        <div><label class="block text-xs text-slate-400 mb-1">Email</label><input id="edit-user-email" type="email" value="${escapeHtml(user.email)}" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
        <div class="grid sm:grid-cols-2 gap-3"><div><label class="block text-xs text-slate-400 mb-1">New Password</label><input id="edit-user-password" type="password" minlength="6" placeholder="Leave blank to keep current" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div><div><label class="block text-xs text-slate-400 mb-1">Role</label><select id="edit-user-role" ${isSelf ? 'disabled' : ''} class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"><option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option></select></div></div>
        <div><label class="block text-xs text-slate-400 mb-1">Storage Quota (GB)</label><input id="edit-user-quota" type="number" min="0.01" step="0.01" value="${(Number(user.storage_quota_bytes || 0) / 1073741824).toFixed(2)}" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
        <div class="flex justify-end gap-2 pt-3"><button type="button" onclick="document.getElementById('edit-user-modal')?.remove()" class="px-4 py-2.5 rounded-lg bg-slate-800 text-slate-300 text-xs font-bold">Cancel</button><button type="submit" class="px-4 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-xs font-bold">Save Changes</button></div>
      </form>
    </div>`;
  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();
}

async function handleEditUser(e, userId) {
  e.preventDefault();
  const quotaGb = parseFloat(document.getElementById('edit-user-quota')?.value || '0');
  if (!(quotaGb > 0)) return showToast('Storage quota must be greater than 0.', 'error');

  const password = document.getElementById('edit-user-password').value;
  const body = {
    name: document.getElementById('edit-user-name').value.trim(),
    username: document.getElementById('edit-user-username').value.trim(),
    email: document.getElementById('edit-user-email').value.trim(),
    storageQuotaBytes: Math.round(quotaGb * 1073741824)
  };
  if (AppState.user && Number(AppState.user.id) !== Number(userId)) body.role = document.getElementById('edit-user-role').value;
  if (password) body.newPassword = password;

  try {
    await apiRequest(`/admin/users/${userId}`, { method: 'PUT', body });
    document.getElementById('edit-user-modal')?.remove();
    showToast('User updated successfully.', 'success');
    await renderAdminSubTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function changeUserRole(userId, role) {
  try {
    await apiRequest(`/admin/users/${userId}`, { method: 'PUT', body: { role } });
    showToast(`User role changed to ${role}.`, 'success');
    await renderAdminSubTabContent();
  } catch (err) {
    showToast(err.message, 'error');
    await renderAdminSubTabContent();
  }
}

async function deleteUserPrompt(userId, username) {
  if (!confirm(`Delete user @${username} and all of their stored files? This cannot be undone.`)) return;
  try {
    await apiRequest(`/admin/users/${userId}`, { method: 'DELETE' });
    showToast('User deleted successfully.', 'success');
    await renderAdminSubTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function editUserQuotaPrompt(userId, currentQuota) {
  const gbStr = prompt('Enter new storage quota in GB:', (parseInt(currentQuota, 10) / 1073741824).toFixed(0));
  if (!gbStr) return;

  const bytes = parseInt(gbStr, 10) * 1073741824;
  apiRequest(`/admin/users/${userId}`, {
    method: 'PUT',
    body: { storageQuotaBytes: bytes }
  })
  .then(() => {
    showToast('Storage quota updated!', 'success');
    renderAdminSubTabContent();
  })
  .catch(err => showToast(err.message, 'error'));
}

function toggleUserSuspend(userId, currentStatus) {
  apiRequest(`/admin/users/${userId}`, {
    method: 'PUT',
    body: { isSuspended: !currentStatus }
  })
  .then(() => {
    showToast('User status updated!', 'success');
    renderAdminSubTabContent();
  })
  .catch(err => showToast(err.message, 'error'));
}

async function handleSaveAdminDetails(e) {
  e.preventDefault();
  const discordEnabled = document.getElementById('details-discord-enabled')?.checked;
  const discordUrl = document.getElementById('details-discord-url')?.value.trim() || '';
  const contactEnabled = document.getElementById('details-contact-enabled')?.checked;
  const contactEmail = document.getElementById('details-contact-email')?.value.trim() || '';
  if (discordEnabled && !discordUrl) return showToast('Enter a Discord join link or turn off the Discord checkbox.', 'error');
  if (contactEnabled && !contactEmail) return showToast('Enter a contact email or turn off the Contact Email checkbox.', 'error');
  try {
    await apiRequest('/admin/settings', {
      method: 'POST',
      body: {
        discord_enabled: discordEnabled ? 'true' : 'false',
        discord_join_url: discordUrl,
        contact_email_enabled: contactEnabled ? 'true' : 'false',
        contact_email: contactEmail
      }
    });
    showToast('Details saved successfully.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleSaveSmtp(e) {
  e.preventDefault();
  const host = document.getElementById('smtp-host').value;
  const port = document.getElementById('smtp-port').value;
  const encryption = document.getElementById('smtp-enc').value;
  const username = document.getElementById('smtp-user').value;
  const password = document.getElementById('smtp-pass').value;
  const fromEmail = document.getElementById('smtp-from-email').value.trim();
  const fromName = document.getElementById('smtp-from-name').value.trim();

  try {
    await apiRequest('/admin/smtp', {
      method: 'POST',
      body: { host, port, encryption, username, password, fromEmail, fromName }
    });
    showToast('SMTP settings saved!', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function testSmtpPrompt() {
  const email = prompt('Enter email address to send test message:');
  if (!email) return;

  apiRequest('/admin/smtp/test', {
    method: 'POST',
    body: { testEmail: email }
  })
  .then(res => showToast(res.message, 'success'))
  .catch(err => showToast(err.message, 'error'));
}

// Initial Boot Call
window.addEventListener('DOMContentLoaded', async () => {
  await loadPublicBranding();
  renderApp();
});
