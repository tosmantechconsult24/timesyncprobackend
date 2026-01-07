#!/usr/bin/env bash
set -euo pipefail

# deploy_production.sh
# Safe, idempotent deployment helper for production servers.
# Usage: run on the target server as a user with access to the repo.

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Deploying from ${ROOT_DIR}"

if [ ! -f "${ROOT_DIR}/.env" ]; then
  echo ".env file missing in ${ROOT_DIR}. Please create one from .env.example and set production values." >&2
  exit 1
fi

echo "Installing npm dependencies (production)"
npm ci --production

echo "Generating Prisma client"
npx prisma generate

echo "Applying migrations (prisma migrate deploy)"
npx prisma migrate deploy

echo "Building project"
npm run build

echo "Starting/Restarting with PM2"
if command -v pm2 >/dev/null 2>&1; then
  pm2 start ecosystem.config.js --only timesync-backend || pm2 restart timesync-backend || pm2 start ecosystem.config.js
  pm2 save
else
  echo "pm2 not installed. Installing pm2..."
  npm i -g pm2
  pm2 start ecosystem.config.js
  pm2 save
fi

echo "Installing pm2-logrotate (optional)"
pm2 install pm2-logrotate || true
pm2 set pm2-logrotate:max_size 10M || true
pm2 set pm2-logrotate:retain 14 || true

echo "Deployment complete. Use 'pm2 logs timesync-backend' to view logs."

echo "Next steps: configure reverse proxy (Nginx) with the provided template and ensure /ready and /health are reachable." 
