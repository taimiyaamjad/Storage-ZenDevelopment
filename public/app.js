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
  currentTab: 'dashboard', // Default to 'dashboard' on first open
  otpSessionData: null,
  searchQuery: '',
  theme: localStorage.getItem('vps_theme') || 'dark',
  isDarkMode: (localStorage.getItem('vps_theme') || 'dark') === 'dark',
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
  displayedQuotaPercent: 0,
  targetUserId: null,
  targetUser: null,
  directoryUserList: [],
  consoleMode: 'auto'
};

// Sync HTML theme immediately
document.documentElement.classList.toggle('dark', AppState.isDarkMode);
document.documentElement.classList.toggle('light', !AppState.isDarkMode);

// Global Toast Notification Helper
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container') || createToastContainer();
  const toast = document.createElement('div');
  const bgClass = type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-emerald-600' : 'bg-neutral-900 border border-white/20';
  
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

// Global Loading Indicator Handler
function setLoading(message = '', show = true) {
  const globalLoader = document.getElementById('global-loading-indicator');
  if (globalLoader) {
    globalLoader.classList.toggle('hidden', !show);
    const textEl = globalLoader.querySelector('[data-loading-text]');
    if (textEl && message) textEl.textContent = message;
  }
}
window.setLoading = setLoading;

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
  // If logged in as admin and inspecting a target user directory, pass target user header for file API requests
  if (AppState.user && AppState.user.role === 'admin' && AppState.targetUserId && endpoint.startsWith('/files')) {
    headers['x-target-user-id'] = String(AppState.targetUserId);
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
      if (data.requiresOtpVerification) {
        AppState.otpSessionData = data;
        window.location.hash = '#otp-verification';
        renderApp();
      }
      if (res.status === 401 && AppState.token) {
        logoutUser();
        showToast('Session expired. Please log in again.', 'error');
      }
      const err = new Error(data.error || 'API Request failed');
      if (data.requiresOtpVerification) err.requiresOtpVerification = true;
      throw err;
    }
    return data;
  } catch (err) {
    throw err;
  }
}

function getEffectiveDownloadUrl(filePath) {
  let url = `/api/files/download?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(AppState.token || '')}`;
  if (AppState.user && AppState.user.role === 'admin' && AppState.targetUserId) {
    url += `&targetUserId=${encodeURIComponent(AppState.targetUserId)}`;
  }
  return url;
}

function getEffectivePreviewUrl(filePath, extra = '') {
  let url = `/api/files/preview?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(AppState.token || '')}`;
  if (AppState.user && AppState.user.role === 'admin' && AppState.targetUserId) {
    url += `&targetUserId=${encodeURIComponent(AppState.targetUserId)}`;
  }
  if (extra) url += extra;
  return url;
}

function getEffectiveTranscodedUrl(filePath, safe = false) {
  let url = `/api/files/preview-transcoded?path=${encodeURIComponent(filePath)}&token=${encodeURIComponent(AppState.token || '')}`;
  if (AppState.user && AppState.user.role === 'admin' && AppState.targetUserId) {
    url += `&targetUserId=${encodeURIComponent(AppState.targetUserId)}`;
  }
  if (safe) url += '&safe=1';
  return url;
}

async function inspectUserDirectory(userId, username) {
  AppState.targetUserId = Number(userId);
  AppState.targetUser = (AppState.adminUsers || []).find(u => Number(u.id) === Number(userId)) || { id: userId, username };
  AppState.currentPath = '/';
  AppState.selectedPaths = [];
  showToast(`Switching to directory for ${username}...`, 'info');
  navigateTab('files');
}

function resetAdminUserDirectory() {
  AppState.targetUserId = null;
  AppState.targetUser = null;
  AppState.currentPath = '/';
  AppState.selectedPaths = [];
  showToast('Returned to your personal storage directory.', 'info');
  navigateTab('files');
}

async function handleAdminUserDirectoryChange(targetVal) {
  if (!targetVal) {
    resetAdminUserDirectory();
  } else {
    const userId = Number(targetVal);
    const users = AppState.directoryUserList || AppState.adminUsers || [];
    const targetUser = users.find(u => Number(u.id) === userId) || { id: userId, username: `User #${userId}` };
    inspectUserDirectory(userId, targetUser.username || targetUser.name);
  }
}

async function loadAdminUserDirectoryDropdown() {
  const select = document.getElementById('admin-user-directory-select');
  if (!select) return;
  try {
    const users = await apiRequest('/files/admin/user-directories');
    AppState.directoryUserList = users;
    let html = `<option value="">📁 My Storage (Self - ${escapeHtml(AppState.user?.username || 'admin')})</option>`;
    users.forEach(u => {
      const isCurrentAdmin = Number(u.id) === Number(AppState.user?.id);
      if (isCurrentAdmin) return;
      const isSelected = AppState.targetUserId && Number(AppState.targetUserId) === Number(u.id);
      const displayName = u.name && u.name !== u.username ? `${escapeHtml(u.username)} (${escapeHtml(u.name)})` : escapeHtml(u.username);
      html += `<option value="${u.id}" ${isSelected ? 'selected' : ''}>👤 ${displayName} · ${formatBytes(u.used_storage_bytes || 0)}</option>`;
    });
    select.innerHTML = html;
  } catch (e) {
    console.error('Failed to load user directories dropdown:', e);
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
  const hash = window.location.hash || '';
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

  // OTP Verification view should ONLY be rendered if there is an active OTP pending for the user:
  const userNeedsOtp = (AppState.user && Number(AppState.user.requires_otp_verification) === 1) ||
                       (AppState.otpSessionData && (AppState.otpSessionData.requiresOtp || AppState.otpSessionData.tempToken));

  if (userNeedsOtp) {
    renderOtpVerificationView(root);
    return;
  } else if (hash.startsWith('#otp-verification')) {
    // If URL has #otp-verification but user is already verified / does not need OTP, clear the stale hash
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } else {
      window.location.hash = '';
    }
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

// ==========================================
// 1a. BEAUTIFUL ANIMATED 4-DIGIT OTP SECURITY VERIFICATION VIEW
// ==========================================
async function renderOtpVerificationView(root) {
  const otpData = AppState.otpSessionData || {};
  const emailDisplay = otpData.email || AppState.user?.email || 'your registered email';
  const reasonDisplay = otpData.reason || (AppState.user && AppState.user.otp_reason) || 'Account Security Review';

  root.innerHTML = `
    <div class="h-full min-h-full overflow-y-auto flex flex-col items-center justify-center p-4 theme-main-bg transition-colors duration-200 custom-scrollbar select-none">
      
      <!-- Top Theme Switcher on OTP Screen -->
      <div class="w-full max-w-md flex justify-end mb-3">
        <button onclick="toggleDarkMode()" title="Toggle Light / Dark Theme" class="px-3 py-1.5 flex items-center gap-2 text-xs font-semibold rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-black dark:hover:border-white shadow-sm transition-all">
          <i data-lucide="${AppState.isDarkMode ? 'sun' : 'moon'}" class="w-3.5 h-3.5 text-amber-500 dark:text-white"></i>
          <span>${AppState.isDarkMode ? 'Light Mode' : 'Dark Mode'}</span>
        </button>
      </div>

      <div class="w-full max-w-md pitch-card p-8 rounded-3xl shadow-2xl border border-slate-200 dark:border-neutral-800 tab-pane-enter my-auto text-center relative overflow-hidden">
        
        <!-- Header Shield Icon -->
        <div class="inline-flex p-3.5 rounded-2xl zencloud-logo-badge mb-3 shadow-xl">
          <i data-lucide="shield-check" class="w-8 h-8"></i>
        </div>

        <h1 class="text-2xl font-extrabold text-slate-900 dark:text-white tracking-tight">
          Security Verification
        </h1>
        <p class="text-xs text-slate-600 dark:text-slate-400 mt-1.5 leading-relaxed max-w-xs mx-auto">
          Your account was placed under verification. We sent a 4-digit code to <b class="text-slate-900 dark:text-white font-mono font-semibold">${escapeHtml(emailDisplay)}</b>.
        </p>

        ${reasonDisplay ? `
          <div class="mt-3 mb-1 px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-600 dark:text-amber-300 text-[11px] font-medium inline-block max-w-full truncate" title="${escapeHtml(reasonDisplay)}">
            <span class="font-bold uppercase tracking-wider text-[10px]">Reason:</span> ${escapeHtml(reasonDisplay)}
          </div>
        ` : ''}

        <!-- Dynamic Error / Alert Banner Above the 4 Boxes -->
        <div id="otp-error-container" class="min-h-[28px] mt-3 mb-1"></div>

        <!-- 4-Digit Rotating / Merging Arena -->
        <div id="otp-arena" class="otp-stage-container w-full max-w-[280px] mx-auto h-24 flex items-center justify-center gap-3 relative my-2">
          
          <div id="otp-slot-0" class="otp-box-slot">
            <input type="text" maxlength="1" inputmode="numeric" autocomplete="one-time-code" id="otp-digit-0" class="otp-input-element w-[54px] h-[62px] rounded-2xl text-2xl font-mono font-extrabold text-center bg-slate-50 dark:bg-black text-slate-900 dark:text-white border-2 border-slate-300 dark:border-white/25 focus:border-black dark:focus:border-white focus:outline-none shadow-md" data-idx="0">
          </div>

          <div id="otp-slot-1" class="otp-box-slot">
            <input type="text" maxlength="1" inputmode="numeric" id="otp-digit-1" class="otp-input-element w-[54px] h-[62px] rounded-2xl text-2xl font-mono font-extrabold text-center bg-slate-50 dark:bg-black text-slate-900 dark:text-white border-2 border-slate-300 dark:border-white/25 focus:border-black dark:focus:border-white focus:outline-none shadow-md" data-idx="1">
          </div>

          <div id="otp-slot-2" class="otp-box-slot">
            <input type="text" maxlength="1" inputmode="numeric" id="otp-digit-2" class="otp-input-element w-[54px] h-[62px] rounded-2xl text-2xl font-mono font-extrabold text-center bg-slate-50 dark:bg-black text-slate-900 dark:text-white border-2 border-slate-300 dark:border-white/25 focus:border-black dark:focus:border-white focus:outline-none shadow-md" data-idx="2">
          </div>

          <div id="otp-slot-3" class="otp-box-slot">
            <input type="text" maxlength="1" inputmode="numeric" id="otp-digit-3" class="otp-input-element w-[54px] h-[62px] rounded-2xl text-2xl font-mono font-extrabold text-center bg-slate-50 dark:bg-black text-slate-900 dark:text-white border-2 border-slate-300 dark:border-white/25 focus:border-black dark:focus:border-white focus:outline-none shadow-md" data-idx="3">
          </div>

          <!-- Central Fusion Tick Core (Merged Circle with Tick Sign) -->
          <div id="otp-fusion-core" class="otp-fusion-core bg-white text-black shadow-2xl">
            <svg class="w-8 h-8 text-black stroke-[3.5]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
        </div>

        <!-- Success Message Placeholder -->
        <div id="otp-success-container" class="min-h-[20px]"></div>

        <!-- Action Buttons -->
        <div class="mt-4 space-y-3">
          <button id="otp-continue-btn" onclick="triggerOtpVerificationSubmit()" class="w-full zencloud-btn-primary bg-white hover:bg-neutral-200 text-black font-bold py-3 rounded-xl text-sm shadow-lg shadow-white/20 transition-all flex items-center justify-center gap-2">
            <span>Continue</span>
            <i data-lucide="arrow-right" class="w-4 h-4"></i>
          </button>

          <div class="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 pt-1">
            <button id="otp-resend-btn" onclick="handleOtpResend()" class="hover:text-black dark:hover:text-white transition-colors underline">
              Resend OTP Code
            </button>
            <button onclick="cancelOtpAndLogout()" class="hover:text-red-500 transition-colors">
              Back to Login
            </button>
          </div>
        </div>

      </div>
    </div>
  `;

  if (window.lucide) lucide.createIcons();

  setupOtpInputHandlers();
}

function setupOtpInputHandlers() {
  const inputs = [0, 1, 2, 3].map(i => document.getElementById(`otp-digit-${i}`)).filter(Boolean);
  if (inputs.length < 4) return;

  // Auto focus first input
  setTimeout(() => inputs[0]?.focus(), 100);

  inputs.forEach((input, idx) => {
    input.addEventListener('input', (e) => {
      const val = e.target.value.replace(/\D/g, '');
      e.target.value = val ? val.slice(-1) : '';

      // Clear any existing error state
      document.getElementById('otp-error-container').innerHTML = '';
      inputs.forEach(inp => inp.classList.remove('border-red-500', 'otp-error-shake'));

      if (e.target.value && idx < 3) {
        inputs[idx + 1].focus();
      }

      // If all 4 boxes have digits, trigger verification automatically
      const fullOtp = inputs.map(i => i.value).join('');
      if (fullOtp.length === 4) {
        triggerOtpVerificationSubmit();
      }
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace') {
        if (!e.target.value && idx > 0) {
          inputs[idx - 1].focus();
          inputs[idx - 1].value = '';
        }
      } else if (e.key === 'ArrowLeft' && idx > 0) {
        inputs[idx - 1].focus();
      } else if (e.key === 'ArrowRight' && idx < 3) {
        inputs[idx + 1].focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        triggerOtpVerificationSubmit();
      }
    });

    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasteData = (e.clipboardData || window.clipboardData).getData('text');
      const cleanDigits = pasteData.replace(/\D/g, '').slice(0, 4);
      if (!cleanDigits) return;

      for (let i = 0; i < cleanDigits.length; i++) {
        if (inputs[i]) inputs[i].value = cleanDigits[i];
      }
      if (cleanDigits.length < 4 && inputs[cleanDigits.length]) {
        inputs[cleanDigits.length].focus();
      } else if (cleanDigits.length === 4) {
        inputs[3].focus();
        triggerOtpVerificationSubmit();
      }
    });
  });
}

let isOtpVerifying = false;
async function triggerOtpVerificationSubmit() {
  if (isOtpVerifying) return;

  const inputs = [0, 1, 2, 3].map(i => document.getElementById(`otp-digit-${i}`)).filter(Boolean);
  const otpCode = inputs.map(i => (i ? i.value.trim() : '')).join('');

  const errorContainer = document.getElementById('otp-error-container');
  const continueBtn = document.getElementById('otp-continue-btn');
  const fusionCore = document.getElementById('otp-fusion-core');

  if (otpCode.length !== 4) {
    if (errorContainer) {
      errorContainer.innerHTML = `
        <div class="text-red-400 bg-red-500/10 border border-red-500/25 px-3 py-1.5 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 animate-slide-down">
          <i data-lucide="alert-circle" class="w-4 h-4 text-red-400 shrink-0"></i>
          <span>Please enter all 4 verification digits.</span>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
    }
    const emptyIdx = inputs.findIndex(i => !i.value);
    if (emptyIdx >= 0 && inputs[emptyIdx]) inputs[emptyIdx].focus();
    return;
  }

  isOtpVerifying = true;
  if (errorContainer) errorContainer.innerHTML = '';
  if (continueBtn) {
    continueBtn.disabled = true;
    continueBtn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> <span>Verifying...</span>`;
    if (window.lucide) lucide.createIcons();
  }

  // 1. Trigger Clean Circular Orbit and Merge Animation on the 4 boxes
  for (let i = 0; i < 4; i++) {
    const slot = document.getElementById(`otp-slot-${i}`);
    if (slot) {
      slot.className = `otp-box-slot otp-anim-orbit-${i}`;
    }
    if (inputs[i]) inputs[i].disabled = true;
  }

  // 2. Show Central Fusion Core as boxes rotate & merge inwards
  setTimeout(() => {
    if (fusionCore) fusionCore.classList.add('otp-fusion-active');
  }, 750);

  // 3. Make API verification call in parallel with the circular merge animation
  const tempToken = AppState.otpSessionData?.tempToken || AppState.token;
  const startTime = Date.now();

  try {
    const res = await fetch('/api/auth/verify-otp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(tempToken ? { 'Authorization': `Bearer ${tempToken}` } : {})
      },
      body: JSON.stringify({ otp: otpCode, tempToken })
    });

    const data = await res.json().catch(() => ({}));
    const elapsed = Date.now() - startTime;
    const minWait = Math.max(0, 1300 - elapsed); // Let the merge animation complete gracefully

    await new Promise(r => setTimeout(r, minWait));

    if (!res.ok) {
      throw new Error(data.error || 'Incorrect verification code.');
    }

    // SUCCESS: Merged core combines into radiant green badge with tick sign!
    if (fusionCore) {
      fusionCore.className = 'otp-fusion-core otp-success-glow';
    }

    const successContainer = document.getElementById('otp-success-container');
    if (successContainer) {
      successContainer.innerHTML = `
        <div class="text-emerald-400 font-bold text-sm mt-2 animate-slide-down flex items-center justify-center gap-1.5">
          <i data-lucide="check-circle" class="w-4 h-4 text-emerald-400"></i>
          <span>Verification Successful! Unlocking account...</span>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
    }

    // Update global state with active session
    AppState.token = data.token;
    AppState.user = { ...data.user, requires_otp_verification: 0, is_suspicious: 0 };
    AppState.otpSessionData = null;
    AppState.currentTab = 'dashboard';
    localStorage.setItem('vps_token', data.token);
    localStorage.setItem('vps_user', JSON.stringify(AppState.user));

    showToast('Identity verified successfully! Welcome to ZenCloud.', 'success');

    // Smooth transition to Dashboard
    setTimeout(() => {
      isOtpVerifying = false;
      if (window.history && window.history.replaceState) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      } else {
        window.location.hash = '';
      }
      renderApp();
    }, 950);

  } catch (err) {
    const elapsed = Date.now() - startTime;
    const minWait = Math.max(0, 1300 - elapsed);
    await new Promise(r => setTimeout(r, minWait));

    // ERROR: 4 boxes undergo dramatic REPULSION outward and recoil back to normal state
    if (fusionCore) {
      fusionCore.className = 'otp-fusion-core';
    }

    for (let i = 0; i < 4; i++) {
      const slot = document.getElementById(`otp-slot-${i}`);
      if (slot) {
        slot.className = `otp-box-slot otp-anim-repulse-${i}`;
      }
    }

    // Display clear, prominent error text above the boxes
    if (errorContainer) {
      errorContainer.innerHTML = `
        <div class="text-red-400 bg-red-500/10 border border-red-500/30 px-3.5 py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 animate-slide-down">
          <i data-lucide="alert-triangle" class="w-4 h-4 text-red-400 shrink-0"></i>
          <span>${escapeHtml(err.message || 'Incorrect verification code. Please try again.')}</span>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
    }

    // Reset slots and inputs after repulsion spring settles
    setTimeout(() => {
      for (let i = 0; i < 4; i++) {
        const slot = document.getElementById(`otp-slot-${i}`);
        if (slot) slot.className = 'otp-box-slot';
        if (inputs[i]) {
          inputs[i].disabled = false;
          inputs[i].value = '';
          inputs[i].classList.add('border-red-500', 'otp-error-shake');
        }
      }
      if (inputs[0]) inputs[0].focus();
      if (continueBtn) {
        continueBtn.disabled = false;
        continueBtn.innerHTML = `<span>Continue</span><i data-lucide="arrow-right" class="w-4 h-4"></i>`;
        if (window.lucide) lucide.createIcons();
      }
      isOtpVerifying = false;
    }, 850);
  }
}

async function handleOtpResend() {
  const btn = document.getElementById('otp-resend-btn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Sending new OTP...';
  }

  try {
    const tempToken = AppState.otpSessionData?.tempToken || AppState.token;
    const res = await fetch('/api/auth/resend-otp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(tempToken ? { 'Authorization': `Bearer ${tempToken}` } : {})
      },
      body: JSON.stringify({ tempToken })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to resend code.');

    showToast(data.message || 'A fresh 4-digit verification code was sent to your email.', 'success');

    // Clear inputs and focus first box
    [0, 1, 2, 3].forEach(i => {
      const inp = document.getElementById(`otp-digit-${i}`);
      if (inp) { inp.value = ''; inp.classList.remove('border-red-500'); }
    });
    document.getElementById('otp-digit-0')?.focus();

    // Start 30s countdown
    let seconds = 30;
    const timer = setInterval(() => {
      seconds--;
      if (seconds > 0) {
        if (btn) btn.textContent = `Resend available in ${seconds}s`;
      } else {
        clearInterval(timer);
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Resend OTP Code';
        }
      }
    }, 1000);

  } catch (err) {
    showToast(err.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Resend OTP Code';
    }
  }
}

function cancelOtpAndLogout() {
  AppState.otpSessionData = null;
  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } else {
    window.location.hash = '';
  }
  logoutUser();
}

async function renderPublicShareView(root) {
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const token = params.get('token');
  root.innerHTML = `
    <div class="h-full min-h-full overflow-y-auto flex items-center justify-center p-4 bg-slate-950 custom-scrollbar">
      <div class="w-full max-w-xl glass-card p-7 rounded-2xl shadow-2xl border border-slate-800 my-auto">
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
        ${canPreview ? `<button onclick="openPublicSharePreview('${encodeURIComponent(token)}','${escapeHtml(data.fileName)}','${escapeHtml(data.mimeType || '')}')" class="inline-flex items-center gap-2 bg-white hover:bg-neutral-200 text-black font-bold px-4 py-2.5 rounded-lg text-sm transition-all"><i data-lucide="${String(data.mimeType || '').startsWith('video/') ? 'play-circle' : 'image'}" class="w-4 h-4"></i> Preview</button>` : ''}
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
          ${downloadUrl ? `<a href="${downloadUrl}" class="inline-flex items-center gap-1.5 bg-white hover:bg-neutral-200 text-black font-semibold px-3 py-1.5 rounded-lg text-xs transition-all"><i data-lucide="download" class="w-3.5 h-3.5"></i> Download instead</a>` : ''}
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

async function renderResetPasswordView(root) {
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const token = params.get('token');
  root.innerHTML = `
    <div class="h-full min-h-full overflow-y-auto flex items-center justify-center p-4 bg-slate-950 custom-scrollbar">
      <div class="w-full max-w-md pitch-card p-8 rounded-2xl shadow-2xl border border-slate-800 text-left my-auto">
        <div class="flex items-center gap-3 mb-6">
          <div class="w-10 h-10 rounded-xl zencloud-logo-badge"><i data-lucide="key" class="w-5 h-5"></i></div>
          <div><h1 class="text-lg font-bold text-white">Reset Password</h1><p class="text-xs text-slate-500">Enter your new account password</p></div>
        </div>
        <form onsubmit="handleResetPasswordSubmit(event, '${encodeURIComponent(token || '')}')" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">New Password</label>
            <input type="password" id="reset-new-pass" required minlength="6" class="w-full pitch-input rounded-xl px-4 py-2.5 text-sm focus:outline-none" placeholder="••••••••">
          </div>
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Confirm New Password</label>
            <input type="password" id="reset-confirm-pass" required minlength="6" class="w-full pitch-input rounded-xl px-4 py-2.5 text-sm focus:outline-none" placeholder="••••••••">
          </div>
          <button type="submit" class="w-full zencloud-btn-primary bg-white hover:bg-neutral-200 text-black font-bold py-2.5 rounded-xl text-sm shadow-md shadow-white/20 transition-all">Update Password</button>
        </form>
        <div class="mt-4 text-center">
          <button onclick="window.location.hash=''; renderApp();" class="text-xs text-slate-400 hover:text-white">Back to Login</button>
        </div>
      </div>
    </div>`;
  if (window.lucide) lucide.createIcons();
}

async function handleResetPasswordSubmit(e, token) {
  e.preventDefault();
  const newPassword = document.getElementById('reset-new-pass').value;
  const confirmPassword = document.getElementById('reset-confirm-pass').value;
  if (newPassword !== confirmPassword) {
    showToast('Passwords do not match.', 'error');
    return;
  }
  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: decodeURIComponent(token), newPassword, confirmPassword })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Password reset failed.');
    showToast(data.message, 'success');
    window.location.hash = '';
    renderApp();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openForgotPasswordModal() {
  document.getElementById('forgot-pass-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'forgot-pass-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm';
  modal.innerHTML = `
    <div class="pitch-card w-full max-w-md p-6 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2"><i data-lucide="help-circle" class="w-5 h-5 text-slate-700 dark:text-white"></i> Forgot Password</h3>
        <button type="button" onclick="document.getElementById('forgot-pass-modal')?.remove()" class="text-slate-400 hover:text-slate-900 dark:hover:text-white"><i data-lucide="x" class="w-5 h-5"></i></button>
      </div>
      <p class="text-xs text-slate-600 dark:text-slate-400 mb-4">Enter your registered email address and we will send you a password reset link.</p>
      <form onsubmit="handleForgotPasswordSubmit(event)" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold uppercase text-slate-500 dark:text-slate-400 mb-1">Account Email</label>
          <input type="email" id="forgot-email-input" required class="w-full pitch-input rounded-xl px-4 py-2.5 text-sm focus:outline-none" placeholder="user@domain.com">
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" onclick="document.getElementById('forgot-pass-modal')?.remove()" class="px-4 py-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 text-xs font-semibold">Cancel</button>
          <button type="submit" class="px-4 py-2 rounded-xl zencloud-btn-primary bg-white hover:bg-neutral-200 text-black font-bold text-xs">Send Reset Link</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();
}

async function handleForgotPasswordSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('forgot-email-input').value.trim();
  try {
    const res = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json().catch(() => ({}));
    document.getElementById('forgot-pass-modal')?.remove();
    showToast(data.message || 'If an account exists with that email, a reset link was sent.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function renderVerifyEmailView(root) {
  const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
  const token = params.get('token');
  root.innerHTML = `
    <div class="h-full min-h-full overflow-y-auto flex items-center justify-center p-4 bg-slate-950 custom-scrollbar">
      <div class="w-full max-w-md glass-card p-8 rounded-2xl shadow-2xl border border-slate-800 text-center my-auto">
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
      <button onclick="window.location.hash=''; renderApp()" class="mt-5 zencloud-btn-primary bg-white hover:bg-neutral-200 text-black font-bold text-xs px-4 py-2.5 rounded-lg">Continue</button>`;
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
    <div class="h-full min-h-full overflow-y-auto flex items-center justify-center p-4 bg-slate-950 custom-scrollbar">
      <div class="w-full max-w-md glass-card p-8 rounded-2xl shadow-2xl border border-slate-800 text-center my-auto">
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
      <button onclick="window.location.hash=''; renderApp()" class="mt-5 zencloud-btn-primary bg-white hover:bg-neutral-200 text-black font-bold text-xs px-4 py-2.5 rounded-lg">Continue</button>`;
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
    <div class="h-full min-h-full overflow-y-auto flex flex-col items-center justify-center p-4 theme-main-bg transition-colors duration-200 custom-scrollbar">
      
      <!-- Top Theme Switcher on Auth Screen -->
      <div class="w-full max-w-md flex justify-end mb-3">
        <button onclick="toggleDarkMode()" title="Toggle Light / Dark Theme" class="px-3 py-1.5 flex items-center gap-2 text-xs font-semibold rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 hover:border-black dark:hover:border-white shadow-sm transition-all">
          <i data-lucide="${AppState.isDarkMode ? 'sun' : 'moon'}" class="w-3.5 h-3.5 text-amber-500 dark:text-white"></i>
          <span>${AppState.isDarkMode ? 'Light Mode' : 'Dark Mode'}</span>
        </button>
      </div>

      <div class="w-full max-w-md pitch-card p-8 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-800 tab-pane-enter my-auto">
        
        <div class="text-center mb-6">
          <div class="inline-flex p-3.5 rounded-2xl zencloud-logo-badge mb-3 shadow-xl">
            <i data-lucide="cloud-lightning" class="w-8 h-8"></i>
          </div>
          <h1 class="text-2xl font-extrabold text-slate-900 dark:text-white tracking-tight flex items-center justify-center gap-2">
            ZenCloud
            <span class="text-xs font-bold uppercase tracking-wider bg-slate-200 text-slate-800 dark:bg-white/10 dark:text-white border border-slate-300 dark:border-white/20 px-2 py-0.5 rounded-lg">Storage</span>
          </h1>
          <p class="text-slate-500 dark:text-slate-400 text-xs mt-1">VPS SFTP Storage & Inbuilt Developer Studio</p>
        </div>

        <div class="flex border-b border-slate-200 dark:border-neutral-800 mb-6">
          <button id="tab-login-btn" onclick="switchAuthTab('login')" class="flex-1 py-2 text-sm font-semibold text-slate-900 dark:text-white border-b-2 border-slate-900 dark:border-white transition-all">Login</button>
          <button id="tab-register-btn" onclick="switchAuthTab('register')" class="flex-1 py-2 text-sm font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-all">Register</button>
        </div>

        <!-- Login Form -->
        <form id="auth-login-form" onsubmit="handleLoginSubmit(event)">
          <div class="space-y-4">
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-500 dark:text-slate-400 mb-1">Username or Email</label>
              <input type="text" id="login-input-user" required class="w-full pitch-input rounded-xl px-4 py-2.5 text-sm focus:outline-none" placeholder="Username or email address">
            </div>

            <div>
              <label class="block text-xs font-semibold uppercase text-slate-500 dark:text-slate-400 mb-1">Password</label>
              <input type="password" id="login-input-pass" required class="w-full pitch-input rounded-xl px-4 py-2.5 text-sm focus:outline-none" placeholder="••••••••">
            </div>

            <div class="flex justify-end items-center text-xs">
              <button type="button" onclick="openForgotPasswordModal()" class="text-slate-600 dark:text-slate-300 hover:text-black dark:hover:text-white underline">Forgot password?</button>
            </div>

            <button type="submit" class="w-full zencloud-btn-primary bg-white hover:bg-neutral-200 text-black font-bold py-2.5 rounded-xl text-sm shadow-md shadow-white/20 transition-all flex items-center justify-center gap-2">
              <i data-lucide="log-in" class="w-4 h-4"></i> Sign In
            </button>
          </div>
        </form>

        <!-- Register Form -->
        <form id="auth-register-form" onsubmit="handleRegisterSubmit(event)" class="hidden">
          <div class="space-y-3">
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-500 dark:text-slate-400 mb-1">Full Name</label>
              <input type="text" id="reg-name" required class="w-full pitch-input rounded-xl px-3.5 py-2 text-sm focus:outline-none" placeholder="Your Name">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-500 dark:text-slate-400 mb-1">Username</label>
              <input type="text" id="reg-username" required class="w-full pitch-input rounded-xl px-3.5 py-2 text-sm focus:outline-none" placeholder="username">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-500 dark:text-slate-400 mb-1">Email Address</label>
              <input type="email" id="reg-email" required class="w-full pitch-input rounded-xl px-3.5 py-2 text-sm focus:outline-none" placeholder="user@example.com">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-500 dark:text-slate-400 mb-1">Password</label>
              <input type="password" id="reg-password" required minlength="6" class="w-full pitch-input rounded-xl px-3.5 py-2 text-sm focus:outline-none" placeholder="••••••••">
            </div>
            <div>
              <label class="block text-xs font-semibold uppercase text-slate-500 dark:text-slate-400 mb-1">Confirm Password</label>
              <input type="password" id="reg-confirm" required class="w-full pitch-input rounded-xl px-3.5 py-2 text-sm focus:outline-none" placeholder="••••••••">
            </div>

            <button type="submit" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-2.5 rounded-xl text-sm shadow-md shadow-emerald-600/25 transition-all flex items-center justify-center gap-2 mt-2">
              <i data-lucide="user-plus" class="w-4 h-4"></i> Create Account
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  if (window.lucide) {
    lucide.createIcons();
  }
}

function switchAuthTab(tab) {
  const loginForm = document.getElementById('auth-login-form');
  const regForm = document.getElementById('auth-register-form');
  const loginBtn = document.getElementById('tab-login-btn');
  const regBtn = document.getElementById('tab-register-btn');

  if (tab === 'login') {
    loginForm.classList.remove('hidden');
    regForm.classList.add('hidden');
    loginBtn.className = 'flex-1 py-2 text-sm font-semibold text-slate-900 dark:text-white border-b-2 border-slate-900 dark:border-white transition-all';
    regBtn.className = 'flex-1 py-2 text-sm font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-all';
  } else {
    loginForm.classList.add('hidden');
    regForm.classList.remove('hidden');
    regBtn.className = 'flex-1 py-2 text-sm font-semibold text-slate-900 dark:text-white border-b-2 border-slate-900 dark:border-white transition-all';
    loginBtn.className = 'flex-1 py-2 text-sm font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-all';
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

    if (data.requiresOtp) {
      AppState.otpSessionData = data;
      AppState.currentTab = 'dashboard';
      window.location.hash = '#otp-verification';
      renderApp();
      return;
    }

    AppState.token = data.token;
    AppState.user = data.user;
    AppState.currentTab = 'dashboard';
    localStorage.setItem('vps_token', data.token);
    localStorage.setItem('vps_user', JSON.stringify(data.user));

    showToast('Logged in successfully!', 'success');
    renderApp();
  } catch (err) {
    if (err.requiresOtpVerification) {
      AppState.otpSessionData = err;
      window.location.hash = '#otp-verification';
      renderApp();
      return;
    }
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

  container.innerHTML = `
    <div class="h-full w-full flex flex-col theme-main-bg text-slate-900 dark:text-slate-100 transition-colors duration-200 overflow-hidden relative">
      
      <!-- Minimalist Pitch Black & Light Mode Responsive Top Status & Utility Bar -->
      <header id="twilight-top-bar" class="twilight-navbar w-full px-4 sm:px-6 py-2.5 z-40 sticky top-0 flex items-center justify-between gap-3">
        <!-- Left: ZenCloud Minimal Brand Mark -->
        <div class="flex items-center gap-2.5 shrink-0 cursor-pointer select-none group" onclick="navigateTab('dashboard')">
          <div class="zencloud-logo-badge p-1.5 sm:p-2 rounded-xl group-hover:scale-105 transition-all">
            <i data-lucide="cloud-lightning" class="w-4 h-4"></i>
          </div>
          <div>
            <h1 class="font-bold text-sm sm:text-base tracking-tight text-slate-900 dark:text-white leading-none">
              ZenCloud
            </h1>
            <div class="text-[11px] text-slate-500 dark:text-slate-400 leading-none mt-1">Cloud Storage & Studio</div>
          </div>
        </div>

        <!-- Right Controls: Search, Create, Quota, Theme & Profile -->
        <div class="flex items-center gap-2 sm:gap-2.5">
          
          <!-- Quick Search Bar (Ctrl+K) -->
          <button onclick="openTwilightCommandPalette()" class="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-xl twilight-pill text-slate-600 dark:text-slate-300 hover:text-black dark:hover:text-white transition-all text-xs group" title="Quick Search (Ctrl+K)">
            <i data-lucide="search" class="w-3.5 h-3.5 text-slate-400 group-hover:text-black dark:group-hover:text-white"></i>
            <span class="text-slate-600 dark:text-slate-300 group-hover:text-black dark:group-hover:text-white hidden xl:inline">Search & Actions</span>
            <kbd class="px-1.5 py-0.5 text-[10px] font-mono bg-slate-100 dark:bg-[#141414] border border-slate-200 dark:border-white/10 rounded text-slate-600 dark:text-slate-300">⌘K</kbd>
          </button>

          <!-- Quick Create Button (+ Create Dropdown) -->
          <div class="relative">
            <button id="twilight-create-btn" onclick="toggleTwilightCreateMenu(event)" class="twilight-btn-glow text-black text-xs font-semibold px-3 py-1.5 sm:px-3.5 sm:py-2 rounded-xl flex items-center gap-1.5 transition-all shrink-0">
              <i data-lucide="plus" class="w-4 h-4"></i>
              <span class="hidden sm:inline">New</span>
              <i data-lucide="chevron-down" class="w-3 h-3 opacity-60"></i>
            </button>
            
            <!-- Twilight Create Dropdown Menu -->
            <div id="twilight-create-menu" class="hidden absolute right-0 mt-2 w-56 rounded-2xl bg-white dark:bg-[#0c0c0e] border border-slate-200 dark:border-white/10 shadow-xl p-1.5 z-50 text-xs backdrop-blur-xl animate-scale-in">
              <div class="px-3 py-1.5 text-[10px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100 dark:border-white/5 mb-1">
                Create Resource
              </div>
              <button onclick="openCreateNewFileModal(); closeTwilightMenus();" class="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-slate-700 dark:text-slate-200 hover:text-black dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 transition-all">
                <i data-lucide="file-plus" class="w-4 h-4 text-slate-500"></i>
                <div>
                  <div class="font-medium text-slate-900 dark:text-slate-100">New File</div>
                  <div class="text-[10px] text-slate-500">.html, .js, .json, .md</div>
                </div>
              </button>
              <button onclick="openCreateFolderModal(); closeTwilightMenus();" class="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-slate-700 dark:text-slate-200 hover:text-black dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 transition-all">
                <i data-lucide="folder-plus" class="w-4 h-4 text-slate-500"></i>
                <div>
                  <div class="font-medium text-slate-900 dark:text-slate-100">New Folder</div>
                  <div class="text-[10px] text-slate-500">Directory in current path</div>
                </div>
              </button>
              <button onclick="triggerNavbarFileUpload(); closeTwilightMenus();" class="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left text-slate-700 dark:text-slate-200 hover:text-black dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 transition-all">
                <i data-lucide="upload" class="w-4 h-4 text-slate-500"></i>
                <div>
                  <div class="font-medium text-slate-900 dark:text-slate-100">Upload Files</div>
                  <div class="text-[10px] text-slate-500">Direct upload</div>
                </div>
              </button>
            </div>
          </div>

          <!-- Compact Storage Quota Gauge -->
          <div id="sidebar-quota-widget" class="hidden xl:flex items-center gap-2.5 twilight-pill px-3 py-1.5 rounded-xl text-xs">
            <div class="flex items-center gap-1.5 text-slate-600 dark:text-slate-400">
              <i data-lucide="database" class="w-3.5 h-3.5 text-slate-500"></i>
              <span id="quota-percent-text" class="font-semibold text-slate-900 dark:text-white">0%</span>
            </div>
            <div class="w-16 bg-slate-200 dark:bg-neutral-800 rounded-full h-1.5 overflow-hidden">
              <div id="quota-bar" class="bg-slate-900 dark:bg-white h-full rounded-full transition-all duration-300" style="width: 0%"></div>
            </div>
            <span id="quota-detail-text" class="text-[11px] text-slate-500 dark:text-slate-400 font-mono">0 GB</span>
          </div>

          <!-- Theme Switcher Button -->
          <button onclick="toggleDarkMode()" title="Toggle Light / Dark Theme" class="p-2 rounded-xl twilight-pill text-slate-600 dark:text-slate-400 hover:text-black dark:hover:text-white transition-all">
            <i data-lucide="${AppState.isDarkMode ? 'sun' : 'moon'}" class="w-4 h-4 text-amber-500 dark:text-slate-200"></i>
          </button>

          <!-- User Profile Button & Dropdown -->
          <div class="relative">
            <button id="twilight-user-btn" onclick="toggleTwilightUserMenu(event)" class="flex items-center gap-2 p-1 pl-1.5 sm:px-2.5 sm:py-1 rounded-xl twilight-pill transition-all text-xs">
              <div class="zencloud-avatar-badge w-6 h-6 rounded-lg text-xs uppercase">
                ${AppState.user.username.substring(0, 2)}
              </div>
              <div class="hidden sm:block text-left text-xs leading-none">
                <div class="font-semibold text-slate-900 dark:text-white truncate max-w-[85px]">${escapeHtml(AppState.user.name || AppState.user.username)}</div>
              </div>
              <i data-lucide="chevron-down" class="w-3 h-3 text-slate-400 hidden sm:block"></i>
            </button>

            <!-- Twilight User Menu -->
            <div id="twilight-user-menu" class="hidden absolute right-0 mt-2 w-60 rounded-2xl bg-white dark:bg-[#0c0c0e] border border-slate-200 dark:border-white/10 shadow-xl p-2 z-50 text-xs backdrop-blur-xl animate-scale-in">
              <div class="p-2.5 rounded-xl bg-slate-50 dark:bg-neutral-900/60 border border-slate-100 dark:border-white/5 mb-1.5 flex items-center gap-2.5">
                <div class="zencloud-avatar-badge w-8 h-8 rounded-lg text-xs uppercase shrink-0">
                  ${AppState.user.username.substring(0, 2)}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="font-semibold text-slate-900 dark:text-white truncate">${escapeHtml(AppState.user.name || AppState.user.username)}</div>
                  <div class="text-[11px] text-slate-500 truncate">${escapeHtml(AppState.user.email || AppState.user.username)}</div>
                </div>
              </div>
              <button onclick="navigateTab('profile'); closeTwilightMenus();" class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left text-slate-700 dark:text-slate-300 hover:text-black dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 transition-all">
                <i data-lucide="user" class="w-4 h-4 text-slate-400"></i> Account & Security
              </button>
              <button onclick="navigateTab('s3cluster'); closeTwilightMenus();" class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left text-slate-700 dark:text-slate-300 hover:text-black dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 transition-all">
                <i data-lucide="key" class="w-4 h-4 text-slate-400"></i> S3 API Keys
              </button>
              <button onclick="navigateTab('files'); closeTwilightMenus();" class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left text-slate-700 dark:text-slate-300 hover:text-black dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 transition-all">
                <i data-lucide="folder" class="w-4 h-4 text-slate-400"></i> File Explorer
              </button>
              <div class="my-1 border-t border-slate-100 dark:border-white/5"></div>
              <button onclick="logoutUser()" class="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-all">
                <i data-lucide="log-out" class="w-4 h-4 text-red-500"></i> Sign Out
              </button>
            </div>
          </div>

        </div>
      </header>

      <!-- Notification Banners -->
      <div id="email-verification-banner" class="shrink-0 px-4 sm:px-6 pt-2"></div>

      <!-- Main Content Area with Bottom Padding for Floating Dock -->
      <main class="flex-1 flex flex-col min-w-0 h-full overflow-hidden theme-main-bg">
        <div id="tab-content-area" class="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 pb-24 sm:pb-28 custom-scrollbar tab-pane-enter">
          <!-- Rendered dynamically -->
        </div>
      </main>

      <!-- ZenCloud Minimal Floating Dock -->
      <div class="fixed bottom-4 sm:bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[96vw] w-auto pointer-events-auto">
        <nav class="twilight-floating-dock flex items-center gap-1 px-2 py-1.5 rounded-full shadow-lg backdrop-blur-xl">
          <!-- Dashboard Tab -->
          <button onclick="navigateTab('dashboard')" class="twilight-dock-tab flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-all ${AppState.currentTab === 'dashboard' ? 'twilight-tab-active' : 'twilight-tab-inactive'}" title="Dashboard">
            <i data-lucide="layout-dashboard" class="w-4 h-4"></i>
            <span class="hidden sm:inline">Dashboard</span>
          </button>

          <!-- Files Tab -->
          <button onclick="navigateTab('files')" class="twilight-dock-tab flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-all ${AppState.currentTab === 'files' ? 'twilight-tab-active' : 'twilight-tab-inactive'}" title="Files & Studio">
            <i data-lucide="folder" class="w-4 h-4"></i>
            <span class="hidden sm:inline">Files</span>
          </button>

          <!-- S3 & Blob API Tab -->
          <button onclick="navigateTab('s3cluster')" class="twilight-dock-tab flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-all ${AppState.currentTab === 's3cluster' ? 'twilight-tab-active' : 'twilight-tab-inactive'}" title="S3 API">
            <i data-lucide="database" class="w-4 h-4"></i>
            <span class="hidden sm:inline">S3 API</span>
          </button>

          <!-- Shares Tab -->
          <button onclick="navigateTab('shares')" class="twilight-dock-tab flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-all ${AppState.currentTab === 'shares' ? 'twilight-tab-active' : 'twilight-tab-inactive'}" title="Share Links">
            <i data-lucide="share-2" class="w-4 h-4"></i>
            <span class="hidden sm:inline">Shares</span>
          </button>

          <!-- Profile Tab -->
          <button onclick="navigateTab('profile')" class="twilight-dock-tab flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-all ${AppState.currentTab === 'profile' ? 'twilight-tab-active' : 'twilight-tab-inactive'}" title="Account Profile">
            <i data-lucide="user" class="w-4 h-4"></i>
            <span class="hidden sm:inline">Profile</span>
          </button>

          <!-- Admin Tab (If Admin) -->
          ${AppState.user && AppState.user.role === 'admin' ? `
            <button onclick="navigateTab('admin')" class="twilight-dock-tab flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-medium transition-all ${AppState.currentTab === 'admin' ? 'twilight-tab-active' : 'twilight-tab-inactive'}" title="Admin Panel">
              <i data-lucide="shield" class="w-4 h-4"></i>
              <span class="hidden sm:inline">Admin</span>
            </button>
          ` : ''}

          <!-- Separator -->
          <div class="h-4 w-px bg-slate-200 dark:bg-white/10 mx-1"></div>

          <!-- Quick Search Button -->
          <button onclick="openTwilightCommandPalette()" class="twilight-dock-tab p-2 rounded-full text-xs text-slate-500 hover:text-black dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/5 transition-all" title="Search (⌘K)">
            <i data-lucide="search" class="w-4 h-4"></i>
          </button>

          <!-- Quick + Create Button -->
          <button onclick="openCreateNewFileModal()" class="twilight-dock-tab p-2 rounded-full text-xs font-semibold zencloud-btn-primary shadow-sm transition-all" title="Create New File">
            <i data-lucide="plus" class="w-4 h-4"></i>
          </button>
        </nav>
      </div>

    </div>
  `;

  updateQuotaWidget();
  renderEmailVerificationBanner();
  renderTabContent();
}

function toggleTwilightCreateMenu(event) {
  event.stopPropagation();
  const cMenu = document.getElementById('twilight-create-menu');
  const uMenu = document.getElementById('twilight-user-menu');
  if (uMenu) uMenu.classList.add('hidden');
  if (cMenu) {
    cMenu.classList.toggle('hidden');
    if (!cMenu.classList.contains('hidden') && window.lucide) {
      lucide.createIcons();
    }
  }
}

function toggleTwilightUserMenu(event) {
  event.stopPropagation();
  const cMenu = document.getElementById('twilight-create-menu');
  const uMenu = document.getElementById('twilight-user-menu');
  if (cMenu) cMenu.classList.add('hidden');
  if (uMenu) {
    uMenu.classList.toggle('hidden');
    if (!uMenu.classList.contains('hidden') && window.lucide) {
      lucide.createIcons();
    }
  }
}

function closeTwilightMenus() {
  const cMenu = document.getElementById('twilight-create-menu');
  const uMenu = document.getElementById('twilight-user-menu');
  if (cMenu) cMenu.classList.add('hidden');
  if (uMenu) uMenu.classList.add('hidden');
}

function triggerNavbarFileUpload() {
  if (AppState.currentTab !== 'files') {
    AppState.currentTab = 'files';
    renderApp();
  }
  setTimeout(() => {
    const input = document.getElementById('file-upload-input');
    if (input) input.click();
  }, 100);
}

function openTwilightCommandPalette() {
  const existing = document.getElementById('twilight-command-palette');
  if (existing) {
    existing.classList.remove('hidden');
    const input = document.getElementById('twilight-cmd-input');
    if (input) { input.value = ''; input.focus(); filterTwilightCommands(''); }
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'twilight-command-palette';
  modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-md z-[100] flex items-start justify-center pt-20 p-4 modal-backdrop-enter';
  modal.onclick = (e) => {
    if (e.target === modal) closeTwilightCommandPalette();
  };

  modal.innerHTML = `
    <div class="glass-card w-full max-w-xl rounded-2xl border border-white/20 shadow-2xl bg-[#080808] text-slate-100 overflow-hidden modal-box-enter" onclick="event.stopPropagation()">
      <div class="flex items-center gap-3 px-4 py-3.5 border-b border-white/10 bg-[#000000]">
        <i data-lucide="search" class="w-5 h-5 text-white/80 shrink-0"></i>
        <input id="twilight-cmd-input" type="text" placeholder="Type a command, file type, or tab..." class="w-full bg-transparent text-sm text-white placeholder-slate-400 focus:outline-none" oninput="filterTwilightCommands(this.value)">
        <kbd class="px-2 py-0.5 text-[11px] font-mono bg-[#141414] border border-white/20 rounded text-white">ESC</kbd>
      </div>
      <div id="twilight-cmd-list" class="max-h-80 overflow-y-auto p-2 space-y-1 custom-scrollbar">
        <!-- Rendered items -->
      </div>
      <div class="px-4 py-2 border-t border-white/10 bg-[#000000] text-[11px] text-slate-400 flex items-center justify-between">
        <span>Press <kbd class="px-1 py-0.2 bg-[#141414] border border-white/20 rounded font-mono text-[10px]">Enter</kbd> to execute</span>
        <span class="text-white font-semibold">ZenCloud Twilight Bar</span>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();

  const input = document.getElementById('twilight-cmd-input');
  if (input) input.focus();
  filterTwilightCommands('');
}

function closeTwilightCommandPalette() {
  const modal = document.getElementById('twilight-command-palette');
  if (modal) modal.remove();
}

function filterTwilightCommands(query) {
  const list = document.getElementById('twilight-cmd-list');
  if (!list) return;

  const q = (query || '').toLowerCase().trim();
  const commands = [
    { title: 'Files & Inbuilt Studio', desc: 'Browse, edit code and manage project files', icon: 'folder-code', color: 'text-white', action: () => { navigateTab('files'); closeTwilightCommandPalette(); } },
    { title: 'Create HTML File (.html)', desc: 'Start a new HTML5 document in built-in editor', icon: 'code', color: 'text-white', action: () => { closeTwilightCommandPalette(); selectNewFilePreset('html'); } },
    { title: 'Create Text File (.txt)', desc: 'Plain text note or documentation file', icon: 'file-text', color: 'text-emerald-400', action: () => { closeTwilightCommandPalette(); selectNewFilePreset('text'); } },
    { title: 'Create JavaScript File (.js)', desc: 'JavaScript code file with syntax highlighter', icon: 'file-code', color: 'text-amber-400', action: () => { closeTwilightCommandPalette(); selectNewFilePreset('javascript'); } },
    { title: 'Create JSON File (.json)', desc: 'Structured JSON data file with formatter', icon: 'braces', color: 'text-white', action: () => { closeTwilightCommandPalette(); selectNewFilePreset('json'); } },
    { title: 'Create Markdown Document (.md)', desc: 'Markdown file with live rendered preview', icon: 'book-open', color: 'text-white', action: () => { closeTwilightCommandPalette(); selectNewFilePreset('markdown'); } },
    { title: 'Create New Folder', desc: 'Create a new directory in current location', icon: 'folder-plus', color: 'text-emerald-400', action: () => { closeTwilightCommandPalette(); openCreateFolderModal(); } },
    { title: 'Upload Files', desc: 'Upload files via browser or SFTP', icon: 'upload-cloud', color: 'text-white', action: () => { closeTwilightCommandPalette(); triggerNavbarFileUpload(); } },
    { title: 'Dashboard & Metrics', desc: 'VPS resource status, memory, storage graph', icon: 'layout-dashboard', color: 'text-white', action: () => { navigateTab('dashboard'); closeTwilightCommandPalette(); } },
    { title: 'S3 & Vercel Blob Compatible API', desc: 'Manage access keys, buckets, endpoints', icon: 'database', color: 'text-amber-400', action: () => { navigateTab('s3cluster'); closeTwilightCommandPalette(); } },
    { title: 'Public File Shares', desc: 'Active shared links, expiration dates', icon: 'share-2', color: 'text-white', action: () => { navigateTab('shares'); closeTwilightCommandPalette(); } },
    { title: 'Profile & Security', desc: 'Change password, 2FA, email settings', icon: 'user', color: 'text-slate-300', action: () => { navigateTab('profile'); closeTwilightCommandPalette(); } },
    { title: 'Toggle Dark / Light Theme', desc: 'Switch visual appearance', icon: 'sun', color: 'text-amber-300', action: () => { toggleDarkMode(); closeTwilightCommandPalette(); } },
  ];

  if (AppState.user && AppState.user.role === 'admin') {
    commands.push({ title: 'Admin Control Center', desc: 'Manage all VPS users, storage quotas & terminal', icon: 'shield-alert', color: 'text-amber-400', action: () => { navigateTab('admin'); closeTwilightCommandPalette(); } });
  }

  const filtered = commands.filter(c => c.title.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q));

  if (filtered.length === 0) {
    list.innerHTML = `<div class="p-6 text-center text-slate-500 text-xs">No matching commands or files found for "${escapeHtml(q)}"</div>`;
    return;
  }

  list.innerHTML = filtered.map((c, idx) => `
    <button onclick="(${c.action.toString()})()" class="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-white/10 text-left transition-all group">
      <div class="flex items-center gap-3">
        <div class="p-2 rounded-lg bg-[#141414] ${c.color} border border-white/15 group-hover:border-white/40">
          <i data-lucide="${c.icon}" class="w-4 h-4"></i>
        </div>
        <div>
          <div class="text-xs font-semibold text-slate-100 group-hover:text-white">${escapeHtml(c.title)}</div>
          <div class="text-[11px] text-slate-400">${escapeHtml(c.desc)}</div>
        </div>
      </div>
      <i data-lucide="chevron-right" class="w-4 h-4 text-slate-500 group-hover:text-white opacity-0 group-hover:opacity-100 transition-all"></i>
    </button>
  `).join('');

  if (window.lucide) lucide.createIcons();
}

// Global click outside listener for twilight menus
window.addEventListener('click', (e) => {
  const cMenu = document.getElementById('twilight-create-menu');
  const cBtn = document.getElementById('twilight-create-btn');
  const uMenu = document.getElementById('twilight-user-menu');
  const uBtn = document.getElementById('twilight-user-btn');

  if (cMenu && !cMenu.contains(e.target) && !cBtn?.contains(e.target)) {
    cMenu.classList.add('hidden');
  }
  if (uMenu && !uMenu.contains(e.target) && !uBtn?.contains(e.target)) {
    uMenu.classList.add('hidden');
  }
});

// Global keyboard shortcuts for Twilight Nav Bar
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openTwilightCommandPalette();
  }
  if (e.key === 'Escape') {
    closeTwilightCommandPalette();
    closeTwilightMenus();
  }
});

function navigateTab(tabName) {
  AppState.currentTab = tabName;
  renderApp();
}

function switchTab(tabName) {
  navigateTab(tabName);
}

function toggleDarkMode() {
  AppState.isDarkMode = !AppState.isDarkMode;
  AppState.theme = AppState.isDarkMode ? 'dark' : 'light';
  localStorage.setItem('vps_theme', AppState.theme);
  document.documentElement.classList.toggle('dark', AppState.isDarkMode);
  document.documentElement.classList.toggle('light', !AppState.isDarkMode);
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

  // Smooth entrance animation
  area.classList.remove('tab-pane-enter');
  void area.offsetWidth; // trigger reflow
  area.classList.add('tab-pane-enter');

  if (AppState.currentTab === 'dashboard') {
    renderDashboardTab(area);
  } else if (AppState.currentTab === 'files') {
    renderFileManagerTab(area);
  } else if (AppState.currentTab === 's3cluster') {
    renderS3ClusterTab(area);
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
  const isAdmin = AppState.user && AppState.user.role === 'admin';
  const isInspecting = isAdmin && Boolean(AppState.targetUserId);
  const targetLabel = AppState.targetUser ? (AppState.targetUser.username || AppState.targetUser.name || `User #${AppState.targetUserId}`) : `User #${AppState.targetUserId}`;

  container.innerHTML = `
    <div class="space-y-4 w-full max-w-full min-w-0">
      ${isAdmin ? `
        <!-- Admin User Directory Scope Selector -->
        <div class="w-full max-w-full min-w-0 p-3.5 sm:p-4 rounded-2xl border ${isInspecting ? 'bg-amber-500/10 border-amber-500/30' : 'glass-card border-slate-200 dark:border-slate-800'} space-y-3 overflow-hidden box-border">
          <div class="flex items-start gap-2.5 sm:gap-3 min-w-0 w-full">
            <div class="w-9 h-9 rounded-xl ${isInspecting ? 'bg-amber-500/20 text-amber-500 dark:text-amber-400' : 'bg-slate-200 text-slate-800 dark:bg-white/15 dark:text-white'} flex items-center justify-center font-bold text-xs shrink-0 mt-0.5 sm:mt-0">
              <i data-lucide="${isInspecting ? 'user-check' : 'shield'}" class="w-4 h-4"></i>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5 sm:gap-2 min-w-0">
                <span class="text-xs font-bold text-slate-900 dark:text-white shrink-0">Admin Directory Scope:</span>
                ${isInspecting 
                  ? `<span class="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-600 dark:text-amber-300 font-mono text-[11px] font-bold truncate max-w-full" title="Inspecting User #${AppState.targetUserId}: ${escapeHtml(targetLabel)}">Inspecting User #${AppState.targetUserId}: ${escapeHtml(targetLabel)}</span>` 
                  : `<span class="inline-flex items-center px-2 py-0.5 rounded-md bg-slate-200 text-slate-800 dark:bg-white/15 dark:text-white font-mono text-[11px] font-bold truncate max-w-full">My Personal Storage (Self)</span>`}
              </div>
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-1 break-words leading-relaxed">
                ${isInspecting 
                  ? `Full administrative access: browse, upload, download, edit, and manage files in <b class="text-slate-700 dark:text-slate-200">${escapeHtml(targetLabel)}</b>'s directory.` 
                  : `You are in your own directory. Select any registered user from the switcher to inspect and manage their directory.`}
              </p>
            </div>
          </div>

          <!-- Controls: Full width stacked on mobile, row on tablet/desktop -->
          <div class="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-2.5 border-t border-slate-200/60 dark:border-slate-800/60 min-w-0 w-full">
            <div class="relative flex-1 min-w-0 w-full max-w-full">
              <select id="admin-user-directory-select" onchange="handleAdminUserDirectoryChange(this.value)" class="w-full min-w-0 max-w-full pitch-input rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-white bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 truncate cursor-pointer focus:outline-none focus:ring-1 focus:ring-amber-500/50" style="max-width: 100%;">
                <option value="">📁 My Admin Directory (Self)</option>
              </select>
            </div>
            ${isInspecting ? `
              <button onclick="resetAdminUserDirectory()" class="w-full sm:w-auto shrink-0 justify-center px-3.5 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition-all whitespace-nowrap shadow-sm active:scale-95">
                <i data-lucide="corner-up-left" class="w-3.5 h-3.5 shrink-0"></i>
                <span>Exit to My Storage</span>
              </button>
            ` : ''}
          </div>
        </div>
      ` : ''}

      <!-- File Action Bar -->
      <div class="flex flex-wrap items-center justify-between gap-3 glass-card p-3 sm:p-4 rounded-2xl border border-slate-200 dark:border-slate-800 w-full max-w-full min-w-0 overflow-hidden">
        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <!-- Upload Button -->
          <label class="zencloud-btn-primary bg-white hover:bg-neutral-200 text-black text-xs font-bold px-3.5 sm:px-4 py-2 sm:py-2.5 rounded-xl cursor-pointer flex items-center gap-2 shadow-lg shadow-white/20 transition-all shrink-0">
            <i data-lucide="upload-cloud" class="w-4 h-4 text-black"></i> Upload Files
            <input type="file" id="file-upload-input" multiple onchange="handleFileUpload(event)" class="hidden">
          </label>

          <!-- New File Button -->
          <button onclick="openCreateNewFileModal()" class="bg-white/10 hover:bg-white/20 text-white text-xs font-semibold px-3 sm:px-3.5 py-2 sm:py-2.5 rounded-xl flex items-center gap-2 transition-all border border-white/20 shrink-0 shadow-sm" title="Create New File (.html, .txt, .js, .json, etc.)">
            <i data-lucide="file-plus" class="w-4 h-4 text-white"></i> New File
          </button>

          <!-- Create Folder -->
          <button onclick="openCreateFolderModal()" class="bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 text-xs font-semibold px-3 sm:px-3.5 py-2 sm:py-2.5 rounded-xl flex items-center gap-2 transition-all border border-slate-200 dark:border-slate-700 shrink-0">
            <i data-lucide="folder-plus" class="w-4 h-4 text-amber-400"></i> New Folder
          </button>

          <!-- Refresh -->
          <button id="file-refresh-button" onclick="refreshFileManager()" class="bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-200 p-2 sm:p-2.5 rounded-xl transition-all border border-slate-200 dark:border-slate-700 disabled:opacity-50 disabled:cursor-not-allowed shrink-0" title="Refresh">
            <i data-lucide="refresh-cw" class="w-4 h-4"></i>
          </button>
        </div>

        <!-- Bulk Action Buttons (Visible when items selected) -->
        <div id="bulk-actions" class="hidden flex flex-wrap items-center gap-2 min-w-0">
          <button onclick="handleBulkDelete()" class="bg-red-600/20 hover:bg-red-600 text-red-600 dark:text-red-400 hover:text-white text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5 transition-all">
            <i data-lucide="trash-2" class="w-4 h-4"></i> Delete Selected (<span id="selected-count">0</span>)
          </button>
          <button onclick="openCompressModal()" class="bg-white/10 hover:bg-white text-slate-300 hover:text-black text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5 transition-all border border-white/20">
            <i data-lucide="archive" class="w-4 h-4"></i> Compress
          </button>
          <button onclick="openMoveSelectedPrompt()" class="bg-white/10 hover:bg-white text-slate-300 hover:text-black text-xs font-semibold px-3 py-2 rounded-xl flex items-center gap-1.5 transition-all border border-white/20">
            <i data-lucide="folder-input" class="w-4 h-4"></i> Move
          </button>
        </div>

        <!-- Search & View Toggle -->
        <div class="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-end min-w-0">
          <div class="relative flex-1 sm:flex-initial min-w-0">
            <i data-lucide="search" class="w-4 h-4 absolute left-3 top-2.5 text-slate-400"></i>
            <input type="text" id="file-search-input" oninput="handleFileSearch(event)" placeholder="Search files..." class="w-full sm:w-48 pitch-input rounded-xl pl-9 pr-4 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-white">
          </div>

          <div class="flex bg-slate-100 dark:bg-slate-900 p-1 rounded-xl border border-slate-200 dark:border-slate-800 shrink-0" id="file-view-toggle-group">
            <button id="view-mode-grid-btn" onclick="setFileViewMode('grid')" class="p-1.5 rounded-lg transition-all ${AppState.viewMode === 'grid' ? 'bg-slate-900 text-white dark:bg-white dark:text-black font-bold shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}" title="Grid View">
              <i data-lucide="grid" class="w-4 h-4"></i>
            </button>
            <button id="view-mode-list-btn" onclick="setFileViewMode('list')" class="p-1.5 rounded-lg transition-all ${AppState.viewMode === 'list' ? 'bg-slate-900 text-white dark:bg-white dark:text-black font-bold shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}" title="List View">
              <i data-lucide="list" class="w-4 h-4"></i>
            </button>
          </div>
        </div>
      </div>

      <!-- Download from URL -->
      <div class="glass-card p-4 rounded-2xl border border-slate-200 dark:border-slate-800">
        <div class="flex items-start gap-3 mb-4">
          <div class="w-9 h-9 rounded-xl bg-slate-100 dark:bg-white/10 border border-slate-200 dark:border-white/20 flex items-center justify-center text-slate-800 dark:text-white shrink-0">
            <i data-lucide="cloud-download" class="w-4 h-4"></i>
          </div>
          <div>
            <h3 class="text-sm font-bold text-slate-900 dark:text-white">Download from URL</h3>
            <p class="text-xs text-slate-600 dark:text-slate-400 mt-1">Paste a direct HTTP/HTTPS file link. The server will run <span class="font-mono text-slate-900 dark:text-white font-semibold">wget</span> in the background and save the finished file in this directory.</p>
          </div>
        </div>

        <form onsubmit="startUrlDownload(event)" class="grid grid-cols-1 lg:grid-cols-[1fr_240px_auto] gap-2">
          <input id="url-download-link" type="url" required placeholder="https://example.com/file.zip" class="w-full pitch-input rounded-xl px-3 py-2.5 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-white">
          <input id="url-download-filename" type="text" placeholder="File name (optional)" maxlength="240" class="w-full pitch-input rounded-xl px-3 py-2.5 text-xs text-slate-900 dark:text-white focus:outline-none focus:border-white">
          <button type="submit" class="zencloud-btn-primary bg-white hover:bg-neutral-200 text-black font-bold text-xs px-4 py-2.5 rounded-xl flex items-center justify-center gap-2 shadow-md">
            <i data-lucide="download" class="w-4 h-4 text-black"></i> Start Download
          </button>
        </form>

        <div class="mt-3 rounded-xl bg-slate-50 dark:bg-slate-950/50 border border-slate-200 dark:border-slate-800 p-3">
          <p class="text-[11px] leading-5 text-slate-600 dark:text-slate-400">
            <span class="font-bold text-slate-800 dark:text-slate-200">How it works:</span>
            1) Your link is checked, 2) <span class="font-mono text-slate-900 dark:text-white">wget</span> downloads it on the VPS in the background,
            3) the completed file is moved into your current folder, and 4) your file list and storage usage are refreshed.
            If the URL does not provide a useful filename, enter one in the File name box. Existing names are automatically made unique.
          </p>
        </div>
        <div id="url-download-jobs" class="mt-3"></div>
      </div>

      <!-- Breadcrumbs Path Navigator -->
      <div id="file-breadcrumbs" class="flex items-center gap-1 text-xs text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-950/40 px-3.5 sm:px-4 py-2.5 rounded-xl border border-slate-200 dark:border-slate-800 overflow-x-auto whitespace-nowrap scrollbar-thin max-w-full">
        <!-- Rendered dynamically -->
      </div>

      <!-- Upload Progress Container -->
      <div id="upload-progress-container" class="hidden glass-card p-4 rounded-xl border border-white/20">
        <div class="flex justify-between text-xs font-semibold text-slate-900 dark:text-white mb-1">
          <span id="upload-status-text">Uploading files...</span>
          <span id="upload-percentage">0%</span>
        </div>
        <div class="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
          <div id="upload-progress-bar" class="bg-white h-full transition-all" style="width: 0%"></div>
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
  if (isAdmin) {
    loadAdminUserDirectoryDropdown();
  }
  if (window.lucide) lucide.createIcons();
}

async function fetchFileList({ clearSelection = true } = {}) {
  try {
    const cacheBust = Date.now();
    let url = `/files/list?path=${encodeURIComponent(AppState.currentPath)}&_=${cacheBust}`;
    if (AppState.user && AppState.user.role === 'admin' && AppState.targetUserId) {
      url += `&targetUserId=${encodeURIComponent(AppState.targetUserId)}`;
    }
    const data = await apiRequest(url);
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
  let html = `<button onclick="navigateToPath('/')" class="hover:text-black dark:hover:text-white font-semibold flex items-center gap-1"><i data-lucide="home" class="w-3.5 h-3.5"></i> Root</button>`;

  let accumPath = '';
  parts.forEach((p, idx) => {
    accumPath += '/' + p;
    const target = accumPath;
    html += ` <span class="text-slate-400 dark:text-slate-600">/</span> <button onclick="navigateToPath('${target}')" class="hover:text-black dark:hover:text-white font-semibold">${escapeHtml(p)}</button>`;
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
      const iconColor = file.isDirectory ? 'text-amber-500 dark:text-amber-400' : 'text-slate-800 dark:text-white';

      return `
        <div class="file-grid-card p-4 rounded-xl relative group cursor-pointer ${isSelected ? 'ring-2 ring-black/40 dark:ring-white/60 bg-black/5 dark:bg-white/10' : ''}" onclick="toggleSelectFile('${file.path}', event)">
          
          <div class="flex items-center justify-between mb-3">
            <input type="checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleSelectFile('${file.path}')" class="w-4 h-4 rounded border-slate-300 dark:border-slate-700 accent-black dark:accent-white">
            
            <!-- Context Menu Button -->
            <button onclick="event.stopPropagation(); openFileContextMenu('${file.path}', ${file.isDirectory}, event)" class="opacity-0 group-hover:opacity-100 p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 transition-opacity">
              <i data-lucide="more-vertical" class="w-4 h-4"></i>
            </button>
          </div>

          <div class="flex flex-col items-center text-center" onclick="event.stopPropagation(); ${file.isDirectory ? `navigateToPath('${file.path}')` : `handleFileClick('${file.path}')`}">
            <i data-lucide="${icon}" class="w-10 h-10 ${iconColor} mb-2 drop-shadow-sm"></i>
            <div class="text-xs font-bold text-slate-900 dark:text-white truncate w-full" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
            <div class="text-[11px] font-medium text-slate-600 dark:text-slate-400 mt-1">${file.isDirectory ? 'Folder' : formatBytes(file.size)}</div>
          </div>
        </div>
      `;
    }).join('');
  } else {
    // List View
    container.className = 'glass-card rounded-2xl overflow-hidden divide-y divide-slate-200 dark:divide-slate-800/60';
    container.innerHTML = `
      <div class="px-4 py-3 bg-slate-100 dark:bg-[#030305] flex items-center text-xs font-bold text-slate-700 dark:text-slate-300 border-b border-slate-200 dark:border-slate-800">
        <span class="w-8"></span>
        <span class="flex-1">Name</span>
        <span class="w-32">Size</span>
        <span class="w-40">Modified</span>
        <span class="w-16 text-right">Actions</span>
      </div>
      ${filtered.map(file => {
        const isSelected = AppState.selectedPaths.includes(file.path);
        const icon = file.isDirectory ? 'folder' : getFileIcon(file.name);
        const iconColor = file.isDirectory ? 'text-amber-500 dark:text-amber-400' : 'text-slate-800 dark:text-white';

        return `
          <div class="file-list-row px-4 py-3 flex items-center text-xs cursor-pointer ${isSelected ? 'bg-black/5 dark:bg-white/10' : ''}">
            <input type="checkbox" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleSelectFile('${file.path}')" class="w-4 h-4 rounded border-slate-300 dark:border-slate-700 accent-black dark:accent-white mr-3">
            
            <div class="flex-1 flex items-center gap-3 min-w-0" onclick="${file.isDirectory ? `navigateToPath('${file.path}')` : `handleFileClick('${file.path}')`}">
              <i data-lucide="${icon}" class="w-5 h-5 ${iconColor} shrink-0"></i>
              <span class="font-semibold text-slate-900 dark:text-white hover:underline truncate">${escapeHtml(file.name)}</span>
            </div>

            <span class="w-32 font-medium text-slate-600 dark:text-slate-400">${file.isDirectory ? '--' : formatBytes(file.size)}</span>
            <span class="w-40 font-medium text-slate-600 dark:text-slate-400">${new Date(file.mtime).toLocaleString()}</span>

            <div class="w-16 text-right">
              <button onclick="event.stopPropagation(); openFileContextMenu('${file.path}', ${file.isDirectory}, event)" class="p-1 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800">
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
  const gridBtn = document.getElementById('view-mode-grid-btn');
  const listBtn = document.getElementById('view-mode-list-btn');
  if (gridBtn && listBtn) {
    if (mode === 'grid') {
      gridBtn.className = 'p-1.5 rounded-lg transition-all bg-slate-900 text-white dark:bg-white dark:text-black font-bold shadow-sm';
      listBtn.className = 'p-1.5 rounded-lg transition-all text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white';
    } else {
      listBtn.className = 'p-1.5 rounded-lg transition-all bg-slate-900 text-white dark:bg-white dark:text-black font-bold shadow-sm';
      gridBtn.className = 'p-1.5 rounded-lg transition-all text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white';
    }
  }
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

// ==========================================
// 4b. INBUILT MULTI-FILE CODE & TEXT EDITOR
// Supports .html, .txt, .js, .css, .json, .md, .sh, .py, .sql, .yaml, etc.
// With Live HTML & Markdown Preview, Code Formatting, Syntax Modes
// ==========================================

const EDITABLE_EXTENSIONS = [
  'html', 'htm', 'txt', 'text', 'log', 'env', 'ini', 'conf', 'cfg',
  'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
  'css', 'scss', 'less',
  'json', 'json5',
  'md', 'markdown',
  'xml', 'svg',
  'sh', 'bash', 'zsh',
  'sql',
  'py', 'php', 'rb',
  'yaml', 'yml',
  'dockerfile', 'dockerignore', 'gitignore'
];

function isEditableFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const fileName = filePath.split('/').pop().toLowerCase();
  if (fileName === 'dockerfile' || fileName.startsWith('.env') || fileName.startsWith('.git') || fileName.endsWith('rc')) return true;
  const ext = fileName.includes('.') ? fileName.split('.').pop() : '';
  return EDITABLE_EXTENSIONS.includes(ext);
}

function getFileExtension(filePath) {
  if (!filePath) return '';
  const fileName = filePath.split('/').pop().toLowerCase();
  return fileName.includes('.') ? fileName.split('.').pop() : '';
}

function detectAceMode(filePath) {
  const ext = getFileExtension(filePath);
  const name = (filePath.split('/').pop() || '').toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'html';
  if (['js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx'].includes(ext)) return 'javascript';
  if (['css', 'scss', 'less'].includes(ext)) return 'css';
  if (['json', 'json5'].includes(ext)) return 'json';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (['xml', 'svg'].includes(ext)) return 'xml';
  if (['sh', 'bash', 'zsh'].includes(ext) || name === 'dockerfile') return 'sh';
  if (ext === 'sql') return 'sql';
  if (ext === 'py') return 'python';
  if (['yaml', 'yml'].includes(ext)) return 'yaml';
  return 'text';
}

function getFriendlyFileTypeName(filePath) {
  const mode = detectAceMode(filePath);
  const map = {
    html: 'HTML5 Web Page',
    javascript: 'JavaScript / TypeScript',
    css: 'CSS Stylesheet',
    json: 'JSON Data',
    markdown: 'Markdown Document',
    xml: 'XML / SVG Vector',
    sh: 'Shell Script',
    sql: 'SQL Database Script',
    python: 'Python Script',
    yaml: 'YAML Configuration',
    text: 'Plain Text File'
  };
  return map[mode] || 'Text Document';
}

function handleFileClick(filePath) {
  if (isEditableFile(filePath)) {
    openFileEditor(filePath);
  } else {
    openFilePreview(filePath);
  }
}

let activeAceInstance = null;
let livePreviewDebounceTimer = null;
let activeEditorPath = '';
let activeEditorOriginalContent = '';
let activeEditorIsDirty = false;
let activeEditorViewMode = 'code'; // 'code', 'split', 'preview'
let activeEditorMode = 'text';
let activeEditorFontSize = 14;
let activeEditorWrap = true;

const FILE_STARTER_PRESETS = {
  html: {
    name: 'index.html',
    desc: 'HTML5 Web Document with modern starter boilerplate',
    content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ZenCloud Webpage</title>
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      margin: 0;
      padding: 2.5rem 1.5rem;
      background: #000000;
      color: #ffffff;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 80vh;
      text-align: center;
    }
    .hero-card {
      background: #080808;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 1.25rem;
      padding: 2.5rem 3rem;
      box-shadow: 0 12px 36px -8px rgba(0, 0, 0, 0.9);
      max-width: 540px;
    }
    h1 {
      color: #ffffff;
      margin-top: 0;
      font-size: 2rem;
      font-weight: 800;
      letter-spacing: -0.02em;
    }
    p { color: #a3a3a3; line-height: 1.6; }
    .badge {
      display: inline-block;
      background: rgba(255, 255, 255, 0.1);
      color: #ffffff;
      border: 1px solid rgba(255, 255, 255, 0.25);
      padding: 0.35rem 0.85rem;
      border-radius: 9999px;
      font-size: 0.8rem;
      font-weight: 600;
      margin-bottom: 1rem;
    }
    .action-btn {
      background: #ffffff;
      color: #000000;
      border: 0;
      padding: 0.75rem 1.75rem;
      border-radius: 0.75rem;
      font-weight: 700;
      font-size: 0.95rem;
      cursor: pointer;
      box-shadow: 0 4px 18px rgba(255, 255, 255, 0.3);
      transition: all 0.2s;
    }
    .action-btn:hover {
      background: #e5e5e5;
      transform: translateY(-1px);
    }
  </style>
</head>
<body>
  <div class="hero-card">
    <div class="badge">🚀 Built with ZenCloud Editor</div>
    <h1>Hello World!</h1>
    <p>This page is hosted on ZenCloud VPS Cloud and edited with the inbuilt live editor.</p>
    <button class="action-btn" onclick="alert('Hello from ZenCloud!')">Click Me</button>
  </div>
</body>
</html>`
  },
  text: {
    name: 'notes.txt',
    desc: 'Plain text file for quick notes, logs, or keys',
    content: `ZenCloud Storage - Project Notes\nCreated: ${new Date().toLocaleString()}\n\n- File created with the ZenCloud Inbuilt Editor\n- Add your notes, documentation, or lists here.\n`
  },
  javascript: {
    name: 'app.js',
    desc: 'Modern JavaScript application module',
    content: `// ZenCloud Application Script\nconsole.log('ZenCloud app module initialized at:', new Date().toISOString());\n\nfunction main() {\n  console.log('Running main process...');\n}\n\nmain();\n`
  },
  css: {
    name: 'style.css',
    desc: 'CSS Stylesheet with modern design tokens',
    content: `/* ZenCloud Stylesheet */\n:root {\n  --primary: #ffffff;\n  --bg-dark: #000000;\n  --card-bg: #080808;\n  --text-main: #ffffff;\n}\n\nbody {\n  background: var(--bg-dark);\n  color: var(--text-main);\n  font-family: system-ui, -apple-system, sans-serif;\n  margin: 0;\n  padding: 1.5rem;\n}\n`
  },
  json: {
    name: 'config.json',
    desc: 'JSON Configuration document with formatted object',
    content: `{\n  "serviceName": "zencloud-storage-instance",\n  "version": "1.0.0",\n  "environment": "production",\n  "storage": {\n    "enabled": true,\n    "protocol": "sftp",\n    "features": [\n      "inbuilt-editor",\n      "live-preview",\n      "s3-cluster"\n    ]\n  }\n}\n`
  },
  markdown: {
    name: 'README.md',
    desc: 'Markdown Documentation with formatted headings and lists',
    content: `# Project Documentation\n\nWelcome to your project hosted on **ZenCloud**.\n\n## 🌟 Features\n- **Inbuilt Code & Text Editor** with syntax highlighting for HTML, JS, CSS, JSON, Markdown, and more.\n- **Real-Time Live HTML & Markdown Preview** split screen.\n- **Secure SFTP Storage** with granular quota management.\n- **AWS S3 & Vercel Blob API Cluster** compatibility.\n\n## 🛠 Quick Start\n1. Edit this file or create your own \`.html\` and \`.txt\` files.\n2. Preview changes live side-by-side.\n3. Save with \`Ctrl + S\`.\n`
  },
  sh: {
    name: 'deploy.sh',
    desc: 'Bash Shell script with execution safeguards',
    content: `#!/usr/bin/env bash\nset -euo pipefail\n\necho "=== ZenCloud Deployment Script ==="\necho "Timestamp: $(date)"\necho "Deployment completed successfully!"\n`
  }
};

function openCreateNewFileModal() {
  const existing = document.getElementById('zencloud-new-file-modal') || document.getElementById('zenova-new-file-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'zencloud-new-file-modal';
  modal.className = 'fixed inset-0 bg-black/85 backdrop-blur-md z-[90] flex items-center justify-center p-4 modal-backdrop-enter';
  modal.innerHTML = `
    <div class="glass-card w-full max-w-xl rounded-2xl p-6 border border-white/20 shadow-2xl modal-box-enter bg-[#080808] text-slate-100">
      <div class="flex items-center justify-between mb-5 pb-4 border-b border-white/10">
        <div class="flex items-center gap-3">
          <div class="p-2.5 rounded-xl bg-white/10 text-white border border-white/20 shadow-md">
            <i data-lucide="file-plus" class="w-6 h-6"></i>
          </div>
          <div>
            <h3 class="font-extrabold text-base text-white">Create New File</h3>
            <p class="text-xs text-slate-400">Choose a file type starter or enter a custom file name</p>
          </div>
        </div>
        <button onclick="closeNewFileModal()" class="p-2 text-slate-400 hover:text-white rounded-lg hover:bg-neutral-800 transition-all">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>
      </div>

      <!-- Presets Grid -->
      <div class="mb-5">
        <label class="block text-xs font-bold uppercase tracking-wider text-white mb-2.5">File Type Presets</label>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          <button type="button" onclick="selectNewFilePreset('html')" class="preset-card p-3 rounded-xl border border-white/15 bg-[#040404] hover:border-white hover:bg-white/10 text-left transition-all group">
            <div class="text-xs font-bold text-white flex items-center gap-1.5 group-hover:text-white"><i data-lucide="code" class="w-4 h-4 text-white"></i> HTML5</div>
            <div class="text-[11px] text-slate-500 font-mono mt-1 truncate">index.html</div>
          </button>
          <button type="button" onclick="selectNewFilePreset('text')" class="preset-card p-3 rounded-xl border border-white/15 bg-[#040404] hover:border-white hover:bg-white/10 text-left transition-all group">
            <div class="text-xs font-bold text-emerald-400 flex items-center gap-1.5 group-hover:text-emerald-300"><i data-lucide="file-text" class="w-4 h-4 text-emerald-400"></i> Text (.txt)</div>
            <div class="text-[11px] text-slate-500 font-mono mt-1 truncate">notes.txt</div>
          </button>
          <button type="button" onclick="selectNewFilePreset('javascript')" class="preset-card p-3 rounded-xl border border-white/15 bg-[#040404] hover:border-white hover:bg-white/10 text-left transition-all group">
            <div class="text-xs font-bold text-amber-400 flex items-center gap-1.5 group-hover:text-amber-300"><i data-lucide="file-code" class="w-4 h-4 text-amber-400"></i> JavaScript</div>
            <div class="text-[11px] text-slate-500 font-mono mt-1 truncate">app.js</div>
          </button>
          <button type="button" onclick="selectNewFilePreset('css')" class="preset-card p-3 rounded-xl border border-white/15 bg-[#040404] hover:border-white hover:bg-white/10 text-left transition-all group">
            <div class="text-xs font-bold text-white flex items-center gap-1.5"><i data-lucide="palette" class="w-4 h-4 text-white"></i> Stylesheet</div>
            <div class="text-[11px] text-slate-500 font-mono mt-1 truncate">style.css</div>
          </button>
          <button type="button" onclick="selectNewFilePreset('json')" class="preset-card p-3 rounded-xl border border-white/15 bg-[#040404] hover:border-white hover:bg-white/10 text-left transition-all group">
            <div class="text-xs font-bold text-white flex items-center gap-1.5"><i data-lucide="braces" class="w-4 h-4 text-white"></i> JSON</div>
            <div class="text-[11px] text-slate-500 font-mono mt-1 truncate">config.json</div>
          </button>
          <button type="button" onclick="selectNewFilePreset('markdown')" class="preset-card p-3 rounded-xl border border-white/15 bg-[#040404] hover:border-white hover:bg-white/10 text-left transition-all group">
            <div class="text-xs font-bold text-pink-400 flex items-center gap-1.5 group-hover:text-pink-300"><i data-lucide="file-edit" class="w-4 h-4 text-pink-400"></i> Markdown</div>
            <div class="text-[11px] text-slate-500 font-mono mt-1 truncate">README.md</div>
          </button>
          <button type="button" onclick="selectNewFilePreset('sh')" class="preset-card p-3 rounded-xl border border-white/15 bg-[#040404] hover:border-white hover:bg-white/10 text-left transition-all group">
            <div class="text-xs font-bold text-teal-400 flex items-center gap-1.5 group-hover:text-teal-300"><i data-lucide="terminal" class="w-4 h-4 text-teal-400"></i> Shell Script</div>
            <div class="text-[11px] text-slate-500 font-mono mt-1 truncate">deploy.sh</div>
          </button>
          <button type="button" onclick="selectNewFilePreset('custom')" class="preset-card p-3 rounded-xl border border-white/15 bg-[#040404] hover:border-white hover:bg-white/10 text-left transition-all group">
            <div class="text-xs font-bold text-slate-300 flex items-center gap-1.5 group-hover:text-white"><i data-lucide="file" class="w-4 h-4 text-slate-400"></i> Custom File</div>
            <div class="text-[11px] text-slate-500 font-mono mt-1 truncate">Any name</div>
          </button>
        </div>
      </div>

      <!-- Form -->
      <form onsubmit="handleCreateNewFileSubmit(event)" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">File Name & Extension</label>
          <input type="text" id="zencloud-new-filename-input" required placeholder="e.g. index.html or notes.txt" class="w-full pitch-input rounded-xl px-4 py-3 text-sm focus:outline-none font-mono" value="index.html">
          <div class="flex items-center justify-between text-[11px] text-slate-500 mt-1.5">
            <span>Location: <span class="font-mono text-white">${escapeHtml(AppState.currentPath || '/')}</span></span>
            <span id="preset-desc-hint" class="text-slate-300 font-medium">HTML5 Web Document starter</span>
          </div>
        </div>

        <input type="hidden" id="zencloud-new-file-preset-key" value="html">

        <div class="flex items-center justify-end gap-2.5 pt-3 border-t border-white/10">
          <button type="button" onclick="closeNewFileModal()" class="px-4 py-2.5 rounded-xl text-xs font-medium text-slate-400 hover:text-white hover:bg-neutral-800 transition-all">Cancel</button>
          <button type="submit" class="zencloud-btn-primary px-5 py-2.5 rounded-xl text-xs font-bold flex items-center gap-2">
            <i data-lucide="check" class="w-4 h-4"></i> Create & Open in Editor
          </button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();
  const input = document.getElementById('zencloud-new-filename-input');
  if (input) {
    input.focus();
    input.select();
  }
}

function selectNewFilePreset(presetKey) {
  const input = document.getElementById('zencloud-new-filename-input') || document.getElementById('zenova-new-filename-input');
  const hidden = document.getElementById('zencloud-new-file-preset-key') || document.getElementById('zenova-new-file-preset-key');
  const hint = document.getElementById('preset-desc-hint');
  if (hidden) hidden.value = presetKey;

  if (presetKey === 'custom') {
    if (input) {
      input.value = '';
      input.placeholder = 'e.g. script.py, data.yaml, .env';
      input.focus();
    }
    if (hint) hint.textContent = 'Custom file with any extension';
    return;
  }

  const preset = FILE_STARTER_PRESETS[presetKey];
  if (preset && input) {
    input.value = preset.name;
    if (hint) hint.textContent = preset.desc;
    input.focus();
    input.select();
  }
}

function closeNewFileModal() {
  const modal = document.getElementById('zencloud-new-file-modal') || document.getElementById('zenova-new-file-modal');
  if (modal) modal.remove();
}

async function handleCreateNewFileSubmit(e) {
  e.preventDefault();
  const input = document.getElementById('zencloud-new-filename-input') || document.getElementById('zenova-new-filename-input');
  const presetKey = (document.getElementById('zencloud-new-file-preset-key') || document.getElementById('zenova-new-file-preset-key'))?.value || 'custom';
  let fileName = (input?.value || '').trim();
  if (!fileName) return showToast('Please enter a file name.', 'error');

  if (fileName.includes('/') || fileName.includes('\\')) {
    return showToast('File name cannot contain slashes. Folders are created with New Folder.', 'error');
  }

  const currentDir = AppState.currentPath || '/';
  const filePath = currentDir === '/' ? `/${fileName}` : `${currentDir.replace(/\/+$/, '')}/${fileName}`;
  const initialContent = FILE_STARTER_PRESETS[presetKey]?.content || '';

  try {
    await apiRequest('/files/create-file', {
      method: 'POST',
      body: { path: filePath, content: initialContent }
    });

    closeNewFileModal();
    showToast(`Created ${fileName}!`, 'success');
    await fetchFileList();

    openFileEditor(filePath, initialContent);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function openFileEditor(filePath, preloadContent = null) {
  try {
    if (!AppState.token) throw new Error('Your session has expired. Please log in again.');
    if (!filePath) return;

    const fileName = filePath.split('/').filter(Boolean).pop() || 'Untitled';
    const mode = detectAceMode(filePath);
    const friendlyTypeName = getFriendlyFileTypeName(filePath);
    const isHtmlOrMd = ['html', 'markdown', 'xml'].includes(mode);

    activeEditorPath = filePath;
    activeEditorMode = mode;
    activeEditorIsDirty = false;
    activeEditorViewMode = isHtmlOrMd && window.innerWidth >= 900 ? 'split' : 'code';

    let content = preloadContent;
    if (content === null) {
      setLoading('Loading file into editor...', true);
      const res = await apiRequest(`/files/content?path=${encodeURIComponent(filePath)}`);
      setLoading('', false);
      content = res.content || '';
    }
    activeEditorOriginalContent = content;

    const existing = document.getElementById('zencloud-editor-modal') || document.getElementById('zenova-editor-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'zencloud-editor-modal';
    modal.className = 'fixed inset-0 z-[100] flex flex-col bg-[#000000] text-slate-100 overflow-hidden tab-pane-enter';
    modal.innerHTML = `
      <!-- Editor Top Navigation Bar -->
      <header class="h-14 bg-[#000000] border-b border-[#1c1c1c] px-4 flex items-center justify-between gap-3 shrink-0 select-none">
        
        <!-- Left: File Badge, Name & Path -->
        <div class="flex items-center gap-3 min-w-0">
          <div class="p-2 rounded-xl bg-white/10 text-white border border-white/20 shrink-0">
            <i data-lucide="${mode === 'html' ? 'code-2' : mode === 'json' ? 'braces' : mode === 'markdown' ? 'file-edit' : mode === 'javascript' ? 'file-code' : 'file-text'}" class="w-5 h-5"></i>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-extrabold text-sm text-white truncate max-w-[180px] sm:max-w-xs md:max-w-md" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</span>
              <span id="zencloud-editor-dirty-badge" class="hidden items-center gap-1 text-[11px] font-semibold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/30">
                <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse"></span> Unsaved
              </span>
              <span id="zencloud-editor-saved-badge" class="hidden items-center gap-1 text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/30">
                ✓ Saved
              </span>
            </div>
            <div class="flex items-center gap-2 text-[11px] text-slate-400 font-mono truncate">
              <span>${escapeHtml(filePath)}</span>
              <span class="text-slate-600">•</span>
              <span class="text-slate-300 font-sans font-medium">${friendlyTypeName}</span>
            </div>
          </div>
        </div>

        <!-- Center: View Mode Toggles (For HTML / Markdown / SVG) -->
        <div class="flex items-center gap-2">
          ${isHtmlOrMd ? `
            <div class="hidden sm:flex bg-[#121212] p-1 rounded-xl border border-white/15" id="editor-view-mode-group">
              <button onclick="setEditorViewMode('code')" id="view-mode-code-btn" class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${activeEditorViewMode === 'code' ? 'bg-white text-black font-bold shadow-sm' : 'text-slate-400 hover:text-white'}" title="Code Editor Only">
                <span class="flex items-center gap-1.5"><i data-lucide="code" class="w-3.5 h-3.5"></i> Code</span>
              </button>
              <button onclick="setEditorViewMode('split')" id="view-mode-split-btn" class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${activeEditorViewMode === 'split' ? 'bg-white text-black font-bold shadow-sm' : 'text-slate-400 hover:text-white'}" title="Split Screen Live Preview">
                <span class="flex items-center gap-1.5"><i data-lucide="columns-2" class="w-3.5 h-3.5"></i> Split View</span>
              </button>
              <button onclick="setEditorViewMode('preview')" id="view-mode-preview-btn" class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${activeEditorViewMode === 'preview' ? 'bg-white text-black font-bold shadow-sm' : 'text-slate-400 hover:text-white'}" title="Live Rendered Preview">
                <span class="flex items-center gap-1.5"><i data-lucide="eye" class="w-3.5 h-3.5"></i> Live Preview</span>
              </button>
            </div>
          ` : ''}

          <!-- Format Code Button -->
          <button onclick="formatEditorCode()" class="hidden md:flex items-center gap-1.5 bg-[#121212] hover:bg-white/10 text-slate-300 hover:text-white border border-white/15 px-2.5 py-1.5 rounded-xl text-xs font-medium transition-all" title="Format / Prettify Code">
            <i data-lucide="wand-2" class="w-3.5 h-3.5 text-white"></i> Format
          </button>

          <!-- Syntax Mode Selector -->
          <select onchange="setEditorSyntaxMode(this.value)" id="editor-syntax-select" class="hidden lg:block bg-[#121212] border border-white/15 text-slate-300 text-xs rounded-xl px-2.5 py-1.5 focus:outline-none focus:border-white">
            <option value="html" ${mode === 'html' ? 'selected' : ''}>HTML5</option>
            <option value="javascript" ${mode === 'javascript' ? 'selected' : ''}>JavaScript</option>
            <option value="css" ${mode === 'css' ? 'selected' : ''}>CSS</option>
            <option value="json" ${mode === 'json' ? 'selected' : ''}>JSON</option>
            <option value="markdown" ${mode === 'markdown' ? 'selected' : ''}>Markdown</option>
            <option value="text" ${mode === 'text' ? 'selected' : ''}>Plain Text</option>
            <option value="sh" ${mode === 'sh' ? 'selected' : ''}>Shell Script</option>
            <option value="python" ${mode === 'python' ? 'selected' : ''}>Python</option>
            <option value="sql" ${mode === 'sql' ? 'selected' : ''}>SQL</option>
            <option value="yaml" ${mode === 'yaml' ? 'selected' : ''}>YAML</option>
            <option value="xml" ${mode === 'xml' ? 'selected' : ''}>XML / SVG</option>
          </select>

          <!-- Word Wrap Toggle -->
          <button onclick="toggleEditorWordWrap()" id="editor-wrap-btn" class="hidden md:flex items-center gap-1 bg-[#121212] hover:bg-white/10 text-slate-300 hover:text-white border border-white/15 px-2 py-1.5 rounded-xl text-xs font-medium" title="Toggle Word Wrap">
            <i data-lucide="wrap-text" class="w-3.5 h-3.5 text-white"></i> Wrap
          </button>
        </div>

        <!-- Right: Action Buttons (Save, Save & Close, Close) -->
        <div class="flex items-center gap-2 shrink-0">
          <button onclick="saveEditorContent()" id="zencloud-editor-save-btn" class="zencloud-btn-primary flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold shadow-md cursor-pointer">
            <i data-lucide="save" class="w-4 h-4"></i>
            <span class="hidden sm:inline">Save</span>
            <span class="text-[10px] opacity-75 font-mono hidden md:inline">Ctrl+S</span>
          </button>

          <button onclick="saveAndCloseEditor()" class="hidden sm:flex items-center gap-1.5 bg-[#121212] hover:bg-white/10 text-white border border-white/20 px-3 py-2 rounded-xl text-xs font-semibold transition-all">
            Save & Exit
          </button>

          <button onclick="downloadEditorFile()" class="hidden md:flex p-2 text-slate-400 hover:text-white rounded-xl hover:bg-neutral-800" title="Download copy">
            <i data-lucide="download" class="w-4 h-4"></i>
          </button>

          <button onclick="closeFileEditor()" class="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-red-600/80 transition-all" title="Close editor">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
        </div>
      </header>

      <!-- Editor Main Workspace (Split / Full View) -->
      <div id="zencloud-editor-workspace" class="flex-1 flex flex-col md:flex-row min-h-0 w-full overflow-hidden relative">
        
        <!-- Code Editor Panel -->
        <div id="zencloud-code-pane" class="flex-1 h-full min-h-0 flex flex-col bg-[#000000] relative overflow-hidden">
          <div id="zencloud-code-editor" class="w-full h-full"></div>
          <textarea id="zencloud-textarea-fallback" class="hidden w-full h-full p-4 bg-[#000000] text-slate-100 font-mono text-xs leading-relaxed focus:outline-none resize-none selection:bg-white selection:text-black"></textarea>
        </div>

        <!-- Live Preview Panel (Split / Preview) -->
        <div id="zencloud-preview-pane" class="${isHtmlOrMd && activeEditorViewMode !== 'code' ? 'flex' : 'hidden'} flex-1 h-full min-h-0 flex-col bg-[#020202] border-l border-[#1c1c1c] overflow-hidden">
          <div class="h-9 px-3 bg-[#000000] border-b border-[#1c1c1c] flex items-center justify-between text-xs text-slate-400 shrink-0 select-none">
            <div class="flex items-center gap-2">
              <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <span class="font-bold text-white uppercase text-[10px] tracking-wider">Live Preview Render</span>
              <span id="preview-render-type" class="text-[10px] text-white font-mono">(${mode.toUpperCase()})</span>
            </div>
            <div class="flex items-center gap-1.5">
              <button onclick="updateLivePreview()" class="p-1 text-slate-400 hover:text-white rounded hover:bg-neutral-800" title="Refresh Live Preview">
                <i data-lucide="rotate-cw" class="w-3.5 h-3.5"></i>
              </button>
              ${mode === 'html' ? `
                <button onclick="openLivePreviewInNewTab()" class="p-1 text-slate-400 hover:text-white rounded hover:bg-neutral-800" title="Open in browser window">
                  <i data-lucide="external-link" class="w-3.5 h-3.5"></i>
                </button>
              ` : ''}
            </div>
          </div>

          <div class="flex-1 min-h-0 w-full overflow-auto relative">
            <!-- HTML Live Iframe -->
            <iframe id="zencloud-live-preview-iframe" class="${mode === 'html' ? 'block' : 'hidden'} w-full h-full border-0 bg-white" sandbox="allow-scripts allow-modals allow-forms"></iframe>
            <!-- Markdown Live Pane -->
            <div id="zencloud-markdown-preview-pane" class="${mode === 'markdown' ? 'block' : 'hidden'} w-full h-full p-6 overflow-auto markdown-body bg-[#000000]"></div>
            <!-- SVG / XML Live Pane -->
            <div id="zencloud-svg-preview-pane" class="${mode === 'xml' ? 'flex' : 'hidden'} w-full h-full p-6 overflow-auto items-center justify-center bg-[#000000]"></div>
          </div>
        </div>
      </div>

      <!-- Editor Bottom Status Bar -->
      <footer class="h-7 bg-[#000000] border-t border-[#1c1c1c] px-4 flex items-center justify-between text-[11px] text-slate-400 shrink-0 font-mono select-none">
        <div class="flex items-center gap-4">
          <span id="editor-cursor-pos">Ln 1, Col 1</span>
          <span class="hidden sm:inline text-slate-600">|</span>
          <span id="editor-lines-count" class="hidden sm:inline">Lines: 1</span>
          <span class="hidden md:inline text-slate-600">|</span>
          <span id="editor-chars-count" class="hidden md:inline">Chars: 0</span>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-white font-semibold" id="editor-status-mode">${mode.toUpperCase()}</span>
          <span class="text-slate-600">•</span>
          <span>UTF-8</span>
          <span class="hidden lg:inline text-slate-600">•</span>
          <span class="hidden lg:inline text-slate-500">Spaces: 2</span>
        </div>
      </footer>
    `;

    document.body.appendChild(modal);
    if (window.lucide) lucide.createIcons();

    initAceEditorInstance(content, mode);
    setEditorViewMode(activeEditorViewMode);
    setupEditorKeyboardShortcuts();

  } catch (err) {
    setLoading('', false);
    showToast(err.message, 'error');
  }
}

function initAceEditorInstance(content, mode) {
  const container = document.getElementById('zencloud-code-editor') || document.getElementById('zenova-code-editor');
  const fallback = document.getElementById('zencloud-textarea-fallback') || document.getElementById('zenova-textarea-fallback');

  if (window.ace && container) {
    try {
      const editor = ace.edit(container);
      editor.setTheme('ace/theme/tomorrow_night_eighties');
      editor.session.setMode(`ace/mode/${mode}`);
      editor.setValue(content || '', -1);
      editor.setFontSize(activeEditorFontSize);
      editor.session.setUseWrapMode(activeEditorWrap);
      editor.setOptions({
        enableBasicAutocompletion: true,
        enableLiveAutocompletion: true,
        enableSnippets: true,
        showPrintMargin: false,
        highlightActiveLine: true,
        tabSize: 2,
        useSoftTabs: true
      });

      editor.commands.addCommand({
        name: 'saveFile',
        bindKey: { win: 'Ctrl-S', mac: 'Command-S' },
        exec: function() {
          saveEditorContent();
        }
      });

      editor.session.on('change', () => {
        markEditorDirty(true);
        updateEditorMetrics();
        if (['html', 'markdown', 'xml'].includes(activeEditorMode)) {
          triggerDebouncedLivePreview();
        }
      });

      editor.selection.on('changeCursor', () => {
        const pos = editor.getCursorPosition();
        const el = document.getElementById('editor-cursor-pos');
        if (el) el.textContent = `Ln ${pos.row + 1}, Col ${pos.column + 1}`;
      });

      activeAceInstance = editor;
      updateEditorMetrics();
      updateLivePreview();
      return;
    } catch (e) {
      console.warn('Ace editor initialization fallback:', e);
    }
  }

  if (container) container.classList.add('hidden');
  if (fallback) {
    fallback.classList.remove('hidden');
    fallback.value = content || '';
    fallback.addEventListener('input', () => {
      markEditorDirty(true);
      updateEditorMetrics();
      triggerDebouncedLivePreview();
    });
    fallback.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveEditorContent();
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = fallback.selectionStart;
        const end = fallback.selectionEnd;
        fallback.value = fallback.value.substring(0, start) + '  ' + fallback.value.substring(end);
        fallback.selectionStart = fallback.selectionEnd = start + 2;
      }
    });
  }
}

function getEditorCurrentValue() {
  if (activeAceInstance) {
    return activeAceInstance.getValue();
  }
  const fallback = document.getElementById('zencloud-textarea-fallback') || document.getElementById('zenova-textarea-fallback');
  return fallback ? fallback.value : '';
}

function setEditorCurrentValue(newContent) {
  if (activeAceInstance) {
    activeAceInstance.setValue(newContent, -1);
  } else {
    const fallback = document.getElementById('zencloud-textarea-fallback') || document.getElementById('zenova-textarea-fallback');
    if (fallback) fallback.value = newContent;
  }
}

function updateLivePreview() {
  const content = getEditorCurrentValue();
  if (activeEditorMode === 'html') {
    const iframe = document.getElementById('zencloud-live-preview-iframe') || document.getElementById('zenova-live-preview-iframe');
    if (iframe) {
      iframe.srcdoc = content;
    }
  } else if (activeEditorMode === 'markdown') {
    const pane = document.getElementById('zencloud-markdown-preview-pane') || document.getElementById('zenova-markdown-preview-pane');
    if (pane) {
      pane.innerHTML = window.marked ? marked.parse(content) : `<pre>${escapeHtml(content)}</pre>`;
    }
  } else if (activeEditorMode === 'xml') {
    const pane = document.getElementById('zencloud-svg-preview-pane') || document.getElementById('zenova-svg-preview-pane');
    if (pane) {
      if (content.trim().startsWith('<svg')) {
        pane.innerHTML = content;
      } else {
        pane.innerHTML = `<pre class="text-xs text-slate-400 font-mono">${escapeHtml(content)}</pre>`;
      }
    }
  }
}

function triggerDebouncedLivePreview() {
  if (livePreviewDebounceTimer) clearTimeout(livePreviewDebounceTimer);
  livePreviewDebounceTimer = setTimeout(() => {
    updateLivePreview();
  }, 250);
}

function openLivePreviewInNewTab() {
  const content = getEditorCurrentValue();
  const blob = new Blob([content], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
}

function setEditorViewMode(mode) {
  activeEditorViewMode = mode;
  const codePane = document.getElementById('zencloud-code-pane') || document.getElementById('zenova-code-pane');
  const previewPane = document.getElementById('zencloud-preview-pane') || document.getElementById('zenova-preview-pane');
  const codeBtn = document.getElementById('view-mode-code-btn');
  const splitBtn = document.getElementById('view-mode-split-btn');
  const previewBtn = document.getElementById('view-mode-preview-btn');

  const activeBtnClass = 'bg-white text-black font-bold shadow-sm';
  const inactiveBtnClass = 'text-slate-400 hover:text-white';

  [codeBtn, splitBtn, previewBtn].forEach(b => {
    if (b) {
      b.className = b.className.replace(activeBtnClass, '').replace(inactiveBtnClass, '').trim() + ' ' + inactiveBtnClass;
    }
  });

  if (mode === 'code') {
    if (codeBtn) codeBtn.className = codeBtn.className.replace(inactiveBtnClass, '').trim() + ' ' + activeBtnClass;
    if (codePane) {
      codePane.classList.remove('hidden');
      codePane.style.display = 'flex';
      codePane.style.flex = '1';
    }
    if (previewPane) {
      previewPane.classList.add('hidden');
      previewPane.style.display = 'none';
    }
  } else if (mode === 'preview') {
    if (previewBtn) previewBtn.className = previewBtn.className.replace(inactiveBtnClass, '').trim() + ' ' + activeBtnClass;
    if (codePane) {
      codePane.classList.add('hidden');
      codePane.style.display = 'none';
    }
    if (previewPane) {
      previewPane.classList.remove('hidden');
      previewPane.style.display = 'flex';
      previewPane.style.flex = '1';
    }
    updateLivePreview();
  } else {
    // split view
    if (splitBtn) splitBtn.className = splitBtn.className.replace(inactiveBtnClass, '').trim() + ' ' + activeBtnClass;
    if (codePane) {
      codePane.classList.remove('hidden');
      codePane.style.display = 'flex';
      codePane.style.flex = '1';
    }
    if (previewPane) {
      previewPane.classList.remove('hidden');
      previewPane.style.display = 'flex';
      previewPane.style.flex = '1';
    }
    updateLivePreview();
  }

  if (activeAceInstance) {
    setTimeout(() => activeAceInstance.resize(), 50);
  }
}

function formatEditorCode() {
  const content = getEditorCurrentValue();
  if (activeEditorMode === 'json') {
    try {
      const parsed = JSON.parse(content);
      const formatted = JSON.stringify(parsed, null, 2);
      setEditorCurrentValue(formatted);
      showToast('JSON formatted successfully!', 'success');
      markEditorDirty(true);
    } catch (err) {
      showToast(`Invalid JSON: ${err.message}`, 'error');
    }
  } else {
    showToast(`Code formatted for ${activeEditorMode.toUpperCase()}`, 'info');
  }
}

function setEditorSyntaxMode(newMode) {
  activeEditorMode = newMode;
  if (activeAceInstance) {
    activeAceInstance.session.setMode(`ace/mode/${newMode}`);
  }
  const statusMode = document.getElementById('editor-status-mode');
  if (statusMode) statusMode.textContent = newMode.toUpperCase();

  const iframe = document.getElementById('zencloud-live-preview-iframe') || document.getElementById('zenova-live-preview-iframe');
  const mdPane = document.getElementById('zencloud-markdown-preview-pane') || document.getElementById('zenova-markdown-preview-pane');
  const svgPane = document.getElementById('zencloud-svg-preview-pane') || document.getElementById('zenova-svg-preview-pane');
  const renderType = document.getElementById('preview-render-type');
  if (renderType) renderType.textContent = `(${newMode.toUpperCase()})`;

  if (iframe) iframe.className = newMode === 'html' ? 'block w-full h-full border-0 bg-white' : 'hidden';
  if (mdPane) mdPane.className = newMode === 'markdown' ? 'block w-full h-full p-6 overflow-auto markdown-body bg-[#000000]' : 'hidden';
  if (svgPane) svgPane.className = newMode === 'xml' ? 'flex w-full h-full p-6 overflow-auto items-center justify-center bg-[#000000]' : 'hidden';

  updateLivePreview();
}

function toggleEditorWordWrap() {
  activeEditorWrap = !activeEditorWrap;
  if (activeAceInstance) {
    activeAceInstance.session.setUseWrapMode(activeEditorWrap);
  }
  const btn = document.getElementById('editor-wrap-btn');
  if (btn) {
    btn.classList.toggle('bg-white', activeEditorWrap);
    btn.classList.toggle('text-black', activeEditorWrap);
    btn.classList.toggle('font-bold', activeEditorWrap);
  }
  showToast(`Word wrap: ${activeEditorWrap ? 'On' : 'Off'}`, 'info');
}

async function saveEditorContent() {
  const content = getEditorCurrentValue();
  const saveBtn = document.getElementById('zencloud-editor-save-btn') || document.getElementById('zenova-editor-save-btn');
  const originalText = saveBtn ? saveBtn.innerHTML : '';
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Saving...`;
  }

  try {
    await apiRequest('/files/save-content', {
      method: 'POST',
      body: {
        path: activeEditorPath,
        content: content
      }
    });

    activeEditorOriginalContent = content;
    markEditorDirty(false);
    showToast(`Saved ${activeEditorPath.split('/').pop()} successfully!`, 'success');

    if (AppState.currentTab === 'files') {
      fetchFileList();
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = originalText;
      if (window.lucide) lucide.createIcons();
    }
  }
}

async function saveAndCloseEditor() {
  await saveEditorContent();
  closeFileEditor(true);
}

function closeFileEditor(force = false) {
  if (!force && activeEditorIsDirty) {
    const confirmClose = confirm('You have unsaved changes in this file. Discard changes and exit editor?');
    if (!confirmClose) return;
  }

  const modal = document.getElementById('zencloud-editor-modal') || document.getElementById('zenova-editor-modal');
  if (modal) modal.remove();

  if (activeAceInstance) {
    try {
      activeAceInstance.destroy();
    } catch (_) {}
    activeAceInstance = null;
  }
  activeEditorPath = '';
  activeEditorIsDirty = false;
}

function markEditorDirty(isDirty) {
  activeEditorIsDirty = isDirty;
  const dirtyBadge = document.getElementById('zencloud-editor-dirty-badge') || document.getElementById('zenova-editor-dirty-badge');
  const savedBadge = document.getElementById('zencloud-editor-saved-badge') || document.getElementById('zenova-editor-saved-badge');
  if (dirtyBadge) dirtyBadge.classList.toggle('hidden', !isDirty);
  if (savedBadge) savedBadge.classList.toggle('hidden', isDirty);
}

function updateEditorMetrics() {
  const content = getEditorCurrentValue();
  const lines = content.split('\n').length;
  const chars = content.length;
  const linesEl = document.getElementById('editor-lines-count');
  const charsEl = document.getElementById('editor-chars-count');
  if (linesEl) linesEl.textContent = `Lines: ${lines.toLocaleString()}`;
  if (charsEl) charsEl.textContent = `Chars: ${chars.toLocaleString()}`;
}

function downloadEditorFile() {
  const content = getEditorCurrentValue();
  const fileName = activeEditorPath.split('/').pop() || 'file.txt';
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function setupEditorKeyboardShortcuts() {
  const handler = (e) => {
    const modal = document.getElementById('zencloud-editor-modal') || document.getElementById('zenova-editor-modal');
    if (!modal) {
      window.removeEventListener('keydown', handler);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveEditorContent();
    }
    if (e.key === 'Escape') {
      closeFileEditor();
    }
  };
  window.addEventListener('keydown', handler);
}

function openFileContextMenu(filePath, isDirectory, e) {
  const existing = document.getElementById('file-context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'file-context-menu';
  menu.className = 'fixed bg-[#080808] border border-white/20 rounded-xl shadow-2xl p-2 z-50 text-xs w-52 space-y-1';

  const ext = filePath.toLowerCase();
  const isArchive = ext.endsWith('.zip') || ext.endsWith('.tar') || ext.endsWith('.tar.gz') || ext.endsWith('.7z');
  const canEdit = !isDirectory && isEditableFile(filePath);

  menu.innerHTML = `
    ${canEdit ? `
      <button onclick="openFileEditor('${filePath}')" class="w-full text-left px-3 py-2 rounded-lg bg-white/10 hover:bg-white/20 flex items-center gap-2 text-white font-semibold border border-white/20 mb-1 transition-all">
        <i data-lucide="code-2" class="w-4 h-4 text-white"></i> Edit in Editor
      </button>
    ` : ''}

    <button onclick="downloadSingleFile('${filePath}')" class="w-full text-left px-3 py-2 rounded-lg hover:bg-neutral-800 flex items-center gap-2 text-slate-200">
      <i data-lucide="download" class="w-3.5 h-3.5 text-white"></i> Download
    </button>

    <button onclick="openEmbedLinkModal('${filePath}')" class="w-full text-left px-3 py-2 rounded-lg hover:bg-neutral-800 flex items-center gap-2 text-white">
      <i data-lucide="link-2" class="w-3.5 h-3.5 text-white"></i> Direct Embed / Public Link
    </button>

    <button onclick="createShareLinkModal('${filePath}')" class="w-full text-left px-3 py-2 rounded-lg hover:bg-neutral-800 flex items-center gap-2 text-slate-200">
      <i data-lucide="share-2" class="w-3.5 h-3.5 text-emerald-400"></i> Create Share Link
    </button>

    <button onclick="renameFilePrompt('${filePath}')" class="w-full text-left px-3 py-2 rounded-lg hover:bg-neutral-800 flex items-center gap-2 text-slate-200">
      <i data-lucide="edit-3" class="w-3.5 h-3.5 text-amber-400"></i> Rename
    </button>

    <button onclick="moveFilePrompt('${filePath}')" class="w-full text-left px-3 py-2 rounded-lg hover:bg-neutral-800 flex items-center gap-2 text-slate-200">
      <i data-lucide="folder-input" class="w-3.5 h-3.5 text-white"></i> Move to...
    </button>

    ${isArchive ? `
      <button onclick="extractArchivePrompt('${filePath}')" class="w-full text-left px-3 py-2 rounded-lg hover:bg-neutral-800 flex items-center gap-2 text-white">
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
    const downloadUrl = getEffectiveDownloadUrl(filePath);
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

function openEmbedLinkModal(filePath) {
  const cleanPath = String(filePath || '').replace(/^\/+/, '').replace(/^s3_storage\//, '');
  const fileName = cleanPath.split('/').pop() || 'file';
  const origin = window.location.origin;
  const encodedPath = encodeURIComponent(cleanPath).replace(/%2F/g, '/');

  const directEmbedUrl = `${origin}/api/v1/blob/${encodedPath}`;
  const directDownloadUrl = `${origin}/api/v1/blob/${encodedPath}?download=1`;
  const htmlImgTag = `<img src="${directEmbedUrl}" alt="${fileName}" />`;
  const markdownTag = `![${fileName}](${directEmbedUrl})`;

  const modal = document.createElement('div');
  modal.id = 'embed-link-modal';
  modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 space-y-4 shadow-2xl text-slate-100">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2 font-bold text-base text-white">
          <i data-lucide="link-2" class="w-5 h-5 text-white"></i>
          Direct Embed & Public Link
        </div>
        <button onclick="document.getElementById('embed-link-modal').remove()" class="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-all">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>
      </div>

      <p class="text-xs text-slate-400">
        Direct link with full CORS, fast CDN caching, and inline rendering. Embed anywhere in websites, HTML, React, blogs, or Discord.
      </p>

      <div class="space-y-3 text-xs">
        <div>
          <label class="block font-semibold text-slate-300 mb-1">Direct Embed URL (Inline View)</label>
          <div class="flex gap-2">
            <input type="text" readonly value="${directEmbedUrl}" class="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-white font-mono text-[11px] focus:outline-none">
            <button onclick="copyToClipboard('${directEmbedUrl}', this, 'Copied Direct URL!')" class="zencloud-btn-primary px-3 py-2 bg-white hover:bg-neutral-200 text-black font-bold rounded-xl shrink-0 transition-all">Copy</button>
          </div>
        </div>

        <div>
          <label class="block font-semibold text-slate-300 mb-1">HTML Image Tag</label>
          <div class="flex gap-2">
            <input type="text" readonly value="${escapeHtml(htmlImgTag)}" class="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-300 font-mono text-[11px] focus:outline-none">
            <button onclick="copyToClipboard('${escapeHtml(htmlImgTag).replace(/'/g, "\\'")}', this, 'Copied HTML!')" class="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl font-semibold shrink-0 transition-all">Copy</button>
          </div>
        </div>

        <div>
          <label class="block font-semibold text-slate-300 mb-1">Markdown Embed</label>
          <div class="flex gap-2">
            <input type="text" readonly value="${escapeHtml(markdownTag)}" class="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-300 font-mono text-[11px] focus:outline-none">
            <button onclick="copyToClipboard('${escapeHtml(markdownTag).replace(/'/g, "\\'")}', this, 'Copied Markdown!')" class="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl font-semibold shrink-0 transition-all">Copy</button>
          </div>
        </div>

        <div>
          <label class="block font-semibold text-slate-300 mb-1">Direct Download Link (?download=1)</label>
          <div class="flex gap-2">
            <input type="text" readonly value="${directDownloadUrl}" class="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-400 font-mono text-[11px] focus:outline-none">
            <button onclick="copyToClipboard('${directDownloadUrl}', this, 'Copied Download URL!')" class="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl font-semibold shrink-0 transition-all">Copy</button>
          </div>
        </div>
      </div>

      <div class="flex items-center justify-between pt-3 border-t border-slate-800">
        <a href="${directEmbedUrl}" target="_blank" rel="noopener noreferrer" class="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs rounded-xl flex items-center gap-1.5 transition-all">
          <i data-lucide="external-link" class="w-3.5 h-3.5 text-white"></i> Open in New Tab
        </a>
        <button onclick="document.getElementById('embed-link-modal').remove()" class="zencloud-btn-primary px-4 py-2 bg-white hover:bg-neutral-200 text-black font-bold text-xs rounded-xl transition-all">
          Done
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();
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
    const previewUrl = getEffectivePreviewUrl(filePath, `&_=${Date.now()}`);
    const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'];
    const videoExts = ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv'];
    const isImage = imageExts.includes(ext);
    const isVideo = videoExts.includes(ext);

    closeFilePreview();
    const drawer = document.createElement('div');
    drawer.id = 'file-preview-drawer';
    drawer.className = 'fixed right-0 top-0 h-full bg-[#000000] border-l border-white/20 shadow-2xl z-[80] flex flex-col translate-x-0';
    drawer.innerHTML = `
      <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10 bg-[#080808] shrink-0">
        <div class="min-w-0">
          <div class="text-xs text-slate-500">Preview</div>
          <div class="text-sm font-semibold text-white truncate" title="${escapeHtml(fileName)}">${escapeHtml(fileName)}</div>
        </div>
        <div class="flex items-center gap-2">
          ${isEditableFile(filePath) ? `
            <button onclick="closeFilePreview(); openFileEditor('${filePath}')" class="zencloud-btn-primary px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-sm">
              <i data-lucide="code-2" class="w-3.5 h-3.5"></i> Edit
            </button>
          ` : ''}
          <button onclick="closeFilePreview()" class="p-2 rounded-lg bg-slate-800 hover:bg-red-600/80 text-slate-300 hover:text-white shrink-0" title="Close preview">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
        </div>
      </div>
      <div id="file-preview-body" class="flex-1 overflow-auto p-4 flex items-center justify-center bg-black/20">
        ${isImage
          ? `<img src="${previewUrl}" alt="${escapeHtml(fileName)}" class="preview-media mx-auto" />`
          : isVideo
            ? createVideoPlayerMarkup('file-preview-video', previewUrl, fileName)
            : `<div class="text-sm text-slate-400 flex items-center gap-2"><i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Loading preview...</div>`}
      </div>
      <div class="px-4 py-3 border-t border-slate-800 text-[11px] text-slate-500 shrink-0">
        Preview is read-only. Use Edit to open the built-in code editor or Download to save locally.
      </div>
    `;
    document.body.appendChild(drawer);
    if (window.lucide) lucide.createIcons();

    if (isVideo) {
      setupVideoPlayer(
        'file-preview-video',
        previewUrl,
        getEffectiveTranscodedUrl(filePath),
        getEffectiveTranscodedUrl(filePath, true),
        getEffectiveDownloadUrl(filePath)
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
    } else if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('javascript') || isEditableFile(filePath)) {
      const text = await res.text();
      body.innerHTML = `
        <div class="w-full h-full flex flex-col p-1 space-y-2">
          <div class="flex justify-between items-center px-1">
            <span class="text-xs text-slate-400 font-mono">${escapeHtml(fileName)}</span>
            <button onclick="closeFilePreview(); openFileEditor('${filePath}')" class="zencloud-btn-primary px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 shadow-sm">
              <i data-lucide="edit-3" class="w-3.5 h-3.5"></i> Open in Inbuilt Editor
            </button>
          </div>
          <pre class="flex-1 w-full whitespace-pre-wrap break-words text-xs leading-5 text-neutral-200 bg-[#050505] border border-white/20 rounded-xl p-4 overflow-auto font-mono">${escapeHtml(text)}</pre>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
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
            const statusClass = j.status === 'completed' ? 'text-emerald-400' : j.status === 'failed' ? 'text-red-400' : 'text-white font-semibold';
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
                    <span class="text-white font-bold">${progress}%</span>
                  </div>
                  <div class="mt-1.5 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div class="h-full bg-white transition-[width] duration-500 shadow-[0_0_8px_rgba(255,255,255,0.8)]" style="width:${progress}%"></div>
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
// 4.5. S3 & VERCEL BLOB API CLUSTER COMPONENT
// ==========================================
let currentCodeSnippetTab = 'curl';
let currentPlaygroundMode = 'blob';
let playgroundSelectedFile = null;

async function renderS3ClusterTab(container) {
  const origin = window.location.origin;
  const s3Endpoint = `${origin}/api/s3`;
  const blobEndpoint = `${origin}/api/v1/blob`;
  const installCmd = `curl -fsSL ${origin}/install.sh | sudo bash`;

  container.innerHTML = `
    <div class="space-y-6 tab-pane-enter">
      <!-- Header Banner -->
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 p-6 rounded-2xl bg-gradient-to-r from-neutral-950/80 via-neutral-900/40 to-black border border-white/20 shadow-2xl">
        <div class="flex items-start gap-4">
          <div class="w-12 h-12 rounded-2xl bg-white/10 border border-white/20 flex items-center justify-center text-white shrink-0 shadow-lg shadow-white/10">
            <i data-lucide="cloud-lightning" class="w-6 h-6"></i>
          </div>
          <div>
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-xl font-bold text-white tracking-tight">S3 Cluster & Vercel Blob API</h2>
              <span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">Free & Active</span>
              <span class="px-2 py-0.5 text-[10px] font-bold rounded-full bg-white/10 text-white border border-white/20">Zero Egress Fees</span>
            </div>
            <p class="text-xs text-neutral-400 mt-1 max-w-2xl leading-relaxed">
              Use your VPS storage as an AWS S3-compatible object store and Vercel Blob cluster for free. Connect your Next.js, Node.js, Python, or mobile apps using standard S3 and Blob client libraries.
            </p>
          </div>
        </div>

        <div class="flex items-center gap-2 shrink-0">
          <button onclick="openCreateApiKeyModal()" class="zencloud-btn-primary inline-flex items-center gap-2 bg-white hover:bg-neutral-200 text-black font-bold text-xs px-4 py-2.5 rounded-xl shadow-lg shadow-white/20 transition-all">
            <i data-lucide="key" class="w-4 h-4 text-black"></i> Create API Key
          </button>
          <button onclick="renderS3ClusterTab(document.getElementById('tab-content-area'))" class="p-2.5 bg-[#121217] hover:bg-[#1a1a22] text-neutral-300 rounded-xl border border-[#22222a] transition-all" title="Refresh">
            <i data-lucide="refresh-cw" class="w-4 h-4"></i>
          </button>
        </div>
      </div>

      <!-- Quick VPS Installer Banner -->
      <div class="p-4 rounded-2xl bg-[#07070a] border border-white/15 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 shadow-lg">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-white/10 border border-white/20 text-white flex items-center justify-center font-mono font-bold text-xs shrink-0">
            <i data-lucide="terminal" class="w-4 h-4"></i>
          </div>
          <div>
            <div class="text-xs font-semibold text-white flex items-center gap-2">
              Automated Interactive VPS Setup Installer
              <span class="text-[10px] px-1.5 py-0.5 bg-white/15 text-white rounded border border-white/20 font-bold">1-Command Setup</span>
            </div>
            <div class="text-[11px] text-neutral-400 font-mono select-all mt-0.5">${escapeHtml(installCmd)}</div>
          </div>
        </div>
        <button onclick="copyToClipboard('${escapeHtml(installCmd)}', this, 'Copied Bash Command!')" class="shrink-0 text-xs font-medium px-3.5 py-2 bg-[#121218] hover:bg-[#1c1c24] text-white rounded-xl border border-white/20 transition-all flex items-center gap-2">
          <i data-lucide="copy" class="w-3.5 h-3.5"></i> Copy Installer
        </button>
      </div>

      <!-- Live Cluster Status & Endpoints Cards -->
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <!-- Card 1: S3 Cluster -->
        <div class="pitch-card pitch-card-hover p-5 rounded-2xl border border-[#1b1b22]">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-semibold text-neutral-400 uppercase tracking-wider">S3 Cluster API</span>
            <span class="flex items-center gap-1 text-[10px] text-emerald-400 font-bold">
              <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span> Live
            </span>
          </div>
          <div class="text-sm font-bold text-white mb-1">AWS S3 Compatible</div>
          <p class="text-[11px] text-neutral-400 mb-3">PutObject, GetObject, ListObjectsV2, Range Requests, Cyberduck & Boto3.</p>
          <div class="p-2 rounded-lg bg-[#040406] border border-[#171720] flex items-center justify-between gap-2">
            <span class="font-mono text-[10px] text-white truncate">${s3Endpoint}</span>
            <button onclick="copyToClipboard('${s3Endpoint}', this, 'Copied S3 Endpoint!')" class="text-neutral-400 hover:text-white p-1" title="Copy S3 Endpoint">
              <i data-lucide="copy" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>

        <!-- Card 2: Vercel Blob -->
        <div class="pitch-card pitch-card-hover p-5 rounded-2xl border border-[#1b1b22]">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Vercel Blob API</span>
            <span class="flex items-center gap-1 text-[10px] text-emerald-400 font-bold">
              <span class="w-2 h-2 rounded-full bg-emerald-400"></span> Ready
            </span>
          </div>
          <div class="text-sm font-bold text-white mb-1">Blob SDK Ready</div>
          <p class="text-[11px] text-neutral-400 mb-3">Drop-in substitute for @vercel/blob. Streaming uploads, instant public/token access.</p>
          <div class="p-2 rounded-lg bg-[#040406] border border-[#171720] flex items-center justify-between gap-2">
            <span class="font-mono text-[10px] text-white truncate">${blobEndpoint}</span>
            <button onclick="copyToClipboard('${blobEndpoint}', this, 'Copied Blob Endpoint!')" class="text-neutral-400 hover:text-white p-1" title="Copy Blob Endpoint">
              <i data-lucide="copy" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>

        <!-- Card 3: Storage Used -->
        <div class="pitch-card pitch-card-hover p-5 rounded-2xl border border-[#1b1b22]">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-semibold text-neutral-400 uppercase tracking-wider">Cluster Storage</span>
            <i data-lucide="database" class="w-4 h-4 text-white"></i>
          </div>
          <div class="text-xl font-bold text-white mb-1" id="cluster-storage-stat">Loading...</div>
          <div class="w-full bg-[#16161e] h-1.5 rounded-full overflow-hidden mb-2">
            <div id="cluster-storage-bar" class="bg-white h-full rounded-full transition-all" style="width: 0%"></div>
          </div>
          <p class="text-[10px] text-neutral-500" id="cluster-quota-detail">Shared with your account quota</p>
        </div>

        <!-- Card 4: Total Requests -->
        <div class="pitch-card pitch-card-hover p-5 rounded-2xl border border-[#1b1b22]">
          <div class="flex items-center justify-between mb-3">
            <span class="text-xs font-semibold text-neutral-400 uppercase tracking-wider">API Activity</span>
            <i data-lucide="activity" class="w-4 h-4 text-emerald-400"></i>
          </div>
          <div class="text-xl font-bold text-white mb-1" id="cluster-requests-stat">0</div>
          <p class="text-[11px] text-neutral-400">Total API calls served with zero egress fees or bandwidth limits.</p>
        </div>
      </div>

      <!-- API Keys Management Section -->
      <div class="pitch-card p-6 rounded-2xl border border-[#1b1b22]">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
          <div>
            <h3 class="text-base font-bold text-white flex items-center gap-2">
              <i data-lucide="shield-check" class="w-4 h-4 text-white"></i> API Access Keys
            </h3>
            <p class="text-xs text-neutral-400 mt-0.5">Authenticate requests using Bearer tokens, x-api-key, or AWS S3 Signature credentials.</p>
          </div>
          <button onclick="openCreateApiKeyModal()" class="bg-[#121218] hover:bg-[#1a1a24] text-white text-xs font-semibold px-4 py-2.5 rounded-xl border border-[#242432] flex items-center gap-2 transition-all">
            <i data-lucide="plus" class="w-3.5 h-3.5 text-white"></i> New API Key
          </button>
        </div>

        <div id="api-keys-table-container" class="overflow-x-auto">
          <div class="py-8 text-center text-xs text-neutral-500">Loading API keys...</div>
        </div>
      </div>

      <!-- Interactive In-Browser API Tester / Playground -->
      <div class="pitch-card p-6 rounded-2xl border border-[#1b1b22]">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-5">
          <div>
            <h3 class="text-base font-bold text-white flex items-center gap-2">
              <i data-lucide="play-circle" class="w-4 h-4 text-emerald-400"></i> Live In-Browser API Playground
            </h3>
            <p class="text-xs text-neutral-400 mt-0.5">Test real upload and retrieval requests against your cluster right now.</p>
          </div>
          <div class="flex items-center gap-1 p-1 bg-[#050508] border border-[#1b1b24] rounded-xl">
            <button onclick="switchPlaygroundMode('blob')" id="btn-pg-blob" class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-white text-black transition-all">
              Vercel Blob PUT
            </button>
            <button onclick="switchPlaygroundMode('s3')" id="btn-pg-s3" class="px-3 py-1.5 text-xs font-semibold rounded-lg text-neutral-400 hover:text-white transition-all">
              AWS S3 PutObject
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <!-- Playground Input Form -->
          <div class="space-y-4">
            <div>
              <label class="block text-xs font-semibold uppercase text-neutral-400 mb-1" id="pg-path-label">Destination Path / Filename</label>
              <input type="text" id="pg-filename" value="test-uploads/hello-zen.txt" class="w-full pitch-input rounded-xl px-3.5 py-2.5 text-xs text-white">
            </div>

            <div>
              <label class="block text-xs font-semibold uppercase text-neutral-400 mb-1">Content or Payload</label>
              <textarea id="pg-payload" rows="4" class="w-full pitch-input rounded-xl px-3.5 py-2.5 text-xs text-white font-mono" placeholder="Enter text payload or select a file below...">Hello from Zen VPS Storage & S3 Cluster! Timestamp: ${new Date().toISOString()}</textarea>
            </div>

            <div class="flex flex-wrap items-center gap-3">
              <label class="px-3 py-2 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-750 border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs font-medium rounded-xl cursor-pointer flex items-center gap-2 transition-all">
                <i data-lucide="file-up" class="w-3.5 h-3.5 text-white"></i> Choose Local File (Optional)
                <input type="file" id="pg-local-file" class="hidden" onchange="handlePlaygroundFileSelect(event)">
              </label>
              <span id="pg-file-name-preview" class="text-xs text-slate-500 dark:text-slate-400 truncate max-w-[220px]">No file chosen (using text payload)</span>
            </div>

            <button onclick="executePlaygroundUpload()" id="btn-pg-submit" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs py-2.5 rounded-xl shadow-md shadow-emerald-600/25 transition-all flex items-center justify-center gap-2">
              <i data-lucide="send" class="w-4 h-4"></i> Execute API Upload Request
            </button>
          </div>

          <!-- Playground Output Response -->
          <div class="flex flex-col justify-between p-4 rounded-xl bg-slate-900 text-slate-100 border border-slate-800 shadow-inner">
            <div>
              <div class="flex items-center justify-between mb-2">
                <span class="text-xs font-bold text-slate-400 uppercase tracking-wider">Live Response Payload</span>
                <span id="pg-res-status" class="text-xs font-mono font-bold text-slate-400">Ready</span>
              </div>
              <pre id="pg-res-json" class="text-[11px] font-mono text-white bg-slate-950 p-3 rounded-lg border border-slate-800 overflow-x-auto max-h-[200px] custom-scrollbar">// Click "Execute API Upload Request" to test live endpoint...</pre>
            </div>

            <div id="pg-preview-action" class="mt-3 pt-3 border-t border-slate-800 hidden space-y-2">
              <div class="flex items-center justify-between">
                <span class="text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                  <i data-lucide="check-circle-2" class="w-3.5 h-3.5"></i> Direct Embed Link Ready
                </span>
                <a id="pg-preview-link" href="#" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 px-2.5 py-1 bg-white hover:bg-neutral-200 text-black rounded-lg text-[11px] font-bold transition-all">
                  <i data-lucide="external-link" class="w-3 h-3"></i> View Inline
                </a>
              </div>
              
              <div class="grid grid-cols-2 sm:grid-cols-3 gap-1.5 pt-1">
                <button id="btn-copy-direct-url" onclick="" class="px-2.5 py-1.5 bg-neutral-900 hover:bg-neutral-800 text-white text-[11px] font-medium rounded-lg flex items-center justify-center gap-1.5 border border-white/10 transition-all">
                  <i data-lucide="link" class="w-3 h-3 text-white"></i> Direct URL
                </button>
                <button id="btn-copy-html-tag" onclick="" class="px-2.5 py-1.5 bg-neutral-900 hover:bg-neutral-800 text-white text-[11px] font-medium rounded-lg flex items-center justify-center gap-1.5 border border-white/10 transition-all">
                  <i data-lucide="code" class="w-3 h-3 text-emerald-400"></i> HTML &lt;img&gt;
                </button>
                <button id="btn-copy-markdown-tag" onclick="" class="px-2.5 py-1.5 bg-neutral-900 hover:bg-neutral-800 text-white text-[11px] font-medium rounded-lg flex items-center justify-center gap-1.5 border border-white/10 transition-all col-span-2 sm:col-span-1">
                  <i data-lucide="file-text" class="w-3 h-3 text-amber-400"></i> Markdown
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Code Snippets & SDK Guides Section -->
      <div class="pitch-card p-6 rounded-2xl border border-[#1b1b22]">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div>
            <h3 class="text-base font-bold text-white flex items-center gap-2">
              <i data-lucide="code-2" class="w-4 h-4 text-white"></i> Integration Code Examples
            </h3>
            <p class="text-xs text-neutral-400 mt-0.5">Copy production-ready code for your stack.</p>
          </div>
          <div class="flex flex-wrap gap-1 p-1 bg-[#050508] border border-[#1a1a24] rounded-xl">
            <button onclick="switchCodeSnippetTab('curl')" id="tab-code-curl" class="px-3 py-1 text-xs font-semibold rounded-lg bg-white text-black transition-all">cURL</button>
            <button onclick="switchCodeSnippetTab('blob-js')" id="tab-code-blob-js" class="px-3 py-1 text-xs font-semibold rounded-lg text-neutral-400 hover:text-white transition-all">Vercel Blob (JS)</button>
            <button onclick="switchCodeSnippetTab('s3-python')" id="tab-code-s3-python" class="px-3 py-1 text-xs font-semibold rounded-lg text-neutral-400 hover:text-white transition-all">Python (Boto3)</button>
            <button onclick="switchCodeSnippetTab('s3-node')" id="tab-code-s3-node" class="px-3 py-1 text-xs font-semibold rounded-lg text-neutral-400 hover:text-white transition-all">AWS SDK v3 (Node)</button>
            <button onclick="switchCodeSnippetTab('nextjs')" id="tab-code-nextjs" class="px-3 py-1 text-xs font-semibold rounded-lg text-neutral-400 hover:text-white transition-all">Next.js</button>
          </div>
        </div>

        <div class="relative">
          <pre id="code-snippet-pre" class="text-xs font-mono text-neutral-200 bg-[#040406] p-4 rounded-xl border border-[#171722] overflow-x-auto max-h-[300px] custom-scrollbar"></pre>
          <button onclick="copyCurrentCodeSnippet(this)" class="absolute top-3 right-3 text-xs px-3 py-1.5 bg-[#14141c] hover:bg-[#1e1e28] text-neutral-300 hover:text-white rounded-lg border border-[#252534] flex items-center gap-1.5 transition-all">
            <i data-lucide="copy" class="w-3.5 h-3.5"></i> Copy Code
          </button>
        </div>
      </div>
    </div>
  `;

  if (window.lucide) lucide.createIcons();
  await loadS3ClusterData();
  switchCodeSnippetTab(currentCodeSnippetTab);
}

async function loadS3ClusterData() {
  const container = document.getElementById('api-keys-table-container');
  try {
    const data = await apiRequest('/keys');
    const keys = data.keys || [];
    const stats = data.stats || {};

    const used = Number(stats.storageUsed || AppState.user.usedStorageBytes || 0);
    const total = Number(stats.storageQuota || AppState.user.storage_quota_bytes || 10737418240);
    const percent = Math.min(100, Math.round((used / total) * 100));

    const sStorageStat = document.getElementById('cluster-storage-stat');
    const sStorageBar = document.getElementById('cluster-storage-bar');
    const sQuotaDetail = document.getElementById('cluster-quota-detail');
    const sRequestsStat = document.getElementById('cluster-requests-stat');

    if (sStorageStat) sStorageStat.innerText = formatBytes(used);
    if (sStorageBar) sStorageBar.style.width = `${percent}%`;
    if (sQuotaDetail) sQuotaDetail.innerText = `${formatBytes(used)} of ${formatBytes(total)} (${percent}%)`;
    if (sRequestsStat) sRequestsStat.innerText = Number(stats.totalRequests || 0).toLocaleString();

    if (!container) return;

    if (!keys.length) {
      container.innerHTML = `
        <div class="py-12 text-center">
          <div class="w-12 h-12 rounded-2xl bg-[#121218] border border-[#22222e] flex items-center justify-center text-neutral-400 mx-auto mb-3">
            <i data-lucide="key" class="w-6 h-6"></i>
          </div>
          <h4 class="text-sm font-semibold text-white">No API Keys Generated Yet</h4>
          <p class="text-xs text-neutral-400 max-w-sm mx-auto mt-1 mb-4">Create your first API key to connect your applications, upload files via curl, or mount S3 storage.</p>
          <button onclick="openCreateApiKeyModal()" class="bg-white hover:bg-neutral-200 text-black text-xs font-bold px-4 py-2 rounded-xl transition-all shadow-lg">
            Create API Key
          </button>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    container.innerHTML = `
      <table class="w-full text-left border-collapse text-xs">
        <thead>
          <tr class="border-b border-[#181822] text-neutral-400 font-semibold uppercase tracking-wider text-[10px]">
            <th class="py-3 px-3">Name</th>
            <th class="py-3 px-3">Access Key ID</th>
            <th class="py-3 px-3">Permissions</th>
            <th class="py-3 px-3">Requests</th>
            <th class="py-3 px-3">Created</th>
            <th class="py-3 px-3">Last Used</th>
            <th class="py-3 px-3 text-right">Action</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-[#121218]">
          ${keys.map(k => `
            <tr class="hover:bg-[#07070a] transition-colors">
              <td class="py-3 px-3 font-semibold text-white flex items-center gap-2">
                <i data-lucide="key" class="w-3.5 h-3.5 text-white"></i> ${escapeHtml(k.name)}
              </td>
              <td class="py-3 px-3 font-mono text-white">
                <span class="bg-[#030305] px-2 py-1 rounded border border-[#171722] inline-flex items-center gap-1.5">
                  ${escapeHtml(k.key_id)}
                  <button onclick="copyToClipboard('${escapeHtml(k.key_id)}', this, 'Key ID copied!')" class="text-neutral-400 hover:text-white">
                    <i data-lucide="copy" class="w-3 h-3"></i>
                  </button>
                </span>
              </td>
              <td class="py-3 px-3">
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${k.permissions === 'full' ? 'bg-white/15 text-white border border-white/25' : k.permissions === 'read_write' ? 'bg-white/10 text-white border border-white/20' : 'bg-neutral-800 text-neutral-300 border border-neutral-700'}">
                  ${escapeHtml(k.permissions)}
                </span>
              </td>
              <td class="py-3 px-3 text-neutral-300 font-mono">${Number(k.requests_count || 0).toLocaleString()}</td>
              <td class="py-3 px-3 text-neutral-400">${new Date(k.created_at).toLocaleDateString()}</td>
              <td class="py-3 px-3 text-neutral-400">${k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'Never'}</td>
              <td class="py-3 px-3 text-right">
                <button onclick="revokeApiKey(${k.id}, '${escapeHtml(k.name)}')" class="text-red-400 hover:text-red-300 hover:bg-red-500/10 px-2 py-1 rounded transition-all">
                  Revoke
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    if (container) {
      container.innerHTML = `<div class="p-4 text-xs text-red-400">Failed to load API keys: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function openCreateApiKeyModal() {
  const existing = document.getElementById('active-custom-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'active-custom-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm modal-backdrop-enter';
  modal.innerHTML = `
    <div class="pitch-card w-full max-w-md p-6 rounded-2xl border border-[#22222e] shadow-2xl modal-box-enter">
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-base font-bold text-white flex items-center gap-2">
          <i data-lucide="key" class="w-4 h-4 text-white"></i> Create New API Key
        </h3>
        <button onclick="closeActiveModal()" class="text-neutral-400 hover:text-white p-1 rounded-lg">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
      </div>

      <form onsubmit="handleCreateApiKey(event)" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold uppercase text-neutral-400 mb-1">Key Description / Name</label>
          <input type="text" id="new-key-name" required placeholder="e.g. Next.js Production, Backup Script" class="w-full pitch-input rounded-xl px-3.5 py-2.5 text-xs text-white">
        </div>

        <div>
          <label class="block text-xs font-semibold uppercase text-neutral-400 mb-1">Permissions Scope</label>
          <select id="new-key-permissions" class="w-full pitch-input rounded-xl px-3.5 py-2.5 text-xs text-white">
            <option value="full">Full Access (Read, Write, Delete)</option>
            <option value="read_write">Read & Write (Upload & Download)</option>
            <option value="read">Read Only (Download Only)</option>
          </select>
        </div>

        <div class="p-3 rounded-xl bg-neutral-900 border border-white/15 text-xs text-neutral-200">
          This key grants programmatic access to upload and manage files in your S3 & Blob storage cluster.
        </div>

        <div class="flex items-center justify-end gap-2 pt-2">
          <button type="button" onclick="closeActiveModal()" class="px-4 py-2 rounded-xl text-xs text-neutral-400 hover:text-white hover:bg-[#14141c]">
            Cancel
          </button>
          <button type="submit" id="submit-create-key" class="px-5 py-2 rounded-xl bg-white hover:bg-neutral-200 text-black font-bold text-xs shadow-lg">
            Generate Key
          </button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();
}

function closeActiveModal() {
  const modal = document.getElementById('active-custom-modal');
  if (modal) modal.remove();
}

async function handleCreateApiKey(e) {
  e.preventDefault();
  const name = document.getElementById('new-key-name').value.trim();
  const permissions = document.getElementById('new-key-permissions').value;
  const submitBtn = document.getElementById('submit-create-key');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerText = 'Creating...'; }

  try {
    const data = await apiRequest('/keys', {
      method: 'POST',
      body: { name, permissions }
    });

    closeActiveModal();
    showNewApiKeyRevealedModal(data.key);
    await loadS3ClusterData();
  } catch (err) {
    showToast(err.message, 'error');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerText = 'Generate Key'; }
  }
}

function showNewApiKeyRevealedModal(key) {
  const modal = document.createElement('div');
  modal.id = 'active-custom-modal';
  modal.className = 'fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm modal-backdrop-enter';
  modal.innerHTML = `
    <div class="pitch-card w-full max-w-lg p-6 rounded-2xl border border-emerald-500/30 shadow-2xl modal-box-enter">
      <div class="flex items-start justify-between mb-4">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
            <i data-lucide="check-circle-2" class="w-5 h-5"></i>
          </div>
          <div>
            <h3 class="text-base font-bold text-white">API Key Generated</h3>
            <p class="text-xs text-neutral-400">${escapeHtml(key.name)}</p>
          </div>
        </div>
        <button onclick="closeActiveModal()" class="text-neutral-400 hover:text-white p-1 rounded-lg">
          <i data-lucide="x" class="w-4 h-4"></i>
        </button>
      </div>

      <div class="space-y-3 mb-5">
        <div class="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-xs text-amber-200 flex items-start gap-2">
          <i data-lucide="alert-triangle" class="w-4 h-4 text-amber-400 shrink-0 mt-0.5"></i>
          <span><strong>Save your Secret Key now.</strong> For security, your secret key is only shown once and cannot be recovered later.</span>
        </div>

        <div>
          <label class="block text-[11px] font-semibold uppercase text-neutral-400 mb-1">Access Key ID</label>
          <div class="p-2.5 rounded-xl bg-[#040406] border border-[#1c1c26] flex items-center justify-between gap-2">
            <span class="font-mono text-xs text-white select-all">${escapeHtml(key.key_id)}</span>
            <button onclick="copyToClipboard('${escapeHtml(key.key_id)}', this, 'Copied Key ID!')" class="px-2 py-1 bg-[#121218] hover:bg-[#1a1a24] text-xs text-neutral-300 rounded border border-[#22222e] flex items-center gap-1">
              <i data-lucide="copy" class="w-3 h-3"></i> Copy
            </button>
          </div>
        </div>

        <div>
          <label class="block text-[11px] font-semibold uppercase text-neutral-400 mb-1">Secret Access Key (Token)</label>
          <div class="p-2.5 rounded-xl bg-[#040406] border border-[#1c1c26] flex items-center justify-between gap-2">
            <span class="font-mono text-xs text-emerald-300 select-all">${escapeHtml(key.secret_key)}</span>
            <button onclick="copyToClipboard('${escapeHtml(key.secret_key)}', this, 'Copied Secret Key!')" class="px-2 py-1 bg-[#121218] hover:bg-[#1a1a24] text-xs text-emerald-300 rounded border border-[#22222e] flex items-center gap-1">
              <i data-lucide="copy" class="w-3 h-3"></i> Copy
            </button>
          </div>
        </div>
      </div>

      <div class="flex justify-end">
        <button onclick="closeActiveModal()" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs py-2.5 rounded-xl shadow-lg shadow-emerald-600/20">
          I Have Saved My Secret Key
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();
}

async function revokeApiKey(keyId, keyName) {
  if (!confirm(`Are you sure you want to revoke API key "${keyName}"? Applications using this key will immediately lose access.`)) {
    return;
  }

  try {
    await apiRequest(`/keys/${keyId}`, { method: 'DELETE' });
    showToast('API key revoked successfully', 'success');
    await loadS3ClusterData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function copyToClipboard(text, btnElement, successMsg = 'Copied to clipboard!') {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(successMsg, 'success');
      if (btnElement) {
        const originalText = btnElement.innerHTML;
        btnElement.classList.add('text-emerald-400');
        setTimeout(() => {
          btnElement.classList.remove('text-emerald-400');
        }, 1500);
      }
    }).catch(() => fallbackCopy(text, successMsg));
  } else {
    fallbackCopy(text, successMsg);
  }
}

function fallbackCopy(text, successMsg) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    showToast(successMsg, 'success');
  } catch (e) {
    showToast('Failed to copy', 'error');
  }
  ta.remove();
}

function switchPlaygroundMode(mode) {
  currentPlaygroundMode = mode;
  const btnBlob = document.getElementById('btn-pg-blob');
  const btnS3 = document.getElementById('btn-pg-s3');
  const pathLabel = document.getElementById('pg-path-label');
  const fnInput = document.getElementById('pg-filename');

  if (mode === 'blob') {
    btnBlob.className = 'px-3 py-1.5 text-xs font-semibold rounded-lg bg-white text-black transition-all';
    btnS3.className = 'px-3 py-1.5 text-xs font-semibold rounded-lg text-neutral-400 hover:text-white transition-all';
    pathLabel.innerText = 'Destination Path (Vercel Blob /pathname)';
    if (fnInput.value.includes('bucket')) fnInput.value = 'test-uploads/hello-zen.txt';
  } else {
    btnS3.className = 'px-3 py-1.5 text-xs font-semibold rounded-lg bg-white text-black transition-all';
    btnBlob.className = 'px-3 py-1.5 text-xs font-semibold rounded-lg text-neutral-400 hover:text-white transition-all';
    pathLabel.innerText = 'S3 Bucket & Object Key (bucket/key)';
    if (!fnInput.value.includes('/')) fnInput.value = 'default/test-uploads/hello-zen.txt';
  }
}

function handlePlaygroundFileSelect(e) {
  const file = e.target.files[0];
  playgroundSelectedFile = file || null;
  const preview = document.getElementById('pg-file-name-preview');
  const fnInput = document.getElementById('pg-filename');
  if (file) {
    preview.innerText = `${file.name} (${formatBytes(file.size)})`;
    if (fnInput) {
      const parts = fnInput.value.split('/');
      parts[parts.length - 1] = file.name;
      fnInput.value = parts.join('/');
    }
  } else {
    preview.innerText = 'No file chosen (using text payload)';
  }
}

async function executePlaygroundUpload() {
  const submitBtn = document.getElementById('btn-pg-submit');
  const statusEl = document.getElementById('pg-res-status');
  const jsonEl = document.getElementById('pg-res-json');
  const previewAction = document.getElementById('pg-preview-action');
  const previewLink = document.getElementById('pg-preview-link');

  const filename = document.getElementById('pg-filename').value.trim();
  const textPayload = document.getElementById('pg-payload').value;

  if (!filename) {
    showToast('Please specify a filename or path', 'error');
    return;
  }

  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Uploading...';
  if (window.lucide) lucide.createIcons();

  statusEl.innerText = 'Sending...';
  statusEl.className = 'text-xs font-mono font-bold text-amber-400';

  const startTime = performance.now();

  try {
    let url = '';
    let bodyData = null;
    let headers = {
      'Authorization': `Bearer ${AppState.token}`
    };

    if (playgroundSelectedFile) {
      bodyData = playgroundSelectedFile;
      headers['Content-Type'] = playgroundSelectedFile.type || 'application/octet-stream';
    } else {
      bodyData = textPayload;
      headers['Content-Type'] = 'text/plain; charset=utf-8';
    }

    if (currentPlaygroundMode === 'blob') {
      url = `/api/v1/blob/${encodeURIComponent(filename)}`;
    } else {
      let parts = filename.split('/');
      let bucket = 'default';
      let key = filename;
      if (parts.length > 1) {
        bucket = parts[0];
        key = parts.slice(1).join('/');
      }
      url = `/api/s3/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`;
    }

    const res = await fetch(url, {
      method: 'PUT',
      headers,
      body: bodyData
    });

    const elapsed = Math.round(performance.now() - startTime);
    const data = await res.json().catch(() => ({ status: res.statusText }));

    statusEl.innerText = `${res.status} ${res.statusText} (${elapsed}ms)`;
    statusEl.className = res.ok ? 'text-xs font-mono font-bold text-emerald-400' : 'text-xs font-mono font-bold text-red-400';

    jsonEl.innerText = JSON.stringify(data, null, 2);

    if (res.ok) {
      showToast('API Upload Successful!', 'success');
      const directUrl = data.url || data.downloadUrl || (window.location.origin + url);
      const downloadUrl = data.downloadUrl || (directUrl + '?download=1');
      const fileName = (data.pathname || filename || 'file').split('/').pop();
      const htmlTag = `<img src="${directUrl}" alt="${fileName}" />`;
      const markdownTag = `![${fileName}](${directUrl})`;

      if (previewAction && previewLink) {
        previewLink.href = directUrl;
        previewAction.classList.remove('hidden');

        const btnCopyUrl = document.getElementById('btn-copy-direct-url');
        if (btnCopyUrl) {
          btnCopyUrl.onclick = function() { copyToClipboard(directUrl, this, 'Copied Direct URL!'); };
        }

        const btnCopyHtml = document.getElementById('btn-copy-html-tag');
        if (btnCopyHtml) {
          btnCopyHtml.onclick = function() { copyToClipboard(htmlTag, this, 'Copied HTML <img> tag!'); };
        }

        const btnCopyMd = document.getElementById('btn-copy-markdown-tag');
        if (btnCopyMd) {
          btnCopyMd.onclick = function() { copyToClipboard(markdownTag, this, 'Copied Markdown code!'); };
        }
      }
      loadS3ClusterData().catch(() => {});
      updateQuotaWidget().catch(() => {});
    } else {
      showToast(`Upload failed: ${data.error || res.statusText}`, 'error');
    }
  } catch (err) {
    statusEl.innerText = 'Request Failed';
    statusEl.className = 'text-xs font-mono font-bold text-red-400';
    jsonEl.innerText = `Error: ${err.message}`;
    showToast(err.message, 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i data-lucide="send" class="w-4 h-4"></i> Execute API Upload Request';
    if (window.lucide) lucide.createIcons();
  }
}

function switchCodeSnippetTab(tab) {
  currentCodeSnippetTab = tab;
  const tabs = ['curl', 'blob-js', 's3-python', 's3-node', 'nextjs'];
  tabs.forEach(t => {
    const el = document.getElementById(`tab-code-${t}`);
    if (el) {
      if (t === tab) {
        el.className = 'px-3 py-1 text-xs font-semibold rounded-lg bg-white text-black transition-all';
      } else {
        el.className = 'px-3 py-1 text-xs font-semibold rounded-lg text-neutral-400 hover:text-white transition-all';
      }
    }
  });

  const pre = document.getElementById('code-snippet-pre');
  if (!pre) return;
  const origin = window.location.origin;

  if (tab === 'curl') {
    pre.innerText = `# 1. Upload via Vercel Blob API (Binary PUT)
curl -X PUT "${origin}/api/v1/blob/images/avatar.png" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: image/png" \\
  --data-binary @"./avatar.png"

# 2. Upload via AWS S3 PutObject API
curl -X PUT "${origin}/api/s3/my-bucket/documents/report.pdf" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/pdf" \\
  --data-binary @"./report.pdf"

# 3. Download Object
curl -O "${origin}/api/s3/my-bucket/documents/report.pdf" \\
  -H "Authorization: Bearer YOUR_API_KEY"`;
  } else if (tab === 'blob-js') {
    pre.innerText = `// Drop-in Vercel Blob replacement (Client or Server)
import { put } from '@vercel/blob';

// Option A: Direct Fetch to your Zen Blob Cluster
async function uploadToBlob(file) {
  const response = await fetch('${origin}/api/v1/blob/' + file.name, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + process.env.ZEN_BLOB_TOKEN,
      'Content-Type': file.type || 'application/octet-stream'
    },
    body: file
  });
  
  const blob = await response.json();
  console.log('Uploaded Blob URL:', blob.url);
  return blob;
}`;
  } else if (tab === 's3-python') {
    pre.innerText = `import boto3
from botocore.config import Config

# Connect to your free self-hosted VPS S3 Cluster
s3_client = boto3.client(
    's3',
    endpoint_url='${origin}/api/s3',
    aws_access_key_id='YOUR_KEY_ID',
    aws_secret_access_key='YOUR_SECRET_KEY',
    config=Config(s3={'addressing_style': 'path'})
)

# Upload file
s3_client.upload_file(
    Filename='local_data.csv',
    Bucket='analytics',
    Key='2026/report.csv'
)
print("File successfully uploaded to VPS S3 cluster!")`;
  } else if (tab === 's3-node') {
    pre.innerText = `import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

const s3 = new S3Client({
  endpoint: "${origin}/api/s3",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.ZEN_S3_KEY_ID,
    secretAccessKey: process.env.ZEN_S3_SECRET_KEY
  }
});

// Upload object
await s3.send(new PutObjectCommand({
  Bucket: "uploads",
  Key: "file.json",
  Body: JSON.stringify({ status: "success" }),
  ContentType: "application/json"
}));`;
  } else if (tab === 'nextjs') {
    pre.innerText = `// app/api/upload/route.ts (Next.js App Router)
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get('file') as File;
  
  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }

  // Forward to your Zen S3 / Blob Cluster
  const uploadRes = await fetch('${origin}/api/v1/blob/' + file.name, {
    method: 'PUT',
    headers: {
      'Authorization': \`Bearer \${process.env.ZEN_STORAGE_TOKEN}\`,
      'Content-Type': file.type
    },
    body: Buffer.from(await file.arrayBuffer())
  });

  const data = await uploadRes.json();
  return NextResponse.json(data);
}`;
  }
}

function copyCurrentCodeSnippet(btn) {
  const pre = document.getElementById('code-snippet-pre');
  if (pre) {
    copyToClipboard(pre.innerText, btn, 'Code snippet copied!');
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
          <h2 class="text-lg font-bold text-slate-900 dark:text-white">Active Share Links</h2>
          <p class="text-xs text-slate-600 dark:text-slate-400">Manage your public share links and expiration limits (Default Max: 3 Links)</p>
        </div>
        <button onclick="renderShareLinksTab(document.getElementById('tab-content-area'))" class="p-2 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 rounded-xl hover:bg-slate-200 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700">
          <i data-lucide="refresh-cw" class="w-4 h-4"></i>
        </button>
      </div>

      <div id="share-links-list" class="glass-card rounded-2xl overflow-hidden border border-slate-200 dark:border-slate-800">
        <div class="p-8 text-center text-slate-500 text-sm">Loading share links...</div>
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
          <i data-lucide="link" class="w-10 h-10 mb-2 text-slate-400 dark:text-slate-600 inline-block"></i>
          <p class="text-sm font-semibold text-slate-800 dark:text-slate-200">No share links created yet</p>
          <p class="text-xs mt-1 text-slate-500 dark:text-slate-400">Right-click any file in the File Manager to generate a share link.</p>
        </div>
      `;
      if (window.lucide) lucide.createIcons();
      return;
    }

    listDiv.innerHTML = `
      <div class="divide-y divide-slate-200 dark:divide-slate-800/60">
        <div class="px-4 py-3 bg-slate-100 dark:bg-slate-950/60 flex items-center text-xs font-bold text-slate-700 dark:text-slate-300">
          <span class="flex-1">File Path</span>
          <span class="w-36">Expires</span>
          <span class="w-24 text-center">Views</span>
          <span class="w-24 text-center">Status</span>
          <span class="w-28 text-right">Actions</span>
        </div>
        ${links.map(l => `
          <div class="file-list-row px-4 py-3 flex items-center text-xs">
            <div class="flex-1 truncate font-semibold text-slate-900 dark:text-white">
              ${escapeHtml(l.file_path)}
            </div>
            <span class="w-36 font-medium text-slate-600 dark:text-slate-400">${l.expires_at ? new Date(l.expires_at).toLocaleString() : 'Never'}</span>
            <span class="w-24 text-center font-bold text-slate-900 dark:text-white">${l.view_count}</span>
            <span class="w-24 text-center">
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${l.is_active && !l.isExpired ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : 'bg-red-500/20 text-red-600 dark:text-red-400'}">
                ${l.is_active && !l.isExpired ? 'Active' : 'Expired'}
              </span>
            </span>
            <div class="w-28 text-right flex items-center justify-end gap-2">
              <button onclick="navigator.clipboard.writeText('${l.shareUrl}'); showToast('Share URL copied!', 'success');" class="p-1.5 text-slate-500 dark:text-slate-400 hover:text-white rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800" title="Copy Link">
                <i data-lucide="copy" class="w-4 h-4"></i>
              </button>
              <button onclick="revokeShareLink('${l.id}')" class="p-1.5 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800" title="Revoke Link">
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
    <div class="space-y-6 tab-pane-enter">
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <!-- Storage Quota -->
        <div class="pitch-card p-5 rounded-2xl border border-slate-200 dark:border-white/10">
          <div class="flex items-center justify-between mb-3 text-slate-500 dark:text-slate-400 text-xs font-medium">
            <span>Storage Used</span>
            <i data-lucide="hard-drive" class="w-4 h-4"></i>
          </div>
          <div class="text-xl font-bold text-slate-900 dark:text-white mb-3" id="dash-storage-text">Loading...</div>
          <div class="w-full bg-slate-100 dark:bg-neutral-800 h-1.5 rounded-full overflow-hidden">
            <div id="dash-storage-bar" class="bg-slate-900 dark:bg-white h-full rounded-full transition-all duration-300" style="width: 0%"></div>
          </div>
        </div>

        <!-- Monthly Bandwidth (15 GB Default) -->
        <div class="pitch-card p-5 rounded-2xl border border-slate-200 dark:border-white/10">
          <div class="flex items-center justify-between mb-3 text-slate-500 dark:text-slate-400 text-xs font-medium">
            <span>Monthly Bandwidth</span>
            <i data-lucide="activity" class="w-4 h-4"></i>
          </div>
          <div class="text-xl font-bold text-slate-900 dark:text-white mb-3" id="dash-bandwidth-text">0 / 15 GB</div>
          <div class="w-full bg-slate-100 dark:bg-neutral-800 h-1.5 rounded-full overflow-hidden mb-2">
            <div id="dash-bandwidth-bar" class="bg-slate-900 dark:bg-white h-full rounded-full transition-all duration-300" style="width: 0%"></div>
          </div>
          <div class="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400" id="dash-bandwidth-sub">
            <span>Bandwidth quota</span>
            <span id="dash-bandwidth-reset">30d left</span>
          </div>
        </div>

        <!-- Monthly API Requests (100k Default) -->
        <div class="pitch-card p-5 rounded-2xl border border-slate-200 dark:border-white/10">
          <div class="flex items-center justify-between mb-3 text-slate-500 dark:text-slate-400 text-xs font-medium">
            <span>Monthly API Calls</span>
            <i data-lucide="zap" class="w-4 h-4"></i>
          </div>
          <div class="text-xl font-bold text-slate-900 dark:text-white mb-3" id="dash-api-text">0 / 100k Req</div>
          <div class="w-full bg-slate-100 dark:bg-neutral-800 h-1.5 rounded-full overflow-hidden mb-2">
            <div id="dash-api-bar" class="bg-amber-500 dark:bg-amber-400 h-full rounded-full transition-all duration-300" style="width: 0%"></div>
          </div>
          <div class="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400" id="dash-api-sub">
            <span>S3 & Blob API</span>
            <span id="dash-api-percent">0%</span>
          </div>
        </div>

        <!-- Direct Embed Links & S3 Cluster -->
        <div onclick="navigateTab('s3cluster')" class="pitch-card p-5 rounded-2xl border border-slate-200 dark:border-white/10 cursor-pointer hover:border-slate-400 dark:hover:border-white/30 transition-all group">
          <div class="flex items-center justify-between mb-3 text-slate-500 dark:text-slate-400 text-xs font-medium">
            <span>S3 / Blob Storage API</span>
            <i data-lucide="database" class="w-4 h-4 group-hover:text-black dark:group-hover:text-white transition-colors"></i>
          </div>
          <div class="text-xl font-bold text-slate-900 dark:text-white mb-3 flex items-center justify-between">
            <span>Connected</span>
            <span class="text-xs font-semibold text-emerald-600 dark:text-emerald-400">Live</span>
          </div>
          <div class="text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between pt-1">
            <span>Direct CDN links</span>
            <span class="text-slate-900 dark:text-white font-medium flex items-center gap-1">Manage <i data-lucide="arrow-right" class="w-3 h-3"></i></span>
          </div>
        </div>
      </div>

      <!-- Secondary Info Row -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="pitch-card p-6 rounded-2xl border border-slate-200 dark:border-white/10">
          <h3 class="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
            <i data-lucide="clock" class="w-4 h-4 text-slate-400"></i> Recent Login Activity
          </h3>
          <div id="dash-recent-logins" class="text-xs text-slate-600 dark:text-slate-400">Loading recent logins...</div>
        </div>

        <div class="pitch-card p-6 rounded-2xl border border-slate-200 dark:border-white/10 space-y-3">
          <div class="flex items-center justify-between">
            <h3 class="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
              <i data-lucide="shield-check" class="w-4 h-4 text-emerald-500"></i> Active Security & Quotas
            </h3>
            <span class="text-xs font-mono text-slate-500 dark:text-slate-400" id="dash-ip-badge">Detecting IP...</span>
          </div>
          <div class="text-xs text-slate-600 dark:text-slate-400 space-y-2 pt-1">
            <div class="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-white/5">
              <span>Bandwidth Policy</span>
              <span class="font-medium text-slate-900 dark:text-white">15 GB / month</span>
            </div>
            <div class="flex items-center justify-between py-1.5 border-b border-slate-100 dark:border-white/5">
              <span>API Request Policy</span>
              <span class="font-medium text-slate-900 dark:text-white">100,000 / month</span>
            </div>
            <div class="flex items-center justify-between py-1.5">
              <span>Direct File CDN Access</span>
              <span class="font-medium text-emerald-600 dark:text-emerald-400">Enabled</span>
            </div>
          </div>
        </div>
      </div>

      <div id="dash-contact-details" class="grid md:grid-cols-2 gap-4"></div>
    </div>
  `;

  if (window.lucide) lucide.createIcons();

  try {
    const profile = await apiRequest('/auth/profile');
    const links = await apiRequest('/share/my-links').catch(() => []);

    const used = profile.user.usedStorageBytes || 0;
    const total = profile.user.storage_quota_bytes || 10737418240;
    const pct = Math.min(100, Math.round((used / total) * 100));

    document.getElementById('dash-storage-text').innerText = `${formatBytes(used)} / ${formatBytes(total)}`;
    document.getElementById('dash-storage-bar').style.width = `${pct}%`;
    
    if (profile.currentIp && profile.currentIp.ipV4) {
      document.getElementById('dash-ip-badge').innerText = `IP: ${profile.currentIp.ipV4}`;
    }

    // Set bandwidth & api requests data
    const usage = profile.usage || profile.user?.usage;
    if (usage) {
      if (usage.bandwidth) {
        document.getElementById('dash-bandwidth-text').innerText = `${usage.bandwidth.formattedUsed} / ${usage.bandwidth.formattedLimit}`;
        document.getElementById('dash-bandwidth-bar').style.width = `${Math.min(100, usage.bandwidth.percentUsed)}%`;
        if (usage.bandwidth.isExceeded) {
          document.getElementById('dash-bandwidth-text').classList.add('text-red-400');
        }
      }
      if (usage.apiRequests) {
        document.getElementById('dash-api-text').innerText = `${usage.apiRequests.formattedUsed} / ${usage.apiRequests.formattedLimit}`;
        document.getElementById('dash-api-bar').style.width = `${Math.min(100, usage.apiRequests.percentUsed)}%`;
        document.getElementById('dash-api-percent').innerText = `${usage.apiRequests.percentUsed}% used`;
        if (usage.apiRequests.isExceeded) {
          document.getElementById('dash-api-text').classList.add('text-red-400');
        }
      }
      if (usage.daysUntilReset !== undefined) {
        document.getElementById('dash-bandwidth-reset').innerText = `Resets in ${usage.daysUntilReset}d`;
      }
    }

    const loginDiv = document.getElementById('dash-recent-logins');
    if (loginDiv) {
      loginDiv.innerHTML = `
        <div class="divide-y divide-slate-800/60">
          ${(profile.recentActivity || []).map(a => `
            <div class="py-2.5 flex items-center justify-between">
              <span class="font-mono text-slate-200">${a.ip_v4} ${a.ip_v6 ? `(${a.ip_v6})` : ''}</span>
              <span class="text-slate-500 truncate max-w-[200px]">${escapeHtml(a.user_agent)}</span>
              <span class="text-slate-400">${new Date(a.timestamp).toLocaleString()}</span>
            </div>
          `).join('') || '<div class="text-slate-500 py-2">No recent login records.</div>'}
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
        cards.push(`<div class="glass-card p-5 rounded-2xl border border-white/20 bg-white/5 flex items-center justify-between gap-4"><div class="flex items-center gap-3"><div class="w-11 h-11 rounded-xl bg-white/10 flex items-center justify-center text-white"><i data-lucide="mail" class="w-5 h-5"></i></div><div><div class="text-sm font-bold text-white">Contact</div><div class="text-xs text-slate-400 mt-1">${escapeHtml(publicSettings.contactEmail)}</div></div></div><a href="mailto:${escapeHtml(publicSettings.contactEmail)}" class="bg-white hover:bg-neutral-200 text-black text-xs font-bold px-4 py-2 rounded-lg transition-all">Email</a></div>`);
      }
      details.innerHTML = cards.join('');
      if (window.lucide) lucide.createIcons();
    }
  } catch (err) {}
}

async function renderProfileTab(container) {
  let usage = null;
  try {
    const profile = await apiRequest('/auth/profile');
    usage = profile.usage;
  } catch (err) {}

  const bwLimit = usage?.bandwidth?.formattedLimit || '15.00 GB';
  const bwUsed = usage?.bandwidth?.formattedUsed || '0 Bytes';
  const bwPct = usage?.bandwidth?.percentUsed || 0;
  const apiLimit = usage?.apiRequests?.formattedLimit || '100,000';
  const apiUsed = usage?.apiRequests?.formattedUsed || '0';
  const apiPct = usage?.apiRequests?.percentUsed || 0;
  const resetDays = usage?.daysUntilReset !== undefined ? `${usage.daysUntilReset} days` : '30 days';

  container.innerHTML = `
    <div class="max-w-2xl mx-auto space-y-6">
      <!-- User Identity Card -->
      <div class="glass-card p-6 rounded-2xl border border-slate-200 dark:border-white/10 flex flex-col sm:flex-row items-center sm:items-start gap-4">
        <div class="zencloud-avatar-badge w-14 h-14 rounded-xl text-xl uppercase shrink-0">
          ${AppState.user.username.substring(0, 2)}
        </div>
        <div class="flex-1 text-center sm:text-left min-w-0">
          <div class="flex flex-wrap items-center justify-center sm:justify-start gap-2">
            <h2 class="text-lg font-bold text-slate-900 dark:text-white tracking-tight">${escapeHtml(AppState.user.name || AppState.user.username)}</h2>
            <span class="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-slate-100 text-slate-700 dark:bg-white/10 dark:text-white">
              ${AppState.user.role}
            </span>
          </div>
          <p class="text-xs text-slate-500 font-mono mt-0.5">${escapeHtml(AppState.user.email || AppState.user.username)}</p>
          <div class="flex flex-wrap items-center justify-center sm:justify-start gap-3 mt-3 text-xs text-slate-500 dark:text-slate-400">
            <div class="flex items-center gap-1.5"><i data-lucide="shield-check" class="w-4 h-4 text-emerald-500"></i> Active Account</div>
            <div class="flex items-center gap-1.5"><i data-lucide="hard-drive" class="w-4 h-4 text-slate-400"></i> SFTP & S3 Storage</div>
          </div>
        </div>
      </div>

      <!-- Monthly Usage & Limits Card -->
      <div class="glass-card p-6 rounded-2xl border border-slate-200 dark:border-white/10 space-y-4">
        <div class="flex items-center justify-between border-b border-slate-100 dark:border-white/5 pb-3">
          <div>
            <h3 class="text-sm font-semibold text-slate-900 dark:text-white">Monthly Bandwidth & API Quota</h3>
            <p class="text-xs text-slate-500 mt-0.5">Rolling monthly cycle.</p>
          </div>
          <span class="text-xs text-slate-500 font-mono">
            Reset in ${resetDays}
          </span>
        </div>

        <div class="grid sm:grid-cols-2 gap-4 pt-1">
          <div class="p-4 rounded-xl bg-slate-50 dark:bg-neutral-900/60 border border-slate-100 dark:border-white/5 space-y-2">
            <div class="flex items-center justify-between text-xs text-slate-500">
              <span class="font-medium text-slate-700 dark:text-slate-300">Bandwidth</span>
              <span>${bwPct}%</span>
            </div>
            <div class="text-sm font-bold text-slate-900 dark:text-white">${bwUsed} <span class="text-xs font-normal text-slate-400">/ ${bwLimit}</span></div>
            <div class="w-full bg-slate-200 dark:bg-neutral-800 h-1.5 rounded-full overflow-hidden">
              <div class="bg-slate-900 dark:bg-white h-full rounded-full transition-all duration-300" style="width: ${Math.min(100, bwPct)}%"></div>
            </div>
          </div>

          <div class="p-4 rounded-xl bg-slate-50 dark:bg-neutral-900/60 border border-slate-100 dark:border-white/5 space-y-2">
            <div class="flex items-center justify-between text-xs text-slate-500">
              <span class="font-medium text-slate-700 dark:text-slate-300">API Calls</span>
              <span>${apiPct}%</span>
            </div>
            <div class="text-sm font-bold text-slate-900 dark:text-white">${apiUsed} <span class="text-xs font-normal text-slate-400">/ ${apiLimit}</span></div>
            <div class="w-full bg-slate-200 dark:bg-neutral-800 h-1.5 rounded-full overflow-hidden">
              <div class="bg-amber-500 dark:bg-amber-400 h-full rounded-full transition-all duration-300" style="width: ${Math.min(100, apiPct)}%"></div>
            </div>
          </div>
        </div>
      </div>

      <div class="glass-card p-6 rounded-2xl border border-slate-200 dark:border-white/10 space-y-4">
        <h3 class="text-sm font-semibold text-slate-900 dark:text-white border-b border-slate-100 dark:border-white/5 pb-3">User Profile Information</h3>
        
        <form onsubmit="handleProfileUpdate(event)" class="space-y-4">
          <div>
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Full Name</label>
            <input type="text" id="prof-name" value="${escapeHtml(AppState.user.name)}" class="w-full pitch-input rounded-xl px-4 py-2.5 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-white">
          </div>

          <div>
            <label class="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">Username</label>
            <input type="text" id="prof-username" value="${escapeHtml(AppState.user.username)}" class="w-full pitch-input rounded-xl px-4 py-2.5 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-white">
          </div>

          <div class="pt-4 border-t border-slate-100 dark:border-white/5">
            <h4 class="text-xs font-semibold text-slate-700 dark:text-slate-300 mb-3">Change Password (Optional)</h4>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label class="block text-xs text-slate-500 mb-1">Current Password</label>
                <input type="password" id="prof-curr-pass" class="w-full pitch-input rounded-xl px-3 py-2 text-sm text-slate-900 dark:text-white">
              </div>
              <div>
                <label class="block text-xs text-slate-500 mb-1">New Password</label>
                <input type="password" id="prof-new-pass" class="w-full pitch-input rounded-xl px-3 py-2 text-sm text-slate-900 dark:text-white">
              </div>
            </div>
          </div>

          <button type="submit" class="zencloud-btn-primary px-5 py-2.5 rounded-xl text-xs font-semibold shadow-sm">
            Save Profile Changes
          </button>
        </form>
      </div>

      <!-- Email Verification System -->
      <div class="glass-card p-6 rounded-2xl border border-slate-200 dark:border-white/10 space-y-4">
        <h3 class="text-sm font-semibold text-slate-900 dark:text-white border-b border-slate-100 dark:border-white/5 pb-3">Email Address</h3>
        <p class="text-xs text-slate-500">Current Email: <span class="font-medium text-slate-900 dark:text-white">${escapeHtml(AppState.user.email)}</span></p>

        <form onsubmit="handleEmailChangeRequest(event)" class="space-y-3">
          <div>
            <label class="block text-xs text-slate-500 mb-1">New Email Address</label>
            <input type="email" id="email-new-input" required class="w-full pitch-input rounded-xl px-4 py-2 text-sm text-slate-900 dark:text-white" placeholder="newemail@example.com">
          </div>
          <div>
            <label class="block text-xs text-slate-500 mb-1">Current Password Verification</label>
            <input type="password" id="email-pass-input" required class="w-full pitch-input rounded-xl px-4 py-2 text-sm text-slate-900 dark:text-white">
          </div>
          <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs px-4 py-2 rounded-xl transition-all">
            Send Verification Link
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
  const getTabClass = (tabKey) => {
    const isActive = AppState.adminTab === tabKey;
    if (isActive) {
      return 'px-4 py-2 rounded-lg text-xs font-bold transition-all bg-amber-600 text-white shadow-md shadow-amber-600/30';
    }
    return 'px-4 py-2 rounded-lg text-xs font-bold transition-all bg-slate-100 dark:bg-[#0c0c12] text-slate-700 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border border-slate-200 dark:border-[#181822]';
  };

  const isConsoleActive = AppState.adminTab === 'console';

  container.innerHTML = `
    <div class="space-y-6">
      <!-- Admin Navigation Sub-Tabs -->
      <div id="admin-subtab-nav" class="flex flex-wrap items-center gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
        <button data-admin-subtab="overview" onclick="switchAdminSubTab('overview')" class="${getTabClass('overview')}">Overview Stats</button>
        <button data-admin-subtab="users" onclick="switchAdminSubTab('users')" class="${getTabClass('users')}">User Management</button>
        <button data-admin-subtab="storage" onclick="switchAdminSubTab('storage')" class="${getTabClass('storage')}">Storage</button>
        <button data-admin-subtab="download-monitor" onclick="switchAdminSubTab('download-monitor')" class="${getTabClass('download-monitor')}">URL Downloads</button>
        <button data-admin-subtab="ip-history" onclick="switchAdminSubTab('ip-history')" class="${getTabClass('ip-history')}">IP Tracking</button>
        <button data-admin-subtab="smtp" onclick="switchAdminSubTab('smtp')" class="${getTabClass('smtp')}">SMTP Config</button>
        <button data-admin-subtab="email-templates" onclick="switchAdminSubTab('email-templates')" class="${getTabClass('email-templates')}">Email Templates</button>
        <button data-admin-subtab="details" onclick="switchAdminSubTab('details')" class="${getTabClass('details')}">Details</button>
        <button data-admin-subtab="settings" onclick="switchAdminSubTab('settings')" class="${getTabClass('settings')}">App Settings</button>
        <button data-admin-subtab="audit-logs" onclick="switchAdminSubTab('audit-logs')" class="${getTabClass('audit-logs')}">Audit Logs</button>
        
        <!-- VPS Console Button -->
        <button data-admin-subtab="console" onclick="switchAdminSubTab('console')" class="ml-auto ${isConsoleActive ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 ring-2 ring-emerald-400/50' : 'bg-emerald-600/15 hover:bg-emerald-600 text-emerald-600 dark:text-emerald-400 hover:text-white border border-emerald-500/30'} px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all">
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
  const navContainer = document.getElementById('admin-subtab-nav');
  if (navContainer) {
    const buttons = navContainer.querySelectorAll('[data-admin-subtab]');
    buttons.forEach(btn => {
      const subtab = btn.getAttribute('data-admin-subtab');
      if (subtab === tab) {
        if (subtab === 'console') {
          btn.className = 'ml-auto bg-emerald-600 text-white px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 shadow-lg shadow-emerald-600/30 ring-2 ring-emerald-400/50 transition-all';
        } else {
          btn.className = 'px-4 py-2 rounded-lg text-xs font-bold transition-all bg-amber-600 text-white shadow-md shadow-amber-600/30';
        }
      } else {
        if (subtab === 'console') {
          btn.className = 'ml-auto bg-emerald-600/15 hover:bg-emerald-600 text-emerald-600 dark:text-emerald-400 hover:text-white border border-emerald-500/30 px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 transition-all';
        } else {
          btn.className = 'px-4 py-2 rounded-lg text-xs font-bold transition-all bg-slate-100 dark:bg-[#0c0c12] text-slate-700 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white border border-slate-200 dark:border-[#181822]';
        }
      }
    });
  }
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
            <div>
              <h3 class="text-sm font-bold text-white">User Management</h3>
              <p class="text-xs text-slate-500 mt-1">Manage user storage, monthly bandwidth (15 GB limit), API calls (100k limit), account verification, and status.</p>
            </div>
            <button onclick="openCreateUserModal()" class="bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold px-4 py-2.5 rounded-xl flex items-center gap-2">
              <i data-lucide="user-plus" class="w-4 h-4"></i> Create New User
            </button>
          </div>
          <div class="glass-card rounded-2xl overflow-hidden border border-slate-800">
            <div class="admin-table-scroll"><div class="min-w-[1360px]">
              <div class="px-4 py-3 bg-slate-950/60 flex items-center text-xs font-semibold text-slate-400">
                <span class="w-12">ID</span><span class="flex-1">User</span><span class="w-28">Role</span><span class="w-36">Storage</span><span class="w-36">Monthly Bandwidth</span><span class="w-32">Monthly Requests</span><span class="w-44 text-center">Status</span><span class="w-64 text-right">Actions</span>
              </div>
              <div class="divide-y divide-slate-800/60">
                ${users.map(u => {
                  const isSelf = AppState.user && Number(u.id) === Number(AppState.user.id);
                  return `
                  <div class="px-4 py-3 flex items-center text-xs">
                    <span class="w-12 text-slate-500">#${u.id}</span>
                    <div class="flex-1 min-w-0 pr-3"><div class="font-bold text-white truncate">${escapeHtml(u.name)} (${escapeHtml(u.username)}) ${isSelf ? '<span class="text-[10px] text-amber-400 font-bold ml-1">YOU</span>' : ''}</div><div class="text-slate-400 truncate">${escapeHtml(u.email)}</div></div>
                    <div class="w-28">
                      <select ${isSelf ? 'disabled' : ''} onchange="changeUserRole('${u.id}', this.value)" class="bg-slate-900 border border-slate-800 rounded-lg px-2 py-1 text-xs text-white ${isSelf ? 'opacity-50 cursor-not-allowed' : ''}">
                        <option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option>
                        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
                      </select>
                    </div>
                    <span class="w-36 ${u.isOverQuota ? 'text-red-400 font-bold' : 'text-slate-300'}">${formatBytes(u.realUsedBytes)} / ${formatBytes(u.storage_quota_bytes)}</span>
                    <span class="w-36 text-slate-300">${u.bandwidthFormattedUsed} / ${u.bandwidthFormattedLimit}</span>
                    <span class="w-32 text-amber-300">${u.apiRequestsFormattedUsed} / ${u.apiRequestsFormattedLimit}</span>
                    <span class="w-44 text-center">
                      ${u.is_suspended 
                        ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-500/20 text-red-400 border border-red-500/30 cursor-help" title="${u.suspension_reason ? 'Suspended: ' + escapeHtml(u.suspension_reason) : 'Suspended'}">Suspended</span>` 
                        : (u.requires_otp_verification || u.is_suspicious)
                          ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-400 border border-amber-500/30 inline-flex items-center gap-1 cursor-help" title="Security verification required. OTP code: ${escapeHtml(u.otp_code || 'Sent')} | Reason: ${escapeHtml(u.otp_reason || u.suspicious_reason || 'Security check')}"><i data-lucide="shield-alert" class="w-3 h-3"></i> Verification (${u.otp_code || 'OTP'})</span>`
                          : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">Active</span>`
                      }
                    </span>
                    <div class="w-64 text-right flex items-center justify-end gap-1">
                      <button onclick="inspectUserDirectory('${u.id}', '${escapeHtml(u.username)}')" class="p-1.5 text-slate-400 hover:text-white rounded-lg" title="Browse / Inspect ${escapeHtml(u.username)}'s Directory"><i data-lucide="folder-open" class="w-4 h-4 text-white"></i></button>
                      <button onclick="openEditUserModal('${u.id}')" class="p-1.5 text-slate-400 hover:text-white rounded-lg" title="Edit User & Quotas"><i data-lucide="pencil" class="w-4 h-4"></i></button>
                      <button onclick="resetUserUsagePrompt('${u.id}', '${escapeHtml(u.username)}')" class="p-1.5 text-slate-400 hover:text-emerald-400 rounded-lg" title="Reset Monthly Bandwidth & API Cycle"><i data-lucide="rotate-ccw" class="w-4 h-4"></i></button>
                      <button onclick="editUserQuotaPrompt('${u.id}', '${u.storage_quota_bytes}')" class="p-1.5 text-slate-400 hover:text-amber-400 rounded-lg" title="Edit Storage Quota"><i data-lucide="hard-drive" class="w-4 h-4"></i></button>
                      
                      <!-- OTP Verification Controls -->
                      ${!isSelf ? (u.requires_otp_verification
                        ? `
                          <button onclick="handleLiftVerification('${u.id}', '${escapeHtml(u.username)}')" class="p-1.5 text-emerald-400 hover:bg-emerald-500/20 rounded-lg" title="Lift 4-Digit OTP Verification"><i data-lucide="shield-check" class="w-4 h-4"></i></button>
                          <button onclick="handleAdminResendOtp('${u.id}', '${escapeHtml(u.username)}')" class="p-1.5 text-amber-400 hover:bg-amber-500/20 rounded-lg" title="Resend 4-Digit OTP Code via Email"><i data-lucide="mail" class="w-4 h-4"></i></button>
                        `
                        : `
                          <button onclick="openPutOnVerificationModal('${u.id}', '${escapeHtml(u.username)}', '${escapeHtml(u.email)}', '${escapeHtml(u.name)}')" class="p-1.5 text-slate-400 hover:text-amber-400 hover:bg-amber-500/10 rounded-lg" title="Put on 4-Digit OTP Security Verification (Suspected)"><i data-lucide="shield-alert" class="w-4 h-4 text-amber-400"></i></button>
                        `
                      ) : ''}

                      ${!isSelf ? (u.is_suspended 
                        ? `<button onclick="openUnsuspendUserModal('${u.id}', '${escapeHtml(u.username)}', '${escapeHtml(u.email)}', '${escapeHtml(u.name)}')" class="p-1.5 text-slate-400 hover:text-emerald-400 rounded-lg" title="Unsuspend / Reactivate User"><i data-lucide="check-circle" class="w-4 h-4 text-emerald-400"></i></button>` 
                        : `<button onclick="openSuspendUserModal('${u.id}', '${escapeHtml(u.username)}', '${escapeHtml(u.email)}', '${escapeHtml(u.name)}')" class="p-1.5 text-slate-400 hover:text-red-400 rounded-lg" title="Suspend User (with Reason & Auto Mail)"><i data-lucide="ban" class="w-4 h-4 text-red-400"></i></button>`
                      ) : ''}
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
          ${logs.map(l => `<tr><td class="p-3 text-slate-500 whitespace-nowrap">${new Date(l.started_at).toLocaleString()}</td><td class="p-3 text-slate-200">${escapeHtml(l.username || 'Public')}</td><td class="p-3 font-mono text-white">${escapeHtml(l.ip_address || '—')}</td><td class="p-3 text-white">${escapeHtml(l.file_name || l.file_path || '—')}</td><td class="p-3 text-slate-300">${fmtBytesForAdmin(l.file_size_bytes)}</td><td class="p-3 text-slate-400 max-w-[350px] truncate" title="${escapeHtml(l.requested_url || '')}">${escapeHtml(l.endpoint || l.requested_url || '—')}</td><td class="p-3 ${l.status === 'completed' ? 'text-emerald-400' : l.status === 'failed' ? 'text-red-400' : 'text-amber-300'} font-semibold">${escapeHtml(l.status)}</td><td class="p-3">${escapeHtml(String(l.http_status || '—'))}</td><td class="p-3 text-slate-500">${l.completed_at ? new Date(l.completed_at).toLocaleString() : '—'}</td><td class="p-3 text-red-300 max-w-[300px] truncate">${escapeHtml(l.error || '—')}</td></tr>`).join('') || '<tr><td colspan="10" class="p-8 text-center text-slate-500">No download records found.</td></tr>'}
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
              ${loginHistory.map(r => `<tr><td class="py-3 pr-3"><div class="font-semibold text-slate-200">${escapeHtml(r.username)}</div><div class="text-slate-500">${escapeHtml(r.email)}</div></td><td class="py-3 pr-3 font-mono text-white">${escapeHtml(r.ip_v4 || '—')}</td><td class="py-3 pr-3 font-mono text-slate-300">${escapeHtml(r.ip_v6 || '—')}</td><td class="py-3 pr-3"><span class="px-2 py-1 rounded-md bg-slate-800 text-slate-300">${escapeHtml(r.action)}</span></td><td class="py-3 text-slate-500">${new Date(r.timestamp).toLocaleString()}</td></tr>`).join('') || '<tr><td colspan="5" class="py-8 text-center text-slate-500">No IP records found.</td></tr>'}
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
    } else if (AppState.adminTab === 'email-templates') {
      const templates = await apiRequest('/admin/email-templates');
      area.innerHTML = `
        <div class="space-y-4">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 class="text-sm font-bold text-white">Email Notification Templates</h3>
              <p class="text-xs text-slate-500 mt-1">Manage automated emails for account suspensions, reactivations, welcome messages, and security notices.</p>
            </div>
            <button onclick="renderAdminSubTabContent()" class="bg-slate-800 hover:bg-slate-700 text-slate-200 px-3 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5">
              <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> Refresh
            </button>
          </div>
          <div class="grid md:grid-cols-2 gap-4">
            ${templates.map(t => {
              const isSuspendTpl = t.slug === 'user_suspended';
              const isUnsuspendTpl = t.slug === 'user_unsuspended';
              const badgeClass = isSuspendTpl ? 'bg-red-500/20 text-red-400 border-red-500/30' : isUnsuspendTpl ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-white/10 text-white border-white/20';
              return `
              <div class="glass-card p-5 rounded-2xl border border-slate-800 flex flex-col justify-between gap-4">
                <div>
                  <div class="flex items-center justify-between gap-2 mb-2">
                    <span class="font-bold text-sm text-white">${escapeHtml(t.name)}</span>
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold border ${badgeClass}">${escapeHtml(t.slug)}</span>
                  </div>
                  <div class="text-xs text-slate-400 mb-1"><strong>Subject:</strong> <span class="text-slate-200">${escapeHtml(t.subject)}</span></div>
                </div>
                <div class="flex items-center justify-end gap-2 pt-2 border-t border-slate-800/60">
                  <button onclick="openEditEmailTemplateModal('${escapeHtml(t.slug)}')" class="bg-slate-800 hover:bg-slate-700 text-white px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors">
                    <i data-lucide="edit-3" class="w-3.5 h-3.5"></i> Edit Template
                  </button>
                </div>
              </div>`;
            }).join('')}
          </div>
        </div>
      `;
    } else if (AppState.adminTab === 'settings') {
      const settings = await apiRequest('/admin/settings');
      const enabled = String(settings.anti_multi_account_enabled) === 'true';
      const quotaGb = (parseInt(settings.default_storage_quota_bytes || '10737418240', 10) / 1073741824).toFixed(2);
      area.innerHTML = `
        <form onsubmit="handleSaveAppSettings(event)" class="max-w-2xl space-y-4">
          <div class="glass-card p-6 rounded-2xl border border-slate-800 space-y-4">
            <div><h3 class="text-sm font-bold text-white">Application Settings</h3><p class="text-xs text-slate-500 mt-1">Changes are stored in the database and used by the application.</p></div>
            <label class="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-900/60 border border-slate-800"><span><span class="block text-xs font-semibold text-white">Anti multi-account protection</span><span class="block text-[11px] text-slate-500 mt-1">Block registrations from a known IP.</span></span><input id="setting-anti-multi" type="checkbox" ${enabled ? 'checked' : ''} class="w-4 h-4 accent-white"></label>
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
            <label class="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-900/60 border border-slate-800"><span><span class="block text-xs font-semibold text-white">Show Discord section</span><span class="block text-[11px] text-slate-500 mt-1">Show the Discord logo and Join button on the dashboard.</span></span><input id="details-discord-enabled" type="checkbox" ${String(settings.discord_enabled) === 'true' ? 'checked' : ''} class="w-4 h-4 accent-white"></label>
            <div><label class="block text-xs text-slate-400 mb-1">Discord Join Link</label><input id="details-discord-url" type="url" value="${escapeHtml(settings.discord_join_url || '')}" placeholder="https://discord.gg/yourserver" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
            <label class="flex items-center justify-between gap-4 p-3 rounded-xl bg-slate-900/60 border border-slate-800"><span><span class="block text-xs font-semibold text-white">Show Contact Email</span><span class="block text-[11px] text-slate-500 mt-1">Show a contact email card on the dashboard.</span></span><input id="details-contact-enabled" type="checkbox" ${String(settings.contact_email_enabled) === 'true' ? 'checked' : ''} class="w-4 h-4 accent-white"></label>
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
            ${logs.map(log => `<tr><td class="p-3 text-slate-500 whitespace-nowrap">${new Date(log.timestamp).toLocaleString()}</td><td class="p-3 text-slate-200">${escapeHtml(log.username || 'System')}</td><td class="p-3"><span class="px-2 py-1 rounded-md bg-amber-500/10 text-amber-300">${escapeHtml(log.action)}</span></td><td class="p-3 font-mono text-white">${escapeHtml(log.ip_address || '—')}</td><td class="p-3 text-slate-400 max-w-[420px] truncate" title="${escapeHtml(log.details || '')}">${escapeHtml(log.details || '—')}</td></tr>`).join('') || '<tr><td colspan="5" class="p-8 text-center text-slate-500">No audit logs found.</td></tr>'}
          </tbody></table></div>
        </div>`;
    } else if (AppState.adminTab === 'console') {
      renderTerminalConsole(area);
      return;
    } else {
      area.innerHTML = '<div class="glass-card p-6 rounded-2xl border border-slate-200 dark:border-slate-800 text-sm text-slate-500">This admin section is not available yet.</div>';
    }
  } catch (err) {
    area.innerHTML = `<div class="glass-card p-6 rounded-2xl border border-red-500/20 bg-red-500/5"><div class="text-sm font-semibold text-red-400">Failed to load this admin section</div><div class="text-xs text-slate-400 mt-2">${escapeHtml(err.message)}</div><button onclick="renderAdminSubTabContent()" class="mt-4 px-3 py-2 rounded-lg bg-slate-800 text-slate-200 text-xs font-semibold">Retry</button></div>`;
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
  const currentMode = activeTerminalMode;
  container.innerHTML = `
    <div class="glass-card p-5 rounded-2xl border border-slate-200 dark:border-slate-800 space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-500">
            <i data-lucide="terminal" class="w-4 h-4"></i>
          </div>
          <div>
            <h3 class="text-sm font-bold text-slate-900 dark:text-white">VPS SSH Terminal Session</h3>
            <p class="text-xs text-slate-500 dark:text-slate-400">Interactive live bash shell for administrative server control.</p>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <!-- Connection Mode Switcher -->
          <div class="flex items-center bg-slate-100 dark:bg-slate-900/80 p-1 rounded-xl border border-slate-200 dark:border-slate-800 text-xs">
            <button onclick="setConsoleTerminalMode('auto')" class="px-2.5 py-1 rounded-lg font-semibold transition-all ${currentMode === 'auto' ? 'bg-slate-900 text-white dark:bg-white dark:text-black font-bold shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-white'}" title="Auto: Tries WebSocket, falls back instantly to HTTP Stream if blocked">
              Auto (WS + Fallback)
            </button>
            <button onclick="setConsoleTerminalMode('http')" class="px-2.5 py-1 rounded-lg font-semibold transition-all ${currentMode === 'http' ? 'bg-slate-900 text-white dark:bg-white dark:text-black font-bold shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-white'}" title="HTTP Stream: Reliable streaming through Cloudflare & restrictive reverse proxies">
              HTTP Stream
            </button>
            <button onclick="setConsoleTerminalMode('ws')" class="px-2.5 py-1 rounded-lg font-semibold transition-all ${currentMode === 'ws' ? 'bg-slate-900 text-white dark:bg-white dark:text-black font-bold shadow-sm' : 'text-slate-500 dark:text-slate-400 hover:text-white'}" title="WebSocket: Pure low-latency WebSocket connection">
              WebSocket
            </button>
          </div>

          <span id="terminal-status-badge" class="text-xs text-amber-500 font-mono flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20">
            <span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span> Connecting...
          </span>
          <button onclick="initXtermTerminal()" class="px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors">
            <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> Reconnect
          </button>
        </div>
      </div>

      <!-- Xterm Terminal Wrapper Container -->
      <div id="terminal-container" class="w-full h-[460px] bg-black rounded-xl p-3 border border-slate-800 overflow-hidden shadow-2xl"></div>

      <!-- VPS Troubleshooting Helper Card -->
      <div class="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 p-3.5">
        <details class="group">
          <summary class="flex items-center justify-between cursor-pointer list-none text-xs font-bold text-slate-700 dark:text-slate-300">
            <span class="flex items-center gap-2">
              <i data-lucide="help-circle" class="w-4 h-4 text-white"></i>
              VPS Deployment Notice: Solving "WebSocket Disconnected" on Custom Domains (Nginx / Cloudflare)
            </span>
            <span class="transition group-open:rotate-180 text-slate-400">▾</span>
          </summary>
          <div class="mt-3 text-xs text-slate-600 dark:text-slate-400 space-y-2 leading-relaxed border-t border-slate-200 dark:border-slate-800 pt-3">
            <p>
              If your VPS console showed <span class="font-mono text-red-400">WebSocket Error</span>, ZenCloud now <b>automatically falls back to HTTP Streaming</b> so you can use the interactive shell right away!
            </p>
            <p>
              To enable high-speed direct <b>WebSockets</b> on your VPS Nginx reverse proxy:
            </p>
            <pre class="bg-slate-900 text-slate-200 p-3 rounded-lg overflow-x-auto text-[11px] font-mono border border-slate-800">
# In /etc/nginx/sites-available/vps-storage:
location /api/admin/console {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400s;
}
            </pre>
            <p class="text-[11px] text-slate-500">
              <b>Cloudflare tip:</b> If your domain (e.g. <code>storage.zendevelopment.in</code>) uses Cloudflare proxy, verify that <b>WebSockets</b> is enabled in your Cloudflare dashboard under <i>Network → WebSockets</i> (enabled by default on all Cloudflare accounts).
            </p>
          </div>
        </details>
      </div>
    </div>
  `;

  if (window.lucide) lucide.createIcons();

  setTimeout(() => {
    initXtermTerminal();
  }, 100);
}

let activeTerminalSocket = null;
let activeTerminalInstance = null;
let activeFitAddon = null;
let activeHttpConsoleAbort = null;
let activeHttpConsoleSessionId = null;
let activeTerminalMode = localStorage.getItem('zen_console_mode') || 'auto'; // 'auto', 'ws', 'http'

function setConsoleTerminalMode(mode) {
  activeTerminalMode = mode;
  localStorage.setItem('zen_console_mode', mode);
  const area = document.getElementById('tab-content-area');
  if (area && AppState.adminTab === 'console') {
    renderTerminalConsole(area);
  } else {
    initXtermTerminal();
  }
}

async function startHttpConsoleSession(term, badge, applyFit) {
  if (activeHttpConsoleAbort) {
    try { activeHttpConsoleAbort.abort(); } catch (_) {}
    activeHttpConsoleAbort = null;
  }
  if (activeHttpConsoleSessionId) {
    const sId = activeHttpConsoleSessionId;
    activeHttpConsoleSessionId = null;
    apiRequest('/admin/console/close', { method: 'POST', body: { sessionId: sId } }).catch(() => {});
  }

  if (badge) {
    badge.className = 'text-xs text-amber-500 font-mono flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20';
    badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span> Connecting via HTTP Stream...';
  }

  const abortController = new AbortController();
  activeHttpConsoleAbort = abortController;

  try {
    term.write('\r\n\x1b[36m[Connecting via Interactive HTTP Streaming Shell...]\x1b[0m\r\n');
    const token = AppState.token || '';
    const res = await fetch(`/api/admin/console/stream?token=${encodeURIComponent(token)}`, {
      signal: abortController.signal,
      cache: 'no-store'
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error || `HTTP ${res.status} ${res.statusText}`);
    }

    let sessionId = res.headers.get('X-Console-Session-Id');

    if (badge) {
      badge.className = 'text-xs text-emerald-500 font-mono flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20';
      badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500"></span> Live SSH (HTTP Stream)';
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');

    // Attach keyboard listener
    term.onData(async (data) => {
      if (!activeHttpConsoleSessionId) return;
      try {
        await fetch('/api/admin/console/input', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${AppState.token}`
          },
          body: JSON.stringify({ sessionId: activeHttpConsoleSessionId, data })
        });
      } catch (err) {
        console.warn('Console input write error:', err);
      }
    });

    // Attach resize listener
    term.onResize(async ({ cols, rows }) => {
      if (!activeHttpConsoleSessionId) return;
      try {
        await fetch('/api/admin/console/resize', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${AppState.token}`
          },
          body: JSON.stringify({ sessionId: activeHttpConsoleSessionId, cols, rows })
        });
      } catch (_) {}
    });

    applyFit();
    term.focus();

    // Stream reading loop
    let isFirstChunk = true;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let text = decoder.decode(value, { stream: true });
      if (isFirstChunk) {
        isFirstChunk = false;
        const match = text.match(/\[SESSION_ID:([a-f0-9]+)\]\r?\n?/);
        if (match) {
          sessionId = match[1];
          text = text.replace(/\[SESSION_ID:[a-f0-9]+\]\r?\n?/, '');
        }
        activeHttpConsoleSessionId = sessionId;
        if (term.cols && term.rows) {
          fetch('/api/admin/console/resize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AppState.token}` },
            body: JSON.stringify({ sessionId, cols: term.cols, rows: term.rows })
          }).catch(() => {});
        }
      }
      if (text) term.write(text);
    }

    if (badge) {
      badge.className = 'text-xs text-slate-400 font-mono flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-500/10 border border-slate-500/20';
      badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-slate-500"></span> Session Ended';
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (badge) {
      badge.className = 'text-xs text-red-500 font-mono flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/20';
      badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-500"></span> Disconnected';
    }
    term.write(`\r\n\x1b[31m[HTTP Stream Connection Error: ${err.message}]\x1b[0m\r\n`);
  }
}

function initXtermTerminal() {
  const container = document.getElementById('terminal-container');
  const badge = document.getElementById('terminal-status-badge');
  if (!container) return;

  // Cleanup existing socket session if open
  if (activeTerminalSocket) {
    try { activeTerminalSocket.close(); } catch (e) {}
    activeTerminalSocket = null;
  }
  // Cleanup existing HTTP session if open
  if (activeHttpConsoleAbort) {
    try { activeHttpConsoleAbort.abort(); } catch (_) {}
    activeHttpConsoleAbort = null;
  }
  if (activeHttpConsoleSessionId) {
    const sId = activeHttpConsoleSessionId;
    activeHttpConsoleSessionId = null;
    apiRequest('/admin/console/close', { method: 'POST', body: { sessionId: sId } }).catch(() => {});
  }

  if (activeTerminalInstance) {
    try { activeTerminalInstance.dispose(); } catch (e) {}
    activeTerminalInstance = null;
  }
  container.innerHTML = '';

  const TermClass = window.Terminal || (window.Terminal && window.Terminal.Terminal);
  if (!TermClass) {
    container.innerHTML = '<div class="p-4 text-xs font-mono text-red-400 flex items-center gap-2"><i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Loading terminal engine... Please click Reconnect in a moment.</div>';
    if (window.lucide) lucide.createIcons();
    return;
  }

  const term = new TermClass({
    cursorBlink: true,
    cursorStyle: 'block',
    fontSize: 13,
    fontFamily: 'Menlo, Monaco, Consolas, "Courier New", monospace',
    lineHeight: 1.25,
    convertEol: true,
    scrollback: 5000,
    theme: {
      background: '#040406',
      foreground: '#f1f5f9',
      cursor: '#38bdf8',
      cursorAccent: '#000000',
      selectionBackground: '#0284c7',
      selectionForeground: '#ffffff',
      black: '#1e293b',
      red: '#f87171',
      green: '#34d399',
      yellow: '#fbbf24',
      blue: '#38bdf8',
      magenta: '#e879f9',
      cyan: '#22d3ee',
      white: '#f8fafc',
      brightBlack: '#475569',
      brightRed: '#ef4444',
      brightGreen: '#10b981',
      brightYellow: '#f59e0b',
      brightBlue: '#0ea5e9',
      brightMagenta: '#d946ef',
      brightCyan: '#06b6d4',
      brightWhite: '#ffffff'
    }
  });

  activeTerminalInstance = term;

  let fitAddon = null;
  try {
    if (typeof FitAddon !== 'undefined' && FitAddon.FitAddon) {
      fitAddon = new FitAddon.FitAddon();
    } else if (typeof window.FitAddon !== 'undefined') {
      fitAddon = typeof window.FitAddon === 'function' ? new window.FitAddon() : new window.FitAddon.FitAddon();
    }
  } catch (e) {
    console.warn('FitAddon initialization fallback:', e);
  }

  activeFitAddon = fitAddon;

  if (fitAddon) {
    term.loadAddon(fitAddon);
  }

  term.open(container);

  const applyFit = () => {
    if (fitAddon && container.offsetWidth > 0) {
      try {
        fitAddon.fit();
        if (activeTerminalSocket && activeTerminalSocket.readyState === WebSocket.OPEN && term.cols && term.rows) {
          activeTerminalSocket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } catch (e) {}
    }
  };

  requestAnimationFrame(() => {
    applyFit();
    setTimeout(applyFit, 150);
  });

  container.addEventListener('click', () => {
    term.focus();
  });
  window.addEventListener('resize', applyFit);

  // If user selected Force HTTP Stream mode, jump straight to HTTP stream session
  if (activeTerminalMode === 'http') {
    startHttpConsoleSession(term, badge, applyFit);
    return;
  }

  // Otherwise, attempt WebSocket (with auto-fallback to HTTP stream if mode is 'auto')
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/api/admin/console?token=${encodeURIComponent(AppState.token || '')}`;

  if (badge) {
    badge.className = 'text-xs text-amber-500 font-mono flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20';
    badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span> Connecting via WebSocket...';
  }

  let wsOpened = false;
  let connectionTimeout = setTimeout(() => {
    if (!wsOpened && activeTerminalMode === 'auto') {
      try { if (activeTerminalSocket) activeTerminalSocket.close(); } catch (_) {}
      activeTerminalSocket = null;
      term.write('\r\n\x1b[33m[Notice: WebSocket handshake timed out on VPS. Switching to HTTP Stream console...]\x1b[0m\r\n');
      startHttpConsoleSession(term, badge, applyFit);
    }
  }, 3500);

  try {
    const ws = new WebSocket(wsUrl);
    activeTerminalSocket = ws;

    ws.onopen = () => {
      wsOpened = true;
      clearTimeout(connectionTimeout);
      if (badge) {
        badge.className = 'text-xs text-emerald-500 font-mono flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20';
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-emerald-500"></span> Live SSH (WebSocket)';
      }
      applyFit();
      term.focus();
    };

    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        term.write(event.data);
      } else if (event.data instanceof Blob) {
        const reader = new FileReader();
        reader.onload = () => {
          term.write(new Uint8Array(reader.result));
        };
        reader.readAsArrayBuffer(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      }
    };

    ws.onerror = () => {
      clearTimeout(connectionTimeout);
      if (activeTerminalMode === 'auto' && !wsOpened) {
        try { ws.close(); } catch (_) {}
        activeTerminalSocket = null;
        term.write('\r\n\x1b[33m[Notice: WebSocket blocked by reverse proxy or Cloudflare. Auto-switching to HTTP Stream console...]\x1b[0m\r\n');
        startHttpConsoleSession(term, badge, applyFit);
        return;
      }

      if (badge) {
        badge.className = 'text-xs text-red-500 font-mono flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/20';
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-500"></span> Disconnected';
      }
      term.write('\r\n\x1b[31m[WebSocket Error: Unable to establish live terminal connection]\x1b[0m\r\n');
      term.write('\x1b[36mTip: Click the "HTTP Stream" button above to connect immediately without WebSockets!\x1b[0m\r\n');
    };

    ws.onclose = () => {
      clearTimeout(connectionTimeout);
      if (badge && wsOpened) {
        badge.className = 'text-xs text-slate-400 font-mono flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-500/10 border border-slate-500/20';
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-slate-500"></span> Session Closed';
      }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

  } catch (err) {
    clearTimeout(connectionTimeout);
    if (activeTerminalMode === 'auto') {
      term.write(`\r\n\x1b[33m[WebSocket init error: ${err.message}. Switching to HTTP Stream console...]\x1b[0m\r\n`);
      startHttpConsoleSession(term, badge, applyFit);
    } else {
      if (badge) {
        badge.className = 'text-xs text-red-500 font-mono flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/20';
        badge.innerHTML = '<span class="w-2 h-2 rounded-full bg-red-500"></span> Error';
      }
      term.write(`\r\n\x1b[31mFailed to initialize WebSocket: ${err.message}\x1b[0m\r\n`);
    }
  }
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
        <div class="grid sm:grid-cols-3 gap-3">
          <div><label class="block text-xs text-slate-400 mb-1">Storage (GB)</label><input id="create-user-quota" type="number" min="0.01" step="0.01" value="10" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
          <div><label class="block text-xs text-slate-400 mb-1">Bandwidth (GB/mo)</label><input id="create-user-bw" type="number" min="1" step="1" value="15" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
          <div><label class="block text-xs text-slate-400 mb-1">API Calls (/mo)</label><input id="create-user-api" type="number" min="1000" step="1000" value="100000" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
        </div>
        <div class="flex justify-end gap-2 pt-3"><button type="button" onclick="document.getElementById('create-user-modal')?.remove()" class="px-4 py-2.5 rounded-lg bg-slate-800 text-slate-300 text-xs font-bold">Cancel</button><button type="submit" class="px-4 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold">Create User</button></div>
      </form>
    </div>`;
  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();
}

async function handleCreateUser(e) {
  e.preventDefault();
  const quotaGb = parseFloat(document.getElementById('create-user-quota')?.value || '0');
  const bwGb = parseFloat(document.getElementById('create-user-bw')?.value || '15');
  const apiReqs = parseInt(document.getElementById('create-user-api')?.value || '100000', 10);
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
        storageQuotaBytes: Math.round(quotaGb * 1073741824),
        bandwidthLimitBytes: Math.round(bwGb * 1073741824),
        apiRequestsLimit: apiReqs
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
  const bwGb = ((Number(user.bandwidth_limit_bytes) || 16106127360) / 1073741824).toFixed(1);
  const apiLimit = Number(user.api_requests_limit) || 100000;
  
  const modal = document.createElement('div');
  modal.id = 'edit-user-modal';
  modal.className = 'fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="w-full max-w-lg glass-card rounded-2xl border border-slate-700 shadow-2xl p-6 max-h-[90vh] overflow-y-auto">
      <div class="flex items-center justify-between mb-5"><div><h3 class="text-base font-bold text-white">Edit User & Quotas</h3><p class="text-xs text-slate-500 mt-1">Update profile, quotas, bandwidth and API request limits.</p></div><button type="button" onclick="document.getElementById('edit-user-modal')?.remove()" class="text-slate-400 hover:text-white"><i data-lucide="x" class="w-5 h-5"></i></button></div>
      <form onsubmit="handleEditUser(event, ${Number(user.id)})" class="space-y-3">
        <div class="grid sm:grid-cols-2 gap-3"><div><label class="block text-xs text-slate-400 mb-1">Full Name</label><input id="edit-user-name" value="${escapeHtml(user.name)}" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div><div><label class="block text-xs text-slate-400 mb-1">Username</label><input id="edit-user-username" value="${escapeHtml(user.username)}" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div></div>
        <div><label class="block text-xs text-slate-400 mb-1">Email</label><input id="edit-user-email" type="email" value="${escapeHtml(user.email)}" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
        <div class="grid sm:grid-cols-2 gap-3"><div><label class="block text-xs text-slate-400 mb-1">New Password</label><input id="edit-user-password" type="password" minlength="6" placeholder="Leave blank to keep current" class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div><div><label class="block text-xs text-slate-400 mb-1">Role</label><select id="edit-user-role" ${isSelf ? 'disabled' : ''} class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"><option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option></select></div></div>
        <div class="grid sm:grid-cols-3 gap-3">
          <div><label class="block text-xs text-slate-400 mb-1">Storage (GB)</label><input id="edit-user-quota" type="number" min="0.01" step="0.01" value="${(Number(user.storage_quota_bytes || 0) / 1073741824).toFixed(2)}" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
          <div><label class="block text-xs text-slate-400 mb-1">Bandwidth (GB/mo)</label><input id="edit-user-bw" type="number" min="1" step="0.5" value="${bwGb}" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
          <div><label class="block text-xs text-slate-400 mb-1">API Calls (/mo)</label><input id="edit-user-api" type="number" min="1000" step="1000" value="${apiLimit}" required class="w-full bg-slate-900 border border-slate-800 rounded-lg p-2.5 text-sm text-white"></div>
        </div>
        <div class="flex justify-end gap-2 pt-3"><button type="button" onclick="document.getElementById('edit-user-modal')?.remove()" class="px-4 py-2.5 rounded-lg bg-slate-800 text-slate-300 text-xs font-bold">Cancel</button><button type="submit" class="px-4 py-2.5 rounded-lg bg-white hover:bg-neutral-200 text-black text-xs font-bold transition-all">Save Changes</button></div>
      </form>
    </div>`;
  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();
}

async function handleEditUser(e, userId) {
  e.preventDefault();
  const quotaGb = parseFloat(document.getElementById('edit-user-quota')?.value || '0');
  const bwGb = parseFloat(document.getElementById('edit-user-bw')?.value || '15');
  const apiReqs = parseInt(document.getElementById('edit-user-api')?.value || '100000', 10);
  if (!(quotaGb > 0)) return showToast('Storage quota must be greater than 0.', 'error');

  const password = document.getElementById('edit-user-password').value;
  const body = {
    name: document.getElementById('edit-user-name').value.trim(),
    username: document.getElementById('edit-user-username').value.trim(),
    email: document.getElementById('edit-user-email').value.trim(),
    storageQuotaBytes: Math.round(quotaGb * 1073741824),
    bandwidthLimitBytes: Math.round(bwGb * 1073741824),
    apiRequestsLimit: apiReqs
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

async function resetUserUsagePrompt(userId, username) {
  if (!confirm(`Reset monthly bandwidth and API request usage cycle for @${username}?`)) return;
  try {
    await apiRequest(`/admin/users/${userId}/reset-usage`, { method: 'POST' });
    showToast(`Monthly usage for @${username} has been reset.`, 'success');
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

function openPutOnVerificationModal(userId, username, email, name) {
  document.getElementById('put-verification-modal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'put-verification-modal';
  modal.className = 'fixed inset-0 z-[60] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="w-full max-w-md glass-card rounded-2xl border border-amber-500/30 shadow-2xl p-6 space-y-4">
      <div class="flex items-center justify-between border-b border-slate-800 pb-3">
        <div class="flex items-center gap-2.5">
          <div class="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center">
            <i data-lucide="shield-alert" class="w-5 h-5"></i>
          </div>
          <div>
            <h3 class="text-base font-bold text-white">Require Security Verification</h3>
            <p class="text-xs text-slate-400">Put @${escapeHtml(username)} on 4-Digit OTP verification</p>
          </div>
        </div>
        <button type="button" onclick="document.getElementById('put-verification-modal')?.remove()" class="text-slate-400 hover:text-white">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>
      </div>

      <p class="text-xs text-slate-300 leading-relaxed">
        If you suspect this account of policy violation or suspicious logins, placing it under verification will lock their access until they enter the <b>4-digit OTP code</b> sent to their registered email (<b>${escapeHtml(email || username)}</b>).
      </p>

      <form onsubmit="handlePutOnVerification(event, ${Number(userId)})" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Reason for Security Review</label>
          <input type="text" id="verification-reason-input" required value="Suspicious account activity detected. Please verify your identity." class="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-amber-500">
          <p class="text-[11px] text-slate-500 mt-1">This reason will be included in the email and displayed on their screen.</p>
        </div>

        <div class="flex justify-end gap-2 pt-2 border-t border-slate-800">
          <button type="button" onclick="document.getElementById('put-verification-modal')?.remove()" class="px-4 py-2.5 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold">Cancel</button>
          <button type="submit" id="btn-submit-verification" class="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold transition-all flex items-center gap-1.5">
            <i data-lucide="send" class="w-3.5 h-3.5"></i>
            <span>Send OTP & Require Verification</span>
          </button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();
}

async function handlePutOnVerification(e, userId) {
  e.preventDefault();
  const reason = document.getElementById('verification-reason-input')?.value.trim();
  const btn = document.getElementById('btn-submit-verification');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Placing on verification...`;
    if (window.lucide) lucide.createIcons();
  }

  try {
    const data = await apiRequest(`/admin/users/${userId}/require-verification`, {
      method: 'POST',
      body: { reason }
    });

    document.getElementById('put-verification-modal')?.remove();
    showToast(data.message || 'User placed on 4-digit OTP verification.', 'success');
    await renderAdminSubTabContent();
  } catch (err) {
    showToast(err.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="send" class="w-3.5 h-3.5"></i> Send OTP & Require Verification`;
      if (window.lucide) lucide.createIcons();
    }
  }
}

async function handleLiftVerification(userId, username) {
  if (!confirm(`Lift security OTP verification requirement for @${username}? The user will regain normal access immediately.`)) return;

  try {
    const data = await apiRequest(`/admin/users/${userId}/lift-verification`, {
      method: 'POST'
    });
    showToast(data.message || `Verification requirement lifted for @${username}.`, 'success');
    await renderAdminSubTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleAdminResendOtp(userId, username) {
  try {
    const data = await apiRequest(`/admin/users/${userId}/resend-otp`, {
      method: 'POST'
    });
    showToast(data.message || `New 4-digit OTP generated (Code: ${data.otpCode}) and email sent to @${username}.`, 'success');
    await renderAdminSubTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function toggleUserSuspend(userId, currentStatus) {
  const user = (AppState.adminUsers || []).find(u => Number(u.id) === Number(userId));
  if (!user) return showToast('User not found.', 'error');

  if (currentStatus) {
    openUnsuspendUserModal(user.id, user.username, user.email, user.name);
  } else {
    openSuspendUserModal(user.id, user.username, user.email, user.name);
  }
}

function openSuspendUserModal(userId, username, email, name) {
  document.getElementById('suspend-user-modal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'suspend-user-modal';
  modal.className = 'fixed inset-0 z-[60] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="w-full max-w-lg glass-card rounded-2xl border border-red-500/30 shadow-2xl p-6 space-y-4">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center text-red-400 shrink-0">
            <i data-lucide="ban" class="w-5 h-5"></i>
          </div>
          <div>
            <h3 class="text-base font-bold text-white">Suspend User Account</h3>
            <p class="text-xs text-slate-400 mt-0.5">Restrict user access and dispatch automated suspension email.</p>
          </div>
        </div>
        <button type="button" onclick="document.getElementById('suspend-user-modal')?.remove()" class="text-slate-400 hover:text-white p-1">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>
      </div>

      <!-- Target User Info -->
      <div class="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs space-y-1">
        <div class="flex justify-between text-slate-300">
          <span class="text-slate-500">User:</span>
          <span class="font-bold text-white">${escapeHtml(name)} (@${escapeHtml(username)})</span>
        </div>
        <div class="flex justify-between text-slate-300">
          <span class="text-slate-500">Email Address:</span>
          <span class="font-mono text-white">${escapeHtml(email)}</span>
        </div>
      </div>

      <form onsubmit="handleSuspendUserSubmit(event, ${Number(userId)}, '${escapeHtml(username)}')" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold uppercase text-slate-300 mb-1.5">
            Reason for Suspension <span class="text-red-400">*</span>
          </label>
          <textarea id="suspend-reason-input" required rows="3" class="w-full bg-slate-950 border border-slate-800 focus:border-red-500 focus:ring-1 focus:ring-red-500 rounded-xl p-3 text-xs text-white placeholder-slate-500 outline-none resize-none" placeholder="Enter specific reason for suspension (e.g., Excessive storage overage, Terms of Service violation, suspicious activity)..."></textarea>
          <p class="text-[11px] text-slate-400 mt-1">This reason is recorded in audit logs and immediately sent to the user in their suspension email.</p>
        </div>

        <div class="p-3 rounded-xl bg-red-950/30 border border-red-500/20 flex items-start gap-2.5 text-xs text-red-200">
          <i data-lucide="mail" class="w-4 h-4 text-red-400 shrink-0 mt-0.5"></i>
          <span>An automated SMTP suspension notification will be emailed to <strong>${escapeHtml(email)}</strong> with the reason provided above.</span>
        </div>

        <div class="flex items-center justify-end gap-2.5 pt-2">
          <button type="button" onclick="document.getElementById('suspend-user-modal')?.remove()" class="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors">
            Cancel
          </button>
          <button type="submit" id="btn-submit-suspend" class="px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold shadow-lg shadow-red-600/30 flex items-center gap-2 transition-all">
            <i data-lucide="ban" class="w-4 h-4"></i> Suspend User & Send Mail
          </button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();
  setTimeout(() => document.getElementById('suspend-reason-input')?.focus(), 50);
}

async function handleSuspendUserSubmit(e, userId, username) {
  e.preventDefault();
  const reason = document.getElementById('suspend-reason-input')?.value.trim();
  if (!reason) return showToast('Please enter a suspension reason.', 'error');

  const submitBtn = document.getElementById('btn-submit-suspend');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Suspending...';
    if (window.lucide) lucide.createIcons();
  }

  try {
    const res = await apiRequest(`/admin/users/${userId}/suspend`, {
      method: 'POST',
      body: { reason }
    });
    document.getElementById('suspend-user-modal')?.remove();
    showToast(res.message || `User @${username} suspended and email sent!`, 'success');
    await renderAdminSubTabContent();
  } catch (err) {
    showToast(err.message || 'Failed to suspend user.', 'error');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i data-lucide="ban" class="w-4 h-4"></i> Suspend User & Send Mail';
      if (window.lucide) lucide.createIcons();
    }
  }
}

function openUnsuspendUserModal(userId, username, email, name) {
  document.getElementById('unsuspend-user-modal')?.remove();

  const user = (AppState.adminUsers || []).find(u => Number(u.id) === Number(userId));
  const priorReason = user?.suspension_reason || '';

  const modal = document.createElement('div');
  modal.id = 'unsuspend-user-modal';
  modal.className = 'fixed inset-0 z-[60] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4';
  modal.innerHTML = `
    <div class="w-full max-w-lg glass-card rounded-2xl border border-emerald-500/30 shadow-2xl p-6 space-y-4">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
            <i data-lucide="check-circle" class="w-5 h-5"></i>
          </div>
          <div>
            <h3 class="text-base font-bold text-white">Reactivate User Account</h3>
            <p class="text-xs text-slate-400 mt-0.5">Lift suspension and dispatch automated reactivation email.</p>
          </div>
        </div>
        <button type="button" onclick="document.getElementById('unsuspend-user-modal')?.remove()" class="text-slate-400 hover:text-white p-1">
          <i data-lucide="x" class="w-5 h-5"></i>
        </button>
      </div>

      <!-- Target User Info -->
      <div class="p-3.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs space-y-1">
        <div class="flex justify-between text-slate-300">
          <span class="text-slate-500">User:</span>
          <span class="font-bold text-white">${escapeHtml(name)} (@${escapeHtml(username)})</span>
        </div>
        <div class="flex justify-between text-slate-300">
          <span class="text-slate-500">Email Address:</span>
          <span class="font-mono text-white">${escapeHtml(email)}</span>
        </div>
        ${priorReason ? `
        <div class="pt-1 border-t border-slate-800/80 text-[11px] text-amber-300">
          <span class="text-slate-500">Previous Suspension Reason:</span> ${escapeHtml(priorReason)}
        </div>` : ''}
      </div>

      <form onsubmit="handleUnsuspendUserSubmit(event, ${Number(userId)}, '${escapeHtml(username)}')" class="space-y-4">
        <div>
          <label class="block text-xs font-semibold uppercase text-slate-300 mb-1.5">
            Reactivation Message / Note
          </label>
          <textarea id="unsuspend-reason-input" rows="3" class="w-full bg-slate-950 border border-slate-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 rounded-xl p-3 text-xs text-white placeholder-slate-500 outline-none resize-none" placeholder="Optional message included in the reactivation email...">Your account suspension has been lifted and access has been restored.</textarea>
          <p class="text-[11px] text-slate-400 mt-1">This message will be included in the automated reactivation email sent to the user.</p>
        </div>

        <div class="p-3 rounded-xl bg-emerald-950/30 border border-emerald-500/20 flex items-start gap-2.5 text-xs text-emerald-200">
          <i data-lucide="mail" class="w-4 h-4 text-emerald-400 shrink-0 mt-0.5"></i>
          <span>An automated SMTP reactivation notification will be emailed to <strong>${escapeHtml(email)}</strong> with the login link.</span>
        </div>

        <div class="flex items-center justify-end gap-2.5 pt-2">
          <button type="button" onclick="document.getElementById('unsuspend-user-modal')?.remove()" class="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors">
            Cancel
          </button>
          <button type="submit" id="btn-submit-unsuspend" class="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold shadow-lg shadow-emerald-600/30 flex items-center gap-2 transition-all">
            <i data-lucide="check-circle" class="w-4 h-4"></i> Reactivate & Send Mail
          </button>
        </div>
      </form>
    </div>
  `;

  document.body.appendChild(modal);
  if (window.lucide) lucide.createIcons();
  setTimeout(() => document.getElementById('unsuspend-reason-input')?.focus(), 50);
}

async function handleUnsuspendUserSubmit(e, userId, username) {
  e.preventDefault();
  const reason = document.getElementById('unsuspend-reason-input')?.value.trim() || 'Your account suspension has been lifted and access has been restored.';

  const submitBtn = document.getElementById('btn-submit-unsuspend');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Reactivating...';
    if (window.lucide) lucide.createIcons();
  }

  try {
    const res = await apiRequest(`/admin/users/${userId}/unsuspend`, {
      method: 'POST',
      body: { reason }
    });
    document.getElementById('unsuspend-user-modal')?.remove();
    showToast(res.message || `User @${username} reactivated and email sent!`, 'success');
    await renderAdminSubTabContent();
  } catch (err) {
    showToast(err.message || 'Failed to unsuspend user.', 'error');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i data-lucide="check-circle" class="w-4 h-4"></i> Reactivate & Send Mail';
      if (window.lucide) lucide.createIcons();
    }
  }
}

async function openEditEmailTemplateModal(slug) {
  try {
    const templates = await apiRequest('/admin/email-templates');
    const tpl = templates.find(t => t.slug === slug);
    if (!tpl) return showToast('Template not found.', 'error');

    document.getElementById('edit-template-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'edit-template-modal';
    modal.className = 'fixed inset-0 z-[60] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4';
    modal.innerHTML = `
      <div class="w-full max-w-2xl glass-card rounded-2xl border border-slate-700 shadow-2xl p-6 max-h-[90vh] overflow-y-auto space-y-4">
        <div class="flex items-center justify-between border-b border-slate-800 pb-3">
          <div>
            <h3 class="text-base font-bold text-white">Edit Email Template</h3>
            <p class="text-xs text-slate-400 mt-0.5">${escapeHtml(tpl.name)} (<code>${escapeHtml(tpl.slug)}</code>)</p>
          </div>
          <button type="button" onclick="document.getElementById('edit-template-modal')?.remove()" class="text-slate-400 hover:text-white p-1">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
        </div>

        <form onsubmit="handleSaveEmailTemplate(event, '${escapeHtml(tpl.slug)}')" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">Subject Line</label>
            <input type="text" id="tpl-subject" value="${escapeHtml(tpl.subject)}" required class="w-full bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none focus:border-white">
          </div>

          <div>
            <label class="block text-xs font-semibold uppercase text-slate-400 mb-1">HTML Body</label>
            <textarea id="tpl-body" rows="12" required class="w-full bg-slate-900 border border-slate-800 rounded-xl p-3 font-mono text-xs text-white focus:outline-none focus:border-white leading-relaxed">${escapeHtml(tpl.body_html)}</textarea>
            <p class="text-[11px] text-slate-500 mt-1">Available placeholders: <code>{{name}}</code>, <code>{{username}}</code>, <code>{{reason}}</code>, <code>{{suspended_at}}</code>, <code>{{reactivated_at}}</code>, <code>{{login_url}}</code>, <code>{{app_name}}</code></p>
          </div>

          <div class="flex justify-end gap-2 pt-2 border-t border-slate-800">
            <button type="button" onclick="document.getElementById('edit-template-modal')?.remove()" class="px-4 py-2.5 rounded-xl bg-slate-800 text-slate-300 text-xs font-bold">Cancel</button>
            <button type="submit" class="px-5 py-2.5 rounded-xl bg-white hover:bg-neutral-200 text-black text-xs font-bold transition-all">Save Template</button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(modal);
    if (window.lucide) lucide.createIcons();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleSaveEmailTemplate(e, slug) {
  e.preventDefault();
  const subject = document.getElementById('tpl-subject')?.value.trim();
  const body_html = document.getElementById('tpl-body')?.value;

  try {
    await apiRequest(`/admin/email-templates/${slug}`, {
      method: 'PUT',
      body: { subject, body_html }
    });
    document.getElementById('edit-template-modal')?.remove();
    showToast('Email template updated successfully.', 'success');
    await renderAdminSubTabContent();
  } catch (err) {
    showToast(err.message, 'error');
  }
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

  // If user has an active token, validate session and sync profile
  if (AppState.token) {
    try {
      const profileData = await apiRequest('/auth/profile');
      if (profileData && profileData.user) {
        AppState.user = profileData.user;
        localStorage.setItem('vps_user', JSON.stringify(profileData.user));
        
        // If user is verified and does not require OTP, ensure OTP sessions and hashes are cleared
        if (!profileData.user.requires_otp_verification) {
          AppState.otpSessionData = null;
          if (window.location.hash.startsWith('#otp-verification')) {
            if (window.history && window.history.replaceState) {
              window.history.replaceState(null, '', window.location.pathname + window.location.search);
            } else {
              window.location.hash = '';
            }
          }
        }
      }
    } catch (e) {
      if (e && e.requiresOtpVerification) {
        AppState.otpSessionData = e;
      }
    }
  }

  renderApp();
});

window.addEventListener('hashchange', () => {
  renderApp();
});
