const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const SFTPService = require('./sftpService');

class ArchiveService {
  /**
   * Compress selected files/folders into zip, tar, tar.gz, or 7z archive
   */
  static compress(userId, filePaths, archiveName, format = 'zip') {
    return new Promise((resolve, reject) => {
      const { userDir } = SFTPService.resolveUserPath(userId, '/');
      const { absolutePath: archiveAbsPath } = SFTPService.resolveUserPath(userId, archiveName);

      // Verify format
      const validFormats = ['zip', 'tar', 'tar.gz', 'gzip', '7z'];
      if (!validFormats.includes(format.toLowerCase())) {
        return reject(new Error(`Unsupported archive format: ${format}`));
      }

      // Convert paths relative to userDir
      const relativeItems = filePaths.map(p => {
        const resolved = SFTPService.resolveUserPath(userId, p);
        return path.relative(userDir, resolved.absolutePath);
      });

      let command = '';

      if (format === 'zip') {
        command = `zip -r "${archiveAbsPath}" ${relativeItems.map(i => `"${i}"`).join(' ')}`;
      } else if (format === 'tar') {
        command = `tar -cvf "${archiveAbsPath}" ${relativeItems.map(i => `"${i}"`).join(' ')}`;
      } else if (format === 'tar.gz') {
        command = `tar -czvf "${archiveAbsPath}" ${relativeItems.map(i => `"${i}"`).join(' ')}`;
      } else if (format === '7z') {
        command = `7z a "${archiveAbsPath}" ${relativeItems.map(i => `"${i}"`).join(' ')}`;
      } else if (format === 'gzip') {
        // Gzip single file
        command = `gzip -c "${path.join(userDir, relativeItems[0])}" > "${archiveAbsPath}"`;
      }

      exec(command, { cwd: userDir }, (err, stdout, stderr) => {
        if (err) {
          return reject(err);
        }
        resolve({ archivePath: archiveAbsPath, stdout });
      });
    });
  }

  /**
   * Extract archive into current or designated directory
   */
  static extract(userId, archivePath, targetDir = '/') {
    return new Promise((resolve, reject) => {
      const { absolutePath: archiveAbs } = SFTPService.resolveUserPath(userId, archivePath);
      const { absolutePath: targetAbs } = SFTPService.resolveUserPath(userId, targetDir);

      if (!fs.existsSync(archiveAbs)) {
        return reject(new Error('Archive file does not exist'));
      }

      if (!fs.existsSync(targetAbs)) {
        fs.mkdirSync(targetAbs, { recursive: true });
      }

      const ext = archivePath.toLowerCase();
      let command = '';

      if (ext.endsWith('.zip')) {
        command = `unzip -o "${archiveAbs}" -d "${targetAbs}"`;
      } else if (ext.endsWith('.tar.gz') || ext.endsWith('.tgz')) {
        command = `tar -xzvf "${archiveAbs}" -C "${targetAbs}"`;
      } else if (ext.endsWith('.tar')) {
        command = `tar -xvf "${archiveAbs}" -C "${targetAbs}"`;
      } else if (ext.endsWith('.7z')) {
        command = `7z x "${archiveAbs}" -o"${targetAbs}" -y`;
      } else if (ext.endsWith('.gz')) {
        const outName = path.basename(archiveAbs, '.gz');
        command = `gunzip -c "${archiveAbs}" > "${path.join(targetAbs, outName)}"`;
      } else {
        return reject(new Error('Unsupported archive extension for extraction. Supported: .zip, .tar, .tar.gz, .tgz, .7z, .gz'));
      }

      exec(command, (err, stdout, stderr) => {
        if (err) {
          return reject(err);
        }
        resolve({ stdout });
      });
    });
  }
}

module.exports = ArchiveService;
