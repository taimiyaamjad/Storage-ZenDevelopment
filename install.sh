#!/usr/bin/env bash
# ==============================================================================
# Zen VPS Storage & S3 Cluster - Automated Interactive VPS Installer
# Supported OS: Ubuntu 20.04+, Ubuntu 22.04+, Ubuntu 24.04+, Debian 11/12
# Usage:
#   curl -fsSL https://<your-domain>/install.sh | sudo bash
#   or: sudo bash install.sh
# ==============================================================================

set -e

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Clear terminal screen if interactive
if [ -t 1 ]; then
  clear
fi

echo -e "${CYAN}${BOLD}"
echo "========================================================================"
echo "    ⚡ Zen VPS Storage & S3 Cluster - Interactive Setup Installer ⚡   "
echo "  Production SFTP Cloud Storage, AWS S3 API & Vercel Blob Compatible   "
echo "========================================================================"
echo -e "${NC}"

# Check for root / sudo
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}[ERROR] This installer must be run as root (or using sudo).${NC}"
  echo "Please run: sudo bash $0"
  exit 1
fi

# Detect Public IP
DETECTED_IP=$(curl -s4 --max-time 3 https://ifconfig.me || curl -s4 --max-time 3 https://api.ipify.org || hostname -I | awk '{print $1}')
if [ -z "$DETECTED_IP" ]; then
  DETECTED_IP="127.0.0.1"
fi

echo -e "${YELLOW}This wizard will configure and deploy your Zen VPS Storage system.${NC}"
echo -e "${YELLOW}Press [ENTER] to accept the recommended default in brackets.${NC}\n"

# 1. Domain or IP
read -r -p "$(echo -e "${BOLD}1) Domain Name or VPS IP [${CYAN}${DETECTED_IP}${NC}${BOLD}]: ${NC}")" USER_DOMAIN
USER_DOMAIN=${USER_DOMAIN:-$DETECTED_IP}

# 2. Application Port
read -r -p "$(echo -e "${BOLD}2) Internal Application Port [${CYAN}5000${NC}${BOLD}]: ${NC}")" APP_PORT
APP_PORT=${APP_PORT:-5000}

# 3. Application Directory
DEFAULT_INSTALL_DIR="/var/www/vps-sftp-filemanager"
read -r -p "$(echo -e "${BOLD}3) Installation Directory [${CYAN}${DEFAULT_INSTALL_DIR}${NC}${BOLD}]: ${NC}")" INSTALL_DIR
INSTALL_DIR=${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}

# 4. Storage Root
DEFAULT_STORAGE_ROOT="/var/vps_storage"
read -r -p "$(echo -e "${BOLD}4) Storage Base Directory [${CYAN}${DEFAULT_STORAGE_ROOT}${NC}${BOLD}]: ${NC}")" STORAGE_ROOT
STORAGE_ROOT=${STORAGE_ROOT:-$DEFAULT_STORAGE_ROOT}

# 5. Default User Quota in GB
read -r -p "$(echo -e "${BOLD}5) Default User Storage Quota in GB [${CYAN}10${NC}${BOLD}]: ${NC}")" QUOTA_GB
QUOTA_GB=${QUOTA_GB:-10}
QUOTA_BYTES=$((QUOTA_GB * 1073741824))

# 6. Anti Multi-Account Protection
read -r -p "$(echo -e "${BOLD}6) Enable Anti Multi-Account IP Tracking? (Y/n) [${CYAN}Y${NC}${BOLD}]: ${NC}")" ANTI_MULTI
ANTI_MULTI=${ANTI_MULTI:-Y}
if [[ "$ANTI_MULTI" =~ ^[Nn] ]]; then
  ANTI_MULTI_VAL="false"
else
  ANTI_MULTI_VAL="true"
fi

# 7. Configure Nginx
read -r -p "$(echo -e "${BOLD}7) Configure Nginx Reverse Proxy (Port 80/443)? (Y/n) [${CYAN}Y${NC}${BOLD}]: ${NC}")" SETUP_NGINX
SETUP_NGINX=${SETUP_NGINX:-Y}

# 8. SSL / Let's Encrypt Certbot
SETUP_SSL="N"
ADMIN_EMAIL=""
if [[ ! "$SETUP_NGINX" =~ ^[Nn] ]] && [[ "$USER_DOMAIN" != "127.0.0.1" ]] && [[ ! "$USER_DOMAIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  read -r -p "$(echo -e "${BOLD}8) Automatically configure free SSL (HTTPS) with Let's Encrypt? (y/N) [${CYAN}N${NC}${BOLD}]: ${NC}")" SETUP_SSL
  SETUP_SSL=${SETUP_SSL:-N}
  if [[ "$SETUP_SSL" =~ ^[Yy] ]]; then
    read -r -p "$(echo -e "${BOLD}   Enter your email for SSL renewal notifications: ${NC}")" ADMIN_EMAIL
  fi
fi

echo ""
echo -e "${CYAN}${BOLD}Configuration Summary:${NC}"
echo -e "  • Domain / Host:      ${GREEN}${USER_DOMAIN}${NC}"
echo -e "  • Application Port:   ${GREEN}${APP_PORT}${NC}"
echo -e "  • Install Directory:  ${GREEN}${INSTALL_DIR}${NC}"
echo -e "  • Storage Directory:  ${GREEN}${STORAGE_ROOT}${NC}"
echo -e "  • Default User Quota: ${GREEN}${QUOTA_GB} GB${NC}"
echo -e "  • Anti-Multi IP:      ${GREEN}${ANTI_MULTI_VAL}${NC}"
echo -e "  • Nginx Reverse Proxy:${GREEN}${SETUP_NGINX}${NC}"
echo -e "  • Let's Encrypt SSL:  ${GREEN}${SETUP_SSL}${NC}"
echo ""

read -r -p "$(echo -e "${BOLD}Proceed with installation? (Y/n) [${CYAN}Y${NC}${BOLD}]: ${NC}")" CONFIRM
CONFIRM=${CONFIRM:-Y}
if [[ "$CONFIRM" =~ ^[Nn] ]]; then
  echo -e "${YELLOW}Installation canceled by user.${NC}"
  exit 0
fi

echo ""
echo -e "${BLUE}==> [1/7] Checking system packages and installing prerequisites...${NC}"
# Recover dpkg state if interrupted by previous run or overlayfs cross-device issues
dpkg --configure -a 2>/dev/null || true
rm -f /var/cache/apt/archives/git*.deb 2>/dev/null || true

# Refresh package lists
apt-get update -y || true

# Safely check and only install packages that are not already present.
# This avoids dpkg hard link / EXDEV errors when upgrading existing tools (like git) on overlayfs/containers.
PREREQ_PKGS=(curl wget git build-essential python3 sqlite3 ffmpeg libsqlite3-dev openssl nginx ca-certificates gnupg)
TO_INSTALL=()
for pkg in "${PREREQ_PKGS[@]}"; do
  if ! dpkg -s "$pkg" 2>/dev/null | grep -q "Status: install ok installed"; then
    TO_INSTALL+=("$pkg")
  fi
done

if [ ${#TO_INSTALL[@]} -gt 0 ]; then
  echo "Installing missing dependencies: ${TO_INSTALL[*]}..."
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-upgrade "${TO_INSTALL[@]}" || {
    echo -e "${YELLOW}[INFO] Attempting to fix broken packages...${NC}"
    apt-get --fix-broken install -y || true
  }
else
  echo -e "${GREEN}All system prerequisites are already present.${NC}"
fi

echo -e "${BLUE}==> [2/7] Ensuring Node.js 20+ LTS is installed...${NC}"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 18 ]; then
  echo "Installing Node.js 20 LTS from NodeSource..."
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi
echo -e "${GREEN}Node.js $(node -v) and npm $(npm -v) are ready.${NC}"

echo -e "${BLUE}==> [3/7] Setting up application files and directories...${NC}"
mkdir -p "$INSTALL_DIR"
mkdir -p "$STORAGE_ROOT"
chmod 755 "$STORAGE_ROOT"

# If current directory contains package.json, copy it to INSTALL_DIR
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
  echo "Copying files from $SCRIPT_DIR to $INSTALL_DIR..."
  cp -r "$SCRIPT_DIR/"* "$INSTALL_DIR/" 2>/dev/null || true
  cp "$SCRIPT_DIR/.*" "$INSTALL_DIR/" 2>/dev/null || true
fi

cd "$INSTALL_DIR"

echo -e "${BLUE}==> [4/7] Generating production environment configuration (.env)...${NC}"
JWT_SECRET=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)

PROTOCOL="http"
if [[ "$SETUP_SSL" =~ ^[Yy] ]]; then
  PROTOCOL="https"
fi

cat > .env <<EOL
PORT=${APP_PORT}
APP_NAME=Zen VPS Storage & S3 Cluster
APP_URL=${PROTOCOL}://${USER_DOMAIN}
STORAGE_ROOT=${STORAGE_ROOT}
DEFAULT_STORAGE_QUOTA_BYTES=${QUOTA_BYTES}
MAX_SHARE_LINKS_PER_USER=3
ANTI_MULTI_ACCOUNT_ENABLED=${ANTI_MULTI_VAL}
DB_FILE=data.sqlite
JWT_SECRET=${JWT_SECRET}
SESSION_SECRET=${SESSION_SECRET}

# Preview and Video Transcoding Cache
PREVIEW_CACHE_ROOT=/tmp/vps_sftp_preview_cache
PREVIEW_MAX_TRANSCODES=2
PREVIEW_FFMPEG_PRESET=veryfast
PREVIEW_FFMPEG_CRF=23
PREVIEW_FFMPEG_LIVE_PRESET=ultrafast
PREVIEW_FFMPEG_LIVE_CRF=26
EOL

echo -e "${GREEN}Created .env with secure random keys.${NC}"

echo -e "${BLUE}==> [5/7] Installing npm dependencies & preparing sqlite3...${NC}"
npm install --production --no-audit --no-fund
npm rebuild sqlite3 2>/dev/null || true

echo -e "${BLUE}==> [6/7] Creating Systemd background service...${NC}"
SERVICE_FILE="/etc/systemd/system/vps-storage.service"
cat > "$SERVICE_FILE" <<EOL
[Unit]
Description=Zen VPS Storage & S3 Cluster Service
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOL

systemctl daemon-reload
systemctl enable vps-storage
systemctl restart vps-storage

echo -e "${GREEN}Systemd service 'vps-storage' created and started.${NC}"

# 7. Nginx Setup
if [[ ! "$SETUP_NGINX" =~ ^[Nn] ]]; then
  echo -e "${BLUE}==> [7/7] Configuring Nginx Reverse Proxy & WebSocket support...${NC}"
  NGINX_CONF="/etc/nginx/sites-available/vps-storage"
  cat > "$NGINX_CONF" <<EOL
server {
    listen 80;
    server_name ${USER_DOMAIN};

    client_max_body_size 0;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;

        proxy_buffering off;
        proxy_request_buffering off;
        proxy_force_ranges on;

        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOL

  ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/
  # Remove default nginx welcome site if still present
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
  echo -e "${GREEN}Nginx reverse proxy configured successfully.${NC}"

  if [[ "$SETUP_SSL" =~ ^[Yy] ]] && [ -n "$ADMIN_EMAIL" ]; then
    echo -e "${BLUE}Obtaining SSL Certificate via Certbot...${NC}"
    apt-get install -y certbot python3-certbot-nginx
    certbot --nginx -d "$USER_DOMAIN" --non-interactive --agree-tos -m "$ADMIN_EMAIL" || {
      echo -e "${YELLOW}Warning: Certbot SSL setup failed. Please ensure DNS for $USER_DOMAIN points to this VPS IP ($DETECTED_IP).${NC}"
    }
    systemctl reload nginx
  fi
fi

# Print Success Banner
WEB_URL="${PROTOCOL}://${USER_DOMAIN}"
if [[ "$SETUP_NGINX" =~ ^[Nn] ]]; then
  WEB_URL="http://${USER_DOMAIN}:${APP_PORT}"
fi

echo ""
echo -e "${GREEN}${BOLD}"
echo "========================================================================"
echo "    🎉 INSTALLATION COMPLETE - ZEN VPS STORAGE & S3 CLUSTER IS LIVE!   "
echo "========================================================================"
echo -e "${NC}"
echo -e "${BOLD}Web Application URL:${NC}       ${CYAN}${WEB_URL}${NC}"
echo -e "${BOLD}Default Administrator Login:${NC}"
echo -e "  • Username:                 ${YELLOW}admin${NC}"
echo -e "  • Password:                 ${YELLOW}Admin@123456${NC}"
echo ""
echo -e "${BOLD}S3 & Vercel Blob API Endpoints:${NC}"
echo -e "  • S3 Cluster API:           ${MAGENTA}${WEB_URL}/api/s3${NC}"
echo -e "  • Vercel Blob API:          ${MAGENTA}${WEB_URL}/api/v1/blob${NC}"
echo ""
echo -e "${BOLD}Useful Server Commands:${NC}"
echo -e "  • Check service status:     ${CYAN}systemctl status vps-storage${NC}"
echo -e "  • View live logs:           ${CYAN}journalctl -u vps-storage -f${NC}"
echo -e "  • Restart application:      ${CYAN}systemctl restart vps-storage${NC}"
echo ""
echo -e "${YELLOW}IMPORTANT: Log in immediately, navigate to Profile, and change the default password!${NC}"
echo "========================================================================"
