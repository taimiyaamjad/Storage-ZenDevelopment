# Production Deployment Guide: Modern SFTP-Based VPS File Manager

This application is a production-ready, full-stack VPS file management web application built with Node.js, Express, SQLite, SSH2/SFTP, and a modern Tailwind CSS + Vanilla JS Single Page Application (SPA).

---

## Technical Architecture & Design

1. **SFTP / SSH Engine**: Communicates with the VPS filesystem strictly via SFTP streams and remote commands (`ssh2` / `node-pty`). No unsafe direct web server root binding.
2. **Path Traversal Protection**: Every file request is resolved using canonical path resolution (`path.resolve`) within `/var/vps_storage/user_<id>/` (or `.env` defined `STORAGE_ROOT`). Escapes like `../../etc/passwd` trigger an immediate HTTP 400 Access Denied.
3. **Storage Quota Enforcement**: Enforces assigned storage limits (Default: 10 GB per user). Upload streams monitor incoming bytes and reject transfers exceeding quota.
4. **Anti Multi-Account & IP Tracking**: Stores IPv4 and IPv6 addresses on registration and login in `ip_history`. Admin configurable flag detects duplicate registrations on shared or historical IPs.
5. **Admin VPS PTY Console**: Features a real WebSocket-based SSH terminal (`@xterm/xterm` + `ws` + PTY) allowing system administrators to execute live shell commands directly on the server.
6. **Shareable Links**: Users can generate public share links with customizable expiration (1h, 24h, 7d, custom date). Enforces a default limit of 3 active share links per user (admin-configurable).

---

## Step 1: VPS Prerequisites & Dependencies

On your Ubuntu / Debian Linux VPS:

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Node.js v20+ or v22 LTS & Build tools
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3 nginx git zip unzip tar p7zip-full ffmpeg wget
```

---

## Step 2: Clone & Installation

```bash
# Create application directory
sudo mkdir -p /var/www/vps-sftp-filemanager
sudo chown -R $USER:$USER /var/www/vps-sftp-filemanager

# Copy code into directory
cd /var/www/vps-sftp-filemanager

# Install npm dependencies
npm install

# Rebuild native SQLite module if needed
npm rebuild sqlite3
```

---

## Step 3: Environment Configuration

Create a `.env` file in the root directory:

```env
PORT=5000
JWT_SECRET=generate-a-secure-random-64-character-hex-string
SESSION_SECRET=generate-another-secure-random-string
DB_FILE=data.sqlite

# VPS Storage Base Directory
STORAGE_ROOT=/var/vps_storage

# Optional SFTP Settings (Leave empty for default local VPS SFTP storage)
SFTP_HOST=127.0.0.1
SFTP_PORT=22
SFTP_USERNAME=
SFTP_PASSWORD=
SFTP_PRIVATE_KEY_PATH=

# Application Settings
APP_NAME=VPS Cloud Manager
APP_URL=https://yourvpsdomain.com
DEFAULT_STORAGE_QUOTA_BYTES=10737418240
MAX_SHARE_LINKS_PER_USER=3
ANTI_MULTI_ACCOUNT_ENABLED=true

# Browser-friendly video preview
PREVIEW_CACHE_ROOT=/tmp/vps-sftp-preview-cache
PREVIEW_MAX_TRANSCODES=2
PREVIEW_FFMPEG_PRESET=veryfast
PREVIEW_FFMPEG_CRF=23
```

Ensure the storage directory exists and has permissions:

```bash
sudo mkdir -p /var/vps_storage
sudo chown -R $USER:$USER /var/vps_storage
```

---

## Step 4: Systemd Service Setup

Create a systemd unit file to keep the application running automatically:

```bash
sudo nano /etc/systemd/system/vps-filemanager.service
```

Paste the following configuration:

```ini
[Unit]
Description=VPS SFTP File Manager Node.js Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/var/www/vps-sftp-filemanager
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable vps-filemanager
sudo systemctl start vps-filemanager
sudo systemctl status vps-filemanager
```

---

## Step 5: Nginx Reverse Proxy & WebSocket Configuration

Create an Nginx server block for domain or IP access with WebSocket terminal support:

```bash
sudo nano /etc/nginx/sites-available/vps-filemanager
```

Configuration:

```nginx
server {
    listen 80;
    server_name yourvpsdomain.com; # Replace with your VPS domain or IP

    client_max_body_size 0; # Unlimited upload file size support

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # Media/video preview: do not buffer large files in nginx and preserve
        # HTTP Range requests used by browser video playback and seeking.
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_force_ranges on;

        # Real Client IP Forwarding for IPv4 / IPv6 Tracking
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable Nginx site & reload:

```bash
sudo ln -s /etc/nginx/sites-available/vps-filemanager /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## Step 6: SSL / HTTPS Setup with Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourvpsdomain.com
```

---

## Step 7: Initial Login & Admin Setup

1. Open your browser and navigate to `https://yourvpsdomain.com` (or `http://localhost:5000`).
2. Log in with the default Administrator credentials:
   - **Username**: `admin`
   - **Password**: `Admin@123456`
3. **IMPORTANT**: Immediately navigate to the **Profile** section or **System Admin** portal to update your password and configure SMTP mail credentials!

---

## Step 8: Database Backups

To back up your application database and user storage:

```bash
# SQLite Database Backup
sqlite3 /var/www/vps-sftp-filemanager/data.sqlite ".backup '/var/backups/data_$(date +%F).sqlite'"

# User Storage Directory Backup
tar -czvf /var/backups/user_storage_$(date +%F).tar.gz /var/vps_storage
```

## Latest fixes
- Public share hash links now render a share page and provide a download action.
- File manager refresh spins for 1 second only and enforces the 10 second cooldown.
- Storage writes are quota-checked for uploads/copy/compression/extraction, with over-quota warning metadata.
- Admin overview and user management surface over-used storage in red.
- SMTP Config includes From Email and From Name; From Email defaults to the authenticated SMTP username.


## Recent fixes: URL downloads and video previews
- Wget no longer receives the unsupported `--max-filesize` option. Storage quota is enforced by monitoring the temporary download file and stopping wget if it grows beyond the user's remaining quota.
- URL download progress is based on the actual temporary file size and server-reported Content-Length when available, so percentage never moves backward. The UI also shows downloaded bytes, speed and ETA.
- Browser video previews use direct range streaming for browser-safe H.264/AAC MP4 files. HEVC, 10-bit/4:2:2 H.264, MKV/MOV with incompatible codecs, AC3 and other unsupported combinations are converted on demand to a cached H.264/AAC MP4 for preview only. The original file is never modified.
- Make sure both `ffmpeg` and `ffprobe` are installed on the VPS.


## Performance fixes: large downloads and instant video playback
- File downloads are initiated with a direct authenticated attachment URL instead of `fetch().blob()`. This allows Chrome/Edge to stream large files directly to the browser download manager instead of waiting for the whole file to load into JavaScript memory first.
- Browser-compatible videos are streamed directly from their original file with HTTP byte-range support, so playback can begin as soon as the browser receives enough media data.
- Videos with unsupported codecs are automatically retried through `/api/files/preview-transcoded` (or the shared-link `?preview=1&transcoded=1` path). FFmpeg emits a fragmented MP4 stream while converting, then stores the completed preview in the preview cache for future opens. The original file is never modified.
- The live fallback uses `ultrafast` + `zerolatency` by default. You can override it with `PREVIEW_FFMPEG_LIVE_PRESET` and `PREVIEW_FFMPEG_LIVE_CRF` if you want to trade CPU use for quality.
