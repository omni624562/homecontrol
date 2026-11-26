#!/bin/sh
# 從樹莓派把影像模型服務部署到 Jetson：./deploy.sh（token 跟錄影機同一組，存在樹莓派的 data/secrets.json）
# - YOLOX、RTMO、SigLIP 2（都是 Apache 2.0）第一次會下載到 Jetson 的 ~/vision/models 並核對 SHA-256
# - 姿勢、認臉、MobileSAM 的模型從樹莓派的 plughub 容器複製過去（建置時已經核對過 SHA-256）
set -e
cd "$(dirname "$0")"
HOST=${VISION_HOST:-jetson}
TOKEN=$(docker exec plughub python -c "import json;print(json.load(open('/data/secrets.json')).get('recorder_token',''))")
[ -n "$TOKEN" ] || { echo "樹莓派上還沒有 recorder_token（先設定錄影機）"; exit 1; }
ssh "$HOST" 'mkdir -p ~/vision/models ~/vision/plughub ~/vision/index && cd ~/vision/models &&
  for m in yolox_s:c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063 yolox_m:21ff6cfdeb53b013bac2249599e55f00bff3cfdfdab37ed7a4620818c1d15b3f; do
    n=${m%%:*}; s=${m#*:}
    [ -f $n.onnx ] || curl -sfL -o $n.onnx https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/$n.onnx
    echo "$s  $n.onnx" | sha256sum -c --quiet || { rm -f $n.onnx; echo "$n.onnx 的 SHA-256 不對"; exit 1; }
  done &&
  if [ ! -f rtmo_s.onnx ]; then
    curl -sfL -o rtmo.zip https://download.openmmlab.com/mmpose/v1/projects/rtmo/onnx_sdk/rtmo-s_8xb32-600e_body7-640x640-dac2bf74_20231211.zip &&
    echo "3da7ad88b209f9da8be87ba5c325610639af04de3b5c8a96649b98cd9e2848a2  rtmo.zip" | sha256sum -c --quiet &&
    unzip -o -q -j rtmo.zip "*end2end.onnx" -d rtmo_tmp && mv rtmo_tmp/end2end.onnx rtmo_s.onnx && rm -rf rtmo_tmp rtmo.zip
  fi &&
  mkdir -p siglip2 && cd siglip2 &&
  for m in onnx/vision_model_fp16.onnx:a1959f7bd3993a607e48839f6d01e25b876fe76afda301b028b78eef68aabd95 onnx/text_model_fp16.onnx:711da56ada0a4aa11c7dd3320df741081a3cae4f0ae1b5e5c6d5b294738d0eb0 tokenizer.json:cb9140fae3ac5122c972d37adf83e1248471a38147ad76f8215c8872c6fd8322; do
    f=${m%%:*}; s=${m#*:}; n=$(basename $f)
    [ -f $n ] || curl -sfL -o $n https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX/resolve/main/$f
    echo "$s  $n" | sha256sum -c --quiet || { rm -f $n; echo "$n 的 SHA-256 不對"; exit 1; }
  done'
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for f in efficientdet_lite0.tflite movenet_multipose.tflite face_detection_yunet_2023mar.onnx face_recognition_sface_2021dec.onnx mobile_sam_image_encoder.onnx sam_mask_decoder_multi.onnx; do
  ssh "$HOST" "test -f ~/vision/models/$f" || { docker cp "plughub:/app/models/$f" "$TMP/$f" && scp -q "$TMP/$f" "$HOST":vision/models/; }
done
# 聲音偵測：YAMNet（Apache 2.0，MediaPipe 版）和類別名稱，樹莓派下載核對後送過去
if ! ssh "$HOST" "test -f ~/vision/models/yamnet/yamnet.tflite -a -f ~/vision/models/yamnet/yamnet_class_map.csv"; then
  curl -sfL -o "$TMP/yamnet.tflite" https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite
  curl -sfL -o "$TMP/yamnet_class_map.csv" https://raw.githubusercontent.com/tensorflow/models/master/research/audioset/yamnet/yamnet_class_map.csv
  (cd "$TMP" && printf '%s\n' "4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf  yamnet.tflite" "cdf24d193e196d9e95912a2667051ae203e92a2ba09449218ccb40ef787c6df2  yamnet_class_map.csv" | sha256sum -c --quiet)
  ssh "$HOST" 'mkdir -p ~/vision/models/yamnet'
  scp -q "$TMP/yamnet.tflite" "$TMP/yamnet_class_map.csv" "$HOST":vision/models/yamnet/
fi
scp -q ../plughub/__init__.py ../plughub/camera.py ../plughub/vision.py ../plughub/faces.py ../plughub/segment.py ../plughub/secretbox.py "$HOST":vision/plughub/
scp -q server.py stream.py index.py sound.py ghost.py Dockerfile docker-compose.yml "$HOST":vision/
ssh "$HOST" "cd ~/vision && VISION_TOKEN='$TOKEN' VISION_MODEL='${VISION_MODEL:-yolox_m}' docker compose up -d --build && docker ps --filter name=vision --format '{{.Status}}'"
