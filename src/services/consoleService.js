const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../middleware/auth');
const { getRow } = require('../database/db');

// In-memory active HTTP terminal sessions
const httpConsoleSessions = new Map();

// Periodic cleanup of stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of httpConsoleSessions.entries()) {
    if (now - session.lastActivity > 30 * 60 * 1000) {
      try {
        if (session.shell) session.shell.kill('SIGTERM');
      } catch (_) {}
      httpConsoleSessions.delete(id);
    }
  }
}, 60000);

function spawnShellProcess() {
  const ptyBridgePath = path.join(__dirname, 'ptyBridge.py');
  const baseEnv = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8'
  };

  if (process.platform !== 'win32' && fs.existsSync(ptyBridgePath)) {
    try {
      fs.chmodSync(ptyBridgePath, 0o755);
    } catch (_) {}
    return spawn('python3', ['-u', ptyBridgePath], {
      cwd: process.env.HOME || process.cwd(),
      env: baseEnv
    });
  } else {
    const shellCmd = process.platform === 'win32' ? 'cmd.exe' : (fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh');
    const shellArgs = process.platform === 'win32' ? [] : ['-i'];
    return spawn(shellCmd, shellArgs, {
      cwd: process.env.HOME || process.cwd(),
      env: baseEnv
    });
  }
}

async function verifyAdminAuthToken(token) {
  if (!token) throw new Error('Missing security token.');
  const decoded = jwt.verify(token, JWT_SECRET);
  const user = await getRow(`SELECT id, role, is_suspended FROM users WHERE id = ?;`, [decoded.userId]);
  if (!user || user.role !== 'admin' || user.is_suspended) {
    throw new Error('Administrator privileges required.');
  }
  return user;
}

function setupConsoleWebSocket(wss) {
  wss.on('connection', async (ws, req) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const token = url.searchParams.get('token') ||
                    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
                    req.headers['sec-websocket-protocol'];

      try {
        await verifyAdminAuthToken(token);
      } catch (authErr) {
        if (ws.readyState === 1) {
          ws.send(`\r\n\x1b[31mAuthentication Error: ${authErr.message}\x1b[0m\r\n`);
        }
        return ws.close();
      }

      const shell = spawnShellProcess();

      shell.stdout.on('data', (data) => {
        try {
          if (ws.readyState === 1) ws.send(data);
        } catch (_) {}
      });

      shell.stderr.on('data', (data) => {
        try {
          if (ws.readyState === 1) ws.send(data);
        } catch (_) {}
      });

      shell.on('error', (err) => {
        try {
          if (ws.readyState === 1) ws.send(`\r\n\x1b[31mShell error: ${err.message}\x1b[0m\r\n`);
        } catch (_) {}
      });

      ws.on('message', (msg) => {
        try {
          const str = typeof msg === 'string' ? msg : msg.toString('utf8');
          if (str.startsWith('{') && str.includes('"type"') && str.includes('"resize"')) {
            try {
              const parsed = JSON.parse(str);
              if (parsed.type === 'resize' && shell && shell.stdin && !shell.stdin.destroyed) {
                shell.stdin.write(JSON.stringify(parsed) + '\n');
                return;
              }
            } catch (_) {}
          }

          if (shell && shell.stdin && !shell.stdin.destroyed) {
            shell.stdin.write(msg);
          }
        } catch (_) {}
      });

      shell.on('exit', (code) => {
        try {
          if (ws.readyState === 1) {
            ws.send(`\r\n\x1b[33mConsole session ended (exit code: ${code}).\x1b[0m\r\n`);
            ws.close();
          }
        } catch (_) {}
      });

      ws.on('close', () => {
        try {
          if (shell) shell.kill('SIGTERM');
        } catch (_) {}
      });

    } catch (err) {
      try {
        if (ws.readyState === 1) {
          ws.send(`\r\n\x1b[31mConsole Error: ${err.message}\x1b[0m\r\n`);
          ws.close();
        }
      } catch (_) {}
    }
  });
}

/**
 * Express HTTP Live Terminal Streaming Endpoints (Fallback when WebSockets are blocked by proxies)
 */
async function handleHttpConsoleStream(req, res) {
  try {
    const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    await verifyAdminAuthToken(token);

    const sessionId = crypto.randomBytes(16).toString('hex');
    const shell = spawnShellProcess();

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Console-Session-Id': sessionId,
      'Access-Control-Expose-Headers': 'X-Console-Session-Id'
    });

    const sessionData = {
      id: sessionId,
      shell,
      res,
      lastActivity: Date.now()
    };
    httpConsoleSessions.set(sessionId, sessionData);

    // Initial session handshake header
    res.write(`\x1b[?25h[SESSION_ID:${sessionId}]\r\n`);

    shell.stdout.on('data', (chunk) => {
      sessionData.lastActivity = Date.now();
      try {
        if (!res.writableEnded) res.write(chunk);
      } catch (_) {}
    });

    shell.stderr.on('data', (chunk) => {
      sessionData.lastActivity = Date.now();
      try {
        if (!res.writableEnded) res.write(chunk);
      } catch (_) {}
    });

    shell.on('exit', (code) => {
      try {
        if (!res.writableEnded) {
          res.write(`\r\n\x1b[33mConsole session ended (exit code: ${code}).\x1b[0m\r\n`);
          res.end();
        }
      } catch (_) {}
      httpConsoleSessions.delete(sessionId);
    });

    req.on('close', () => {
      setTimeout(() => {
        const s = httpConsoleSessions.get(sessionId);
        if (s && Date.now() - s.lastActivity > 60000) {
          try { s.shell.kill('SIGTERM'); } catch (_) {}
          httpConsoleSessions.delete(sessionId);
        }
      }, 5000);
    });

  } catch (err) {
    if (!res.headersSent) {
      return res.status(403).json({ error: err.message });
    }
  }
}

async function handleHttpConsoleInput(req, res) {
  try {
    const { sessionId, data, token: bodyToken } = req.body || {};
    const token = req.query.token || bodyToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    await verifyAdminAuthToken(token);

    if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });
    const session = httpConsoleSessions.get(sessionId);
    if (!session || !session.shell || session.shell.stdin.destroyed) {
      return res.status(404).json({ error: 'Active console session not found.' });
    }

    session.lastActivity = Date.now();
    if (typeof data === 'string') {
      session.shell.stdin.write(data);
    }

    return res.json({ success: true });
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
}

async function handleHttpConsoleResize(req, res) {
  try {
    const { sessionId, cols, rows, token: bodyToken } = req.body || {};
    const token = req.query.token || bodyToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    await verifyAdminAuthToken(token);

    if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });
    const session = httpConsoleSessions.get(sessionId);
    if (!session || !session.shell || session.shell.stdin.destroyed) {
      return res.status(404).json({ error: 'Active console session not found.' });
    }

    session.lastActivity = Date.now();
    if (cols && rows) {
      session.shell.stdin.write(JSON.stringify({ type: 'resize', cols, rows }) + '\n');
    }

    return res.json({ success: true });
  } catch (err) {
    return res.status(403).json({ error: err.message });
  }
}

async function handleHttpConsoleClose(req, res) {
  try {
    const { sessionId, token: bodyToken } = req.body || {};
    const token = req.query.token || bodyToken || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    await verifyAdminAuthToken(token);

    if (sessionId && httpConsoleSessions.has(sessionId)) {
      const session = httpConsoleSessions.get(sessionId);
      try {
        if (session.shell) session.shell.kill('SIGTERM');
        if (session.res && !session.res.writableEnded) session.res.end();
      } catch (_) {}
      httpConsoleSessions.delete(sessionId);
    }
    return res.json({ success: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}

module.exports = {
  setupConsoleWebSocket,
  handleHttpConsoleStream,
  handleHttpConsoleInput,
  handleHttpConsoleResize,
  handleHttpConsoleClose
};
