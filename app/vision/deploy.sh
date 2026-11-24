#!/bin/sh
# 從樹莓派把影像模型服務部署到 Jetson：./deploy.sh（token 跟錄影機同一組，存在樹莓派的 data/secrets.json）
# - YOLOX、RTMO（都是 Apache 2.0）第一次會下載到 Jetson 的 ~/vision/models 並核對 SHA-256
# - 姿勢、認臉、MobileSAM 的模型從樹莓派的 plughub 容器複製過去（建置時已經核對過 SHA-256）
set -e
cd "$(dirname "$0")"
HOST=${VISION_HOST:-jetson}
TOKEN=$(docker exec plughub python -c "import json;print(json.load(open('/data/secrets.json')).get('recorder_token',''))")
[ -n "$TOKEN" ] || { echo "樹莓派上還沒有 recorder_token（先設定錄影機）"; exit 1; }
ssh "$HOST" 'mkdir -p ~/vision/models ~/vision/plughub && cd ~/vision/models &&
  for m in yolox_s:c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063 yolox_m:21ff6cfdeb53b013bac2249599e55f00bff3cfdfdab37ed7a4620818c1d15b3f; do
    n=${m%%:*}; s=${m#*:}
    [ -f $n.onnx ] || curl -sfL -o $n.onnx https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/$n.onnx
    echo "$s  $n.onnx" | sha256sum -c --quiet || { rm -f $n.onnx; echo "$n.onnx 的 SHA-256 不對"; exit 1; }
  done &&
  if [ ! -f rtmo_s.onnx ]; then
    curl -sfL -o rtmo.zip https://download.openmmlab.com/mmpose/v1/projects/rtmo/onnx_sdk/rtmo-s_8xb32-600e_body7-640x640-dac2bf74_20231211.zip &&
    echo "3da7ad88b209f9da8be87ba5c325610639af04de3b5c8a96649b98cd9e2848a2  rtmo.zip" | sha256sum -c --quiet &&
    unzip -o -q -j rtmo.zip "*end2end.onnx" -d rtmo_tmp && mv rtmo_tmp/end2end.onnx rtmo_s.onnx && rm -rf rtmo_tmp rtmo.zip
  fi'
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for f in efficientdet_lite0.tflite movenet_multipose.tflite face_detection_yunet_2023mar.onnx face_recognition_sface_2021dec.onnx mobile_sam_image_encoder.onnx sam_mask_decoder_multi.onnx; do
  ssh "$HOST" "test -f ~/vision/models/$f" || { docker cp "plughub:/app/models/$f" "$TMP/$f" && scp -q "$TMP/$f" "$HOST":vision/models/; }
done
scp -q ../plughub/__init__.py ../plughub/camera.py ../plughub/vision.py ../plughub/faces.py ../plughub/segment.py "$HOST":vision/plughub/
scp -q server.py stream.py Dockerfile docker-compose.yml "$HOST":vision/
ssh "$HOST" "cd ~/vision && VISION_TOKEN='$TOKEN' VISION_MODEL='${VISION_MODEL:-yolox_m}' docker compose up -d --build && docker ps --filter name=vision --format '{{.Status}}'"
