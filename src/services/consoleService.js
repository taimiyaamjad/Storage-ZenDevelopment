const { spawn } = require('child_process');
const fs = require('fs');
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

      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await getRow(`SELECT id, role, is_suspended FROM users WHERE id = ?;`, [decoded.userId]);

      if (!user || user.role !== 'admin' || user.is_suspended) {
        if (ws.readyState === 1) ws.send('\r\n\x1b[31mAccess Denied: Administrator privileges required.\x1b[0m\r\n');
        return ws.close();
      }

      if (ws.readyState === 1) {
        ws.send('\r\n\x1b[32m=== VPS SSH Console Session Established ===\x1b[0m\r\n');
        ws.send(`\x1b[90mConnected to ${process.platform} host at ${new Date().toLocaleTimeString()}\x1b[0m\r\n\r\n`);
      }

      // Spawn real interactive bash/sh shell
      const shellCmd = process.platform === 'win32' ? 'cmd.exe' : (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
      const shellArgs = process.platform === 'win32' ? [] : ['-i'];
      
      const shell = spawn(shellCmd, shellArgs, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor'
        }
      });

      shell.stdout.on('data', (data) => {
        try {
          if (ws.readyState === 1) ws.send(data.toString());
        } catch (e) {}
      });

      shell.stderr.on('data', (data) => {
        try {
          if (ws.readyState === 1) ws.send(data.toString());
        } catch (e) {}
      });

      shell.on('error', (err) => {
        try {
          if (ws.readyState === 1) ws.send(`\r\n\x1b[31mShell spawn error: ${err.message}\x1b[0m\r\n`);
        } catch (e) {}
      });

      ws.on('message', (msg) => {
        try {
          const str = msg.toString();
          // Check for PTY resize event frame
          if (str.startsWith('{') && str.endsWith('}')) {
            try {
              const parsed = JSON.parse(str);
              if (parsed.type === 'resize') return;
            } catch (e) {}
          }
          shell.stdin.write(msg);
        } catch (e) {
          try {
            shell.stdin.write(msg);
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
          shell.kill();
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
