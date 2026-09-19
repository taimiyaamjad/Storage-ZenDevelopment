const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { getRow } = require('../database/db');

function setupConsoleWebSocket(wss) {
  wss.on('connection', async (ws, req) => {
    try {
      // Parse query token from WS URL: ws://host/api/admin/console?token=XYZ
      const url = new URL(req.url, 'http://storage.zendevelopment.in');
      const token = url.searchParams.get('token');

      if (!token) {
        ws.send('\r\n\x1b[31mAuthentication Error: Missing security token.\x1b[0m\r\n');
        return ws.close();
      }

      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await getRow(`SELECT id, role, is_suspended FROM users WHERE id = ?;`, [decoded.userId]);

      if (!user || user.role !== 'admin' || user.is_suspended) {
        ws.send('\r\n\x1b[31mAccess Denied: Administrator privileges required.\x1b[0m\r\n');
        return ws.close();
      }

      ws.send('\r\n\x1b[32m=== VPS SSH Console Session Established ===\x1b[0m\r\n\r\n');

      // Spawn real interactive bash shell PTY stream
      const shell = spawn('/bin/bash', ['-i'], {
        name: 'xterm-color',
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
        env: process.env
      });

      shell.stdout.on('data', (data) => {
        try {
          ws.send(data.toString());
        } catch (e) {}
      });

      shell.stderr.on('data', (data) => {
        try {
          ws.send(data.toString());
        } catch (e) {}
      });

      ws.on('message', (msg) => {
        try {
          const str = msg.toString();
          // Check for PTY resize event frame
          if (str.startsWith('{') && str.endsWith('}')) {
            const parsed = JSON.parse(str);
            if (parsed.type === 'resize') return;
          }
          shell.stdin.write(msg);
        } catch (e) {
          shell.stdin.write(msg);
        }
      });

      shell.on('exit', () => {
        ws.send('\r\n\x1b[33mConsole session ended.\x1b[0m\r\n');
        ws.close();
      });

      ws.on('close', () => {
        shell.kill();
      });
    } catch (err) {
      ws.send(`\r\n\x1b[31mConsole Error: ${err.message}\x1b[0m\r\n`);
      ws.close();
    }
  });
}

module.exports = setupConsoleWebSocket;
