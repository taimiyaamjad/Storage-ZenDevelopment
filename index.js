require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const { initDatabase } = require('./src/database/db');
const authRoutes = require('./src/routes/authRoutes');
const fileRoutes = require('./src/routes/fileRoutes');
const shareRoutes = require('./src/routes/shareRoutes');
const adminRoutes = require('./src/routes/adminRoutes');
const publicRoutes = require('./src/routes/publicRoutes');
const setupConsoleWebSocket = require('./src/services/consoleService');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = process.env.PORT || 5000;

// Only trust forwarding headers from the configured reverse proxy. For the
// normal Nginx-on-the-same-VPS deployment, loopback is sufficient. Set
// TRUST_PROXY to an IP/CIDR understood by Express when the proxy is elsewhere.
const trustProxy = process.env.TRUST_PROXY || 'loopback';
app.set('trust proxy', trustProxy);

// Security & Parsing Middleware
app.use(cors());
app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));

// Static files (Frontend build output)
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/public', publicRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/share', shareRoutes);
app.use('/api/admin', adminRoutes);

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
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`===================================================`);
      console.log(`  VPS SFTP File Manager is running on port ${PORT}`);
      console.log(`  App URL: http://127.0.0.1:${PORT}`);
      console.log(`===================================================`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
  });
