require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const { initDatabase } = require('./src/database/db');
const authRoutes = require('./src/routes/authRoutes');
const fileRoutes = require('./src/routes/fileRoutes');
const shareRoutes = require('./src/routes/shareRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const publicRoutes = require('./src/routes/publicRoutes');
const apiKeyRoutes = require('./src/routes/apiKeyRoutes');
const blobRoutes = require('./src/routes/blobRoutes');
const s3Routes = require('./src/routes/s3Routes');
const setupConsoleWebSocket = require('./src/services/consoleService');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Always use port 3000 in development/AI Studio container. On VPS production deployment, APP_PORT or custom PORT is supported.
const PORT = process.env.APP_PORT || (process.env.PORT && process.env.PORT !== '8080' ? Number(process.env.PORT) : 3000);
const HOST = process.env.HOST || '0.0.0.0';

// Only trust forwarding headers from the configured reverse proxy. For the
// normal Nginx-on-the-same-VPS deployment, loopback is sufficient. Set
// TRUST_PROXY to an IP/CIDR understood by Express when the proxy is elsewhere.
const trustProxy = process.env.TRUST_PROXY || 'loopback';
app.set('trust proxy', trustProxy);

// Security & Parsing Middleware
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-blob-token', 'x-amz-date', 'x-amz-content-sha256', 'x-amz-security-token', 'range', 'origin', 'accept', 'x-add-random-suffix']
}));

// Selective JSON & URL-encoded parsing so that binary and raw uploads on S3 and Blob endpoints keep their streams intact
app.use((req, res, next) => {
  const isRawStreamUpload =
    (req.path.startsWith('/api/v1/blob') && req.method === 'PUT') ||
    (req.path.startsWith('/api/s3') && req.method === 'PUT') ||
    (req.path.startsWith('/api/files/upload') && req.method === 'POST') ||
    (req.path.startsWith('/api/v1/blob/upload') && req.method === 'POST');

  if (isRawStreamUpload) {
    return next();
  }
  express.json({ limit: '500mb' })(req, res, next);
});

app.use((req, res, next) => {
  const isRawStreamUpload =
    (req.path.startsWith('/api/v1/blob') && req.method === 'PUT') ||
    (req.path.startsWith('/api/s3') && req.method === 'PUT') ||
    (req.path.startsWith('/api/files/upload') && req.method === 'POST') ||
    (req.path.startsWith('/api/v1/blob/upload') && req.method === 'POST');

  if (isRawStreamUpload) {
    return next();
  }
  express.urlencoded({ extended: true, limit: '500mb' })(req, res, next);
});

// Easy VPS Installer Script Route (direct curl access: curl -fsSL http://vps/install.sh | bash)
app.get(['/install.sh', '/api/public/install.sh'], (req, res) => {
  res.setHeader('Content-Type', 'text/x-shellscript');
  const scriptPath = path.join(__dirname, 'install.sh');
  try {
    let script = fs.readFileSync(scriptPath, 'utf8');
    const proto = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const origin = `${proto}://${req.get('host')}`;
    script = script.replace(/__APP_SOURCE_URL__/g, origin);
    res.send(script);
  } catch (err) {
    res.status(500).send('Error loading install script: ' + err.message);
  }
});

// Full Application Bundle archive endpoint for headless VPS curl installations
app.get('/api/public/bundle.tar.gz', (req, res) => {
  const { exec } = require('child_process');
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', 'attachment; filename="app-bundle.tar.gz"');
  const tar = exec('tar --exclude="node_modules" --exclude=".git" --exclude="*.sqlite*" --exclude="storage" --exclude="*.log" -czf - .');
  tar.stdout.pipe(res);
  tar.on('error', (err) => {
    if (!res.headersSent) res.status(500).send('Failed to package application bundle: ' + err.message);
  });
});

// Static files (Frontend build output)
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/public', publicRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/keys', apiKeyRoutes);
app.use('/api/v1/blob', blobRoutes);
app.use('/api/s3', s3Routes);

// Health check API
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Handle WebSocket upgrade for Admin VPS Console
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  if (pathname === '/api/admin/console') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Attach WebSocket console handler
setupConsoleWebSocket(wss);

// Fallback route to serve SPA frontend
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  next();
});

// Start server after DB initialization
initDatabase()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`===================================================`);
      console.log(`  VPS SFTP Cloud & S3 Cluster running on ${HOST}:${PORT}`);
      console.log(`  App URL: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
      console.log(`===================================================`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
  });
