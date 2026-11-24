#!/bin/sh
# 從樹莓派把 GPU 辨識服務部署到 Jetson：./deploy.sh（token 跟錄影機同一組，存在樹莓派的 data/secrets.json）
# 模型（YOLOX ONNX，Apache 2.0）第一次會下載到 Jetson 的 ~/vision/models 並核對 SHA-256
set -e
cd "$(dirname "$0")"
HOST=${VISION_HOST:-jetson}
TOKEN=$(docker exec plughub python -c "import json;print(json.load(open('/data/secrets.json')).get('recorder_token',''))")
[ -n "$TOKEN" ] || { echo "樹莓派上還沒有 recorder_token（先設定錄影機）"; exit 1; }
ssh "$HOST" 'mkdir -p ~/vision/models && cd ~/vision/models &&
  for m in yolox_s:c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063 yolox_m:21ff6cfdeb53b013bac2249599e55f00bff3cfdfdab37ed7a4620818c1d15b3f; do
    n=${m%%:*}; s=${m#*:}
    [ -f $n.onnx ] || curl -sfL -o $n.onnx https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/$n.onnx
    echo "$s  $n.onnx" | sha256sum -c --quiet || { rm -f $n.onnx; echo "$n.onnx 的 SHA-256 不對"; exit 1; }
  done'
scp -q server.py Dockerfile docker-compose.yml "$HOST":vision/
ssh "$HOST" "cd ~/vision && VISION_TOKEN='$TOKEN' VISION_MODEL='${VISION_MODEL:-yolox_m}' docker compose up -d --build && docker ps --filter name=vision --format '{{.Status}}'"
