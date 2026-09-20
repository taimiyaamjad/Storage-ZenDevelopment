const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { getRow } = require('../database/db');

function setupConsoleWebSocket(wss) {
  wss.on('connection', async (ws, req) => {
    try {
      // Parse query token from WS URL: ws://host/api/admin/console?token=XYZ
      const host = req.headers.host || 'localhost';
      const url = new URL(req.url, `http://${host}`);
      const token = url.searchParams.get('token');

      if (!token) {
        if (ws.readyState === 1) ws.send('\r\n\x1b[31mAuthentication Error: Missing security token.\x1b[0m\r\n');
        return ws.close();
      }

      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        if (ws.readyState === 1) ws.send('\r\n\x1b[31mAuthentication Error: Invalid or expired token.\x1b[0m\r\n');
        return ws.close();
      }

      const user = await getRow(`SELECT id, role, is_suspended FROM users WHERE id = ?;`, [decoded.userId]);

      if (!user || user.role !== 'admin' || user.is_suspended) {
        if (ws.readyState === 1) ws.send('\r\n\x1b[31mAccess Denied: Administrator privileges required.\x1b[0m\r\n');
        return ws.close();
      }

      // Check if Python3 PTY bridge exists
      const ptyBridgePath = path.join(__dirname, 'ptyBridge.py');
      let shell;

      const baseEnv = {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8'
      };

      if (process.platform !== 'win32' && fs.existsSync(ptyBridgePath)) {
        // Use Python PTY bridge for full interactive TTY features (colors, tab completion, htop, vi, bash readline)
        shell = spawn('python3', ['-u', ptyBridgePath], {
          cwd: process.env.HOME || process.cwd(),
          env: baseEnv
        });
      } else {
        // Fallback for Windows or environments without python3
        const shellCmd = process.platform === 'win32' ? 'cmd.exe' : (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
        const shellArgs = process.platform === 'win32' ? [] : ['-i'];
        shell = spawn(shellCmd, shellArgs, {
          cwd: process.env.HOME || process.cwd(),
          env: baseEnv
        });
      }

      shell.stdout.on('data', (data) => {
        try {
          if (ws.readyState === 1) ws.send(data);
        } catch (e) {}
      });

      shell.stderr.on('data', (data) => {
        try {
          if (ws.readyState === 1) ws.send(data);
        } catch (e) {}
      });

      shell.on('error', (err) => {
        try {
          if (ws.readyState === 1) ws.send(`\r\n\x1b[31mShell error: ${err.message}\x1b[0m\r\n`);
        } catch (e) {}
      });

      ws.on('message', (msg) => {
        try {
          const str = typeof msg === 'string' ? msg : msg.toString('utf8');
          // Handle resize event frames: {"type":"resize","cols":120,"rows":30}
          if (str.startsWith('{') && str.includes('"type"') && str.includes('"resize"')) {
            try {
              const parsed = JSON.parse(str);
              if (parsed.type === 'resize') {
                if (shell && shell.stdin && !shell.stdin.destroyed) {
                  shell.stdin.write(JSON.stringify(parsed) + '\n');
                }
                return;
              }
            } catch (e) {}
          }

          if (shell && shell.stdin && !shell.stdin.destroyed) {
            shell.stdin.write(msg);
          }
        } catch (e) {
          try {
            if (shell && shell.stdin && !shell.stdin.destroyed) {
              shell.stdin.write(msg);
            }
          } catch (err) {}
        }
      });

      shell.on('exit', (code) => {
        try {
          if (ws.readyState === 1) {
            ws.send(`\r\n\x1b[33mConsole session ended (exit code: ${code}).\x1b[0m\r\n`);
            ws.close();
          }
        } catch (e) {}
      });

      ws.on('close', () => {
        try {
          if (shell) shell.kill('SIGTERM');
        } catch (e) {}
      });

    } catch (err) {
      try {
        if (ws.readyState === 1) {
          ws.send(`\r\n\x1b[31mConsole Error: ${err.message}\x1b[0m\r\n`);
          ws.close();
        }
      } catch (e) {}
    }
  });
}

module.exports = setupConsoleWebSocket;
