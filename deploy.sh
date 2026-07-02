#!/usr/bin/env bash
set -euo pipefail

# Options-Indicator 项目部署脚本
# 脚本使用 rsync 将项目源码同步至服务器，并在远端通过 PM2 启动/重启服务。
#
# 可选环境变量：
#   REMOTE_HOST          默认：amd1 （可修改为您在 ~/.ssh/config 中配置的别名，如已配置 amd1 则无需修改）
#   REMOTE_PORT          默认：空（使用 SSH 默认端口或 ssh_config 配置）
#   REMOTE_SERVER_DIR    默认：/home/ubuntu/options-indicator
#   PM2_APP_NAME         默认：options-indicator
#   NODE_ENV             默认：production
#   PORT                 默认：3000

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REMOTE_HOST="${REMOTE_HOST:-amd1}"
REMOTE_PORT="${REMOTE_PORT:-}"
REMOTE_SERVER_DIR="${REMOTE_SERVER_DIR:-/home/ubuntu/options-indicator}"
PM2_APP_NAME="${PM2_APP_NAME:-options-indicator}"
NODE_ENV="${NODE_ENV:-production}"
PORT="${PORT:-3000}"

if [[ ! -f "${ROOT_DIR}/package.json" || ! -f "${ROOT_DIR}/src/app.js" ]]; then
  echo "[deploy] Error: options-indicator source files missing in ${ROOT_DIR}" >&2
  exit 1
fi

echo "[deploy] Root directory: ${ROOT_DIR}"
echo "[deploy] Remote target: ${REMOTE_HOST}:${REMOTE_SERVER_DIR}"
echo "[deploy] PM2 App Name: ${PM2_APP_NAME}"
echo "[deploy] Target Port: ${PORT}"

SSH_ARGS=()
RSYNC_SSH="ssh"
if [[ -n "${REMOTE_PORT}" ]]; then
  SSH_ARGS=(-p "${REMOTE_PORT}")
  RSYNC_SSH="ssh -p ${REMOTE_PORT}"
fi

echo "[deploy] Creating remote directory..."
ssh "${SSH_ARGS[@]}" "${REMOTE_HOST}" "mkdir -p ${REMOTE_SERVER_DIR@Q}"

echo "[deploy] Syncing code to remote server via rsync..."
rsync -az --delete -e "${RSYNC_SSH}" \
  --exclude 'node_modules/' \
  --exclude 'data/' \
  --exclude '.git/' \
  --exclude '.agents/' \
  --exclude 'deploy.sh' \
  --exclude 'deploy.sh.old' \
  --exclude 'package-lock.json' \
  "${ROOT_DIR}/" \
  "${REMOTE_HOST}:${REMOTE_SERVER_DIR%/}/"

echo "[deploy] Installing dependencies and reloading PM2 on remote..."
ssh "${SSH_ARGS[@]}" "${REMOTE_HOST}" "bash -lc '
  set -euo pipefail
  cd ${REMOTE_SERVER_DIR@Q}
  
  # 安装生产环境依赖
  npm install --omit=dev

  # 使用 PM2 启动或重启服务
  if pm2 describe \"${PM2_APP_NAME}\" >/dev/null 2>&1; then
    echo \"[deploy] PM2 process exists. Recreating process with current entrypoint...\"
    pm2 delete \"${PM2_APP_NAME}\"
  else
    echo \"[deploy] Starting new PM2 process...\"
  fi
  NODE_ENV=\"${NODE_ENV}\" PORT=\"${PORT}\" pm2 start src/app.js --name \"${PM2_APP_NAME}\"
  pm2 save
'"

echo "[deploy] Deployment successfully completed!"
