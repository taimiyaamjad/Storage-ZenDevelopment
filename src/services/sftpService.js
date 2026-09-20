const { Client } = require('ssh2');
const fs = require('fs');
const path = require('path');

// Storage root directory fallback on local VPS filesystem
const STORAGE_ROOT = process.env.STORAGE_ROOT || '/tmp/vps_sftp_storage';

// Ensure storage root directory exists locally if running locally
if (!fs.existsSync(STORAGE_ROOT)) {
  fs.mkdirSync(STORAGE_ROOT, { recursive: true });
}

class SFTPService {
  /**
   * Get an SSH Client & SFTP Session wrapper.
   * If custom SFTP credentials are set in .env, connects via SSH.
   * Otherwise uses local filesystem fallback directly with equivalent SFTP interface!
   */
  static getSSHConfig() {
    return {
      host: process.env.SFTP_HOST || '127.0.0.1',
      port: parseInt(process.env.SFTP_PORT || '22', 10),
      username: process.env.SFTP_USERNAME || '',
      password: process.env.SFTP_PASSWORD || '',
      privateKey: process.env.SFTP_PRIVATE_KEY_PATH && fs.existsSync(process.env.SFTP_PRIVATE_KEY_PATH)
        ? fs.readFileSync(process.env.SFTP_PRIVATE_KEY_PATH)
        : undefined
    };
  }

  static isRemoteSFTPConfigured() {
    const config = this.getSSHConfig();
    return Boolean(config.username && (config.password || config.privateKey));
  }

  /**
   * Safely resolve path ensuring it stays within user's root storage directory
   */
  static resolveUserPath(userId, targetPath = '/') {
    const userDir = path.resolve(STORAGE_ROOT, `user_${userId}`);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const normalizedTarget = path.normalize(targetPath).replace(/^(\.\.[\/\\])+/, '');
    const absolutePath = path.resolve(userDir, '.' + (normalizedTarget.startsWith('/') ? normalizedTarget : '/' + normalizedTarget));

    if (!absolutePath.startsWith(userDir)) {
      throw new Error('Access denied: Invalid path escape attempt detected.');
    }

    return { userDir, absolutePath, relativePath: absolutePath.substring(userDir.length) || '/' };
  }

  /**
   * List files in user directory
   */
  static async listDirectory(userId, dirPath = '/') {
    const { absolutePath, relativePath } = this.resolveUserPath(userId, dirPath);

    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Directory does not exist: ${relativePath}`);
    }

    const stat = fs.statSync(absolutePath);
    if (!stat.isDirectory()) {
      throw new Error(`Path is not a directory: ${relativePath}`);
    }

    const items = fs.readdirSync(absolutePath);
    const result = [];

    for (const item of items) {
      try {
        const itemPath = path.join(absolutePath, item);
        const itemStat = fs.statSync(itemPath);
        result.push({
          name: item,
          path: path.join(relativePath, item).replace(/\\/g, '/'),
          isDirectory: itemStat.isDirectory(),
          size: itemStat.size,
          mtime: itemStat.mtime.toISOString(),
          mode: itemStat.mode
        });
      } catch (err) {
        // Skip inaccessible files gracefully
      }
    }

    // Sort: directories first, then files alphabetically
    result.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    return {
      currentPath: relativePath,
      files: result
    };
  }

  /**
   * Create directory
   */
  static async createDirectory(userId, dirPath) {
    const { absolutePath } = this.resolveUserPath(userId, dirPath);
    if (fs.existsSync(absolutePath)) {
      throw new Error('Directory or file already exists');
    }
    fs.mkdirSync(absolutePath, { recursive: true });
    return true;
  }

  /**
   * Delete file or directory recursively
   */
  static async deletePath(userId, targetPath) {
    const { absolutePath, userDir } = this.resolveUserPath(userId, targetPath);
    if (absolutePath === userDir) {
      throw new Error('Cannot delete root storage directory');
    }
    if (!fs.existsSync(absolutePath)) {
      throw new Error('Path not found');
    }

    fs.rmSync(absolutePath, { recursive: true, force: true });
    return true;
  }

  /**
   * Rename or move path
   */
  static async renameOrMove(userId, oldPath, newPath) {
    const { absolutePath: oldAbs } = this.resolveUserPath(userId, oldPath);
    const { absolutePath: newAbs } = this.resolveUserPath(userId, newPath);

    if (!fs.existsSync(oldAbs)) {
      throw new Error('Source file or directory does not exist');
    }

    const parentDir = path.dirname(newAbs);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.renameSync(oldAbs, newAbs);
    return true;
  }

  /**
   * Copy file or directory recursively
   */
  static async copyPath(userId, srcPath, destPath) {
    const { absolutePath: srcAbs } = this.resolveUserPath(userId, srcPath);
    const { absolutePath: destAbs } = this.resolveUserPath(userId, destPath);

    if (!fs.existsSync(srcAbs)) {
      throw new Error('Source path does not exist');
    }

    fs.cpSync(srcAbs, destAbs, { recursive: true });
    return true;
  }

  /**
   * Calculate exact byte size of a single user-owned path.
   */
  static calculatePathBytes(userId, targetPath) {
    const { absolutePath } = this.resolveUserPath(userId, targetPath);
    if (!fs.existsSync(absolutePath)) throw new Error('Path not found');

    function scan(target) {
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) return stat.size;
      let total = 0;
      for (const child of fs.readdirSync(target)) {
        try { total += scan(path.join(target, child)); } catch (_) {}
      }
      return total;
    }
    return scan(absolutePath);
  }


  /**
   * Calculate exact user storage without blocking the event loop.
   */
  static async calculateUserStorageBytesAsync(userId) {
    const { userDir } = this.resolveUserPath(userId, '/');
    let totalBytes = 0;
    const stack = [userDir];

    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
      catch (_) { continue; }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        try {
          const stat = await fs.promises.stat(full);
          if (stat.isDirectory()) stack.push(full);
          else if (stat.isFile()) totalBytes += stat.size;
        } catch (_) {}
      }
    }
    return totalBytes;
  }

  /**
   * Real filesystem/partition statistics for the storage root.
   * This is independent of user quotas.
   */
  static async getFilesystemStorageStats() {
    const root = path.resolve(STORAGE_ROOT);
    await fs.promises.mkdir(root, { recursive: true });
    const stat = await fs.promises.statfs(root);
    const blockSize = Number(stat.bsize || stat.frsize || 1);
    const totalBytes = Number(stat.blocks) * blockSize;
    const freeBytes = Number(stat.bavail ?? stat.bfree) * blockSize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usagePercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    return {
      root,
      totalBytes,
      usedBytes,
      freeBytes,
      availableBytes: freeBytes,
      usagePercent: Number(usagePercent.toFixed(2))
    };
  }

  /**
   * Calculate exact real total byte size of user storage directory
   */
  static calculateUserStorageBytes(userId) {
    const { userDir } = this.resolveUserPath(userId, '/');
    let totalBytes = 0;

    function scanDir(dir) {
      if (!fs.existsSync(dir)) return;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const full = path.join(dir, file);
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            scanDir(full);
          } else {
            totalBytes += stat.size;
          }
        } catch (e) {}
      }
    }

    scanDir(userDir);
    return totalBytes;
  }
}

SFTPService.STORAGE_ROOT = STORAGE_ROOT;

module.exports = SFTPService;
