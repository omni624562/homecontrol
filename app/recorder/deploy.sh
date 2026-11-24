#!/bin/sh
# 從樹莓派把錄影機部署到 Jetson：./deploy.sh（token 存在樹莓派的 data/secrets.json，第一次自動產生）
set -e
cd "$(dirname "$0")"
HOST=${RECORDER_HOST:-jetson}
TOKEN=$(docker exec plughub python -c "import json;print(json.load(open('/data/secrets.json')).get('recorder_token',''))")
[ -n "$TOKEN" ] || { echo "樹莓派上還沒有 recorder_token（先在主程式設定錄影機）"; exit 1; }
ssh "$HOST" 'mkdir -p ~/recorder ~/recordings'
scp -q recorder.py Dockerfile docker-compose.yml "$HOST":recorder/
ssh "$HOST" "cd ~/recorder && RECORDER_TOKEN='$TOKEN' docker compose up -d --build && docker ps --filter name=recorder --format '{{.Status}}'"
