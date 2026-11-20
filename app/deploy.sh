#!/bin/sh
# 更新並重新啟動家庭中控：git pull 之後執行 ./deploy.sh
# 和 docker compose up -d --build 一樣，另外把版本號（git describe）帶進映像，設定頁會顯示
set -e
cd "$(dirname "$0")"
PLUGHUB_VERSION=$(git describe --tags --always --dirty 2>/dev/null || echo dev)
export PLUGHUB_VERSION
echo "版本：$PLUGHUB_VERSION"
docker compose up -d --build "$@"
