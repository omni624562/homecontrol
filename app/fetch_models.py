"""建 Docker 映像時下載攝影機用的模型，核對 SHA-256（不對就讓建置失敗）。

- EfficientDet-Lite0（Apache 2.0）：認人
- YuNet（MIT）：找臉；SFace（Apache 2.0）：認是誰。都來自 OpenCV Zoo
- MoveNet MultiPose Lightning（Apache 2.0）：姿勢（跌倒偵測），Kaggle 上的 tar.gz
"""
import hashlib
import io
import sys
import tarfile
import urllib.request
from pathlib import Path

ZOO = "https://github.com/opencv/opencv_zoo/raw/main/models/"
MODELS = {
    "efficientdet_lite0.tflite": (
        "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/efficientdet_lite0.tflite",
        "0720bf247bd76e6594ea28fa9c6f7c5242be774818997dbbeffc4da460c723bb",
    ),
    "face_detection_yunet_2023mar.onnx": (
        ZOO + "face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    ),
    "face_recognition_sface_2021dec.onnx": (
        ZOO + "face_recognition_sface/face_recognition_sface_2021dec.onnx",
        "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    ),
    "movenet_multipose.tflite": (
        "https://www.kaggle.com/api/v1/models/google/movenet/tfLite/multipose-lightning-tflite-float16/1/download",
        "d4489f89e6bd6777a8b9a1a16189832131f84ff90d82fae729e670b84d7948dd",
    ),
}


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "models")
    out.mkdir(parents=True, exist_ok=True)
    for name, (url, sha) in MODELS.items():
        data = urllib.request.urlopen(url, timeout=120).read()  # noqa: S310
        if data[:2] == b"\x1f\x8b":  # tar.gz：取出裡面唯一的 .tflite
            with tarfile.open(fileobj=io.BytesIO(data)) as tar:
                member = next(m for m in tar.getmembers() if m.name.endswith(".tflite"))
                data = tar.extractfile(member).read()
        got = hashlib.sha256(data).hexdigest()
        if got != sha:
            sys.exit(f"{name} 的 SHA-256 不對：{got}")
        (out / name).write_bytes(data)
        print(f"{name}：{len(data) // 1024} KB")


if __name__ == "__main__":
    main()
