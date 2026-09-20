const { getRow, getAll, runQuery } = require('../database/db');

// Default Limits: 15 GB Bandwidth, 100,000 API requests per month
const DEFAULT_MONTHLY_BANDWIDTH_BYTES = 15 * 1024 * 1024 * 1024; // 16,106,127,360 bytes (15 GB)
const DEFAULT_MONTHLY_API_REQUESTS = 100000; // 100,000 requests

/**
 * Format bytes into human-readable representation
 */
function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Checks if user's monthly cycle has expired and resets usage to 0 if so.
 * Returns the fresh user record.
 */
async function checkAndResetMonthlyCycle(userOrId) {
  let user = typeof userOrId === 'object' && userOrId !== null ? userOrId : null;
  if (!user) {
    user = await getRow(`SELECT * FROM users WHERE id = ?;`, [userOrId]);
  }
  if (!user) return null;

  const now = new Date();
  const resetAt = user.bandwidth_cycle_reset_at ? new Date(user.bandwidth_cycle_reset_at) : null;

  // If reset date is missing or in the past, perform automatic monthly reset
  if (!resetAt || isNaN(resetAt.getTime()) || resetAt <= now) {
    const nextReset = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await runQuery(
      `UPDATE users 
       SET used_bandwidth_bytes = 0, 
           used_api_requests = 0, 
           bandwidth_cycle_reset_at = ? 
       WHERE id = ?;`,
      [nextReset, user.id]
    );

    user.used_bandwidth_bytes = 0;
    user.used_api_requests = 0;
    user.bandwidth_cycle_reset_at = nextReset;
  }

  return user;
}

/**
 * Records 1 or more API requests for a user.
 * Throws a 429 error if a non-admin user exceeds the 100,000 monthly request limit.
 */
async function recordApiRequest(userId, count = 1) {
  if (!userId) return;
  const user = await checkAndResetMonthlyCycle(userId);
  if (!user) return;

  // Admin users are exempt from monthly API request limits
  if (user.role !== 'admin') {
    const limit = Number(user.monthly_api_requests_limit || DEFAULT_MONTHLY_API_REQUESTS);
    const currentUsed = Number(user.used_api_requests || 0);

    if (currentUsed + count > limit) {
      const resetDateStr = user.bandwidth_cycle_reset_at 
        ? new Date(user.bandwidth_cycle_reset_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'next billing cycle';
      
      const err = new Error(`Monthly API request limit exceeded (${limit.toLocaleString()} requests/month limit reached). Your limit will automatically reset on ${resetDateStr}.`);
      err.status = 429;
      err.code = 'MONTHLY_API_LIMIT_EXCEEDED';
      err.limit = limit;
      err.used = currentUsed;
      err.resetAt = user.bandwidth_cycle_reset_at;
      throw err;
    }
  }

  // Atomically increment request count
  await runQuery(
    `UPDATE users SET used_api_requests = used_api_requests + ? WHERE id = ?;`,
    [Math.max(1, Math.floor(count)), user.id]
  );
}

/**
 * Checks if user has enough bandwidth remaining for an incoming transfer.
 * Throws a 429 error if non-admin user exceeds the 15 GB monthly bandwidth limit.
 */
async function checkBandwidthQuota(userId, incomingBytes = 0) {
  if (!userId) return;
  const user = await checkAndResetMonthlyCycle(userId);
  if (!user) return;

  if (user.role !== 'admin') {
    const limitBytes = Number(user.monthly_bandwidth_limit_bytes || DEFAULT_MONTHLY_BANDWIDTH_BYTES);
    const usedBytes = Number(user.used_bandwidth_bytes || 0);

    if (usedBytes + incomingBytes > limitBytes) {
      const limitGb = (limitBytes / (1024 * 1024 * 1024)).toFixed(2);
      const resetDateStr = user.bandwidth_cycle_reset_at 
        ? new Date(user.bandwidth_cycle_reset_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'next billing cycle';

      const err = new Error(`Monthly bandwidth limit exceeded (${limitGb} GB/month limit reached). Your bandwidth will automatically reset on ${resetDateStr}.`);
      err.status = 429;
      err.code = 'MONTHLY_BANDWIDTH_LIMIT_EXCEEDED';
      err.limitBytes = limitBytes;
      err.usedBytes = usedBytes;
      err.resetAt = user.bandwidth_cycle_reset_at;
      throw err;
    }
  }

  return user;
}

/**
 * Records bandwidth bytes consumed (upload, download, or streaming).
 */
async function recordBandwidthUsage(userId, bytes) {
  if (!userId || !bytes || bytes <= 0) return;
  const numBytes = Math.floor(Number(bytes));
  if (isNaN(numBytes) || numBytes <= 0) return;

  await checkAndResetMonthlyCycle(userId);
  await runQuery(
    `UPDATE users SET used_bandwidth_bytes = used_bandwidth_bytes + ? WHERE id = ?;`,
    [numBytes, userId]
  );
}

/**
 * Manual reset by admin or testing
 */
async function resetUserMonthlyCycle(userId) {
  const nextReset = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await runQuery(
    `UPDATE users 
     SET used_bandwidth_bytes = 0, 
         used_api_requests = 0, 
         bandwidth_cycle_reset_at = ? 
     WHERE id = ?;`,
    [nextReset, userId]
  );
}

/**
 * Retrieves a comprehensive usage summary for user dashboard & widgets
 */
async function getUserUsageSummary(userId) {
  const user = await checkAndResetMonthlyCycle(userId);
  if (!user) return null;

  const storageQuotaBytes = Number(user.storage_quota_bytes || 10737418240);
  const usedStorageBytes = Number(user.used_storage_bytes || 0);

  const bandwidthLimitBytes = Number(user.monthly_bandwidth_limit_bytes || DEFAULT_MONTHLY_BANDWIDTH_BYTES);
  const usedBandwidthBytes = Number(user.used_bandwidth_bytes || 0);
  const remainingBandwidthBytes = Math.max(0, bandwidthLimitBytes - usedBandwidthBytes);

  const apiRequestsLimit = Number(user.monthly_api_requests_limit || DEFAULT_MONTHLY_API_REQUESTS);
  const usedApiRequests = Number(user.used_api_requests || 0);
  const remainingApiRequests = Math.max(0, apiRequestsLimit - usedApiRequests);

  const resetAt = user.bandwidth_cycle_reset_at ? new Date(user.bandwidth_cycle_reset_at) : new Date(Date.now() + 30 * 86400000);
  const daysUntilReset = Math.max(0, Math.ceil((resetAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));

  return {
    storage: {
      quotaBytes: storageQuotaBytes,
      usedBytes: usedStorageBytes,
      percentage: Math.min(100, parseFloat(((usedStorageBytes / Math.max(1, storageQuotaBytes)) * 100).toFixed(1))),
      formattedQuota: formatBytes(storageQuotaBytes),
      formattedUsed: formatBytes(usedStorageBytes)
    },
    bandwidth: {
      limitBytes: bandwidthLimitBytes,
      usedBytes: usedBandwidthBytes,
      remainingBytes: remainingBandwidthBytes,
      percentage: Math.min(100, parseFloat(((usedBandwidthBytes / Math.max(1, bandwidthLimitBytes)) * 100).toFixed(1))),
      formattedLimit: formatBytes(bandwidthLimitBytes),
      formattedUsed: formatBytes(usedBandwidthBytes),
      formattedRemaining: formatBytes(remainingBandwidthBytes),
      isLimitExceeded: user.role !== 'admin' && usedBandwidthBytes >= bandwidthLimitBytes
    },
    apiRequests: {
      limit: apiRequestsLimit,
      used: usedApiRequests,
      remaining: remainingApiRequests,
      percentage: Math.min(100, parseFloat(((usedApiRequests / Math.max(1, apiRequestsLimit)) * 100).toFixed(1))),
      formattedLimit: apiRequestsLimit.toLocaleString(),
      formattedUsed: usedApiRequests.toLocaleString(),
      formattedRemaining: remainingApiRequests.toLocaleString(),
      isLimitExceeded: user.role !== 'admin' && usedApiRequests >= apiRequestsLimit
    },
    cycle: {
      resetAt: resetAt.toISOString(),
      daysUntilReset,
      formattedResetDate: resetAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    }
  };
}

/**
 * Background recurring sweeper that runs every 30 minutes to auto-reset expired cycles
 */
function initUsageAutoResetJob() {
  setInterval(async () => {
    try {
      const nowIso = new Date().toISOString();
      const expiredUsers = await getAll(
        `SELECT id FROM users WHERE bandwidth_cycle_reset_at IS NOT NULL AND bandwidth_cycle_reset_at <= ?;`,
        [nowIso]
      );

      for (const u of expiredUsers) {
        await checkAndResetMonthlyCycle(u.id);
      }
    } catch (err) {
      console.error('Usage auto-reset job error:', err.message);
    }
  }, 30 * 60 * 1000); // Check every 30 minutes
}

module.exports = {
  DEFAULT_MONTHLY_BANDWIDTH_BYTES,
  DEFAULT_MONTHLY_API_REQUESTS,
  formatBytes,
  checkAndResetMonthlyCycle,
  recordApiRequest,
  checkBandwidthQuota,
  recordBandwidthUsage,
  resetUserMonthlyCycle,
  getUserUsageSummary,
  initUsageAutoResetJob
};
