# 影像模型服務（跑在 Jetson 上）：JetPack 6.1（L4T R36.4）內建 CUDA、TensorRT、OpenCV
FROM nvcr.io/nvidia/l4t-jetpack:r36.4.0
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-pip tzdata && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir "cuda-python==12.6.2.post1" "numpy<2" pillow ai-edge-litert==2.4.0 tokenizers==0.21.1 \
 && pip3 install --no-cache-dir --index-url https://pypi.jetson-ai-lab.io/jp6/cu126 onnxruntime-gpu==1.24.0
ENV PYTHONUNBUFFERED=1 TZ=Asia/Taipei PYTHONWARNINGS=ignore::FutureWarning
WORKDIR /app
# 姿勢、認臉、點一下就框：跟樹莓派同一份程式（deploy.sh 從 app/plughub 複製過來）
COPY plughub ./plughub
COPY server.py stream.py index.py sound.py ghost.py ./
CMD ["python3", "server.py"]
