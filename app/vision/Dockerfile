# GPU 物件辨識（跑在 Jetson 上）：JetPack 6.1（L4T R36.4）內建 CUDA、TensorRT、OpenCV
FROM nvcr.io/nvidia/l4t-jetpack:r36.4.0
RUN apt-get update && apt-get install -y --no-install-recommends python3-pip && rm -rf /var/lib/apt/lists/* \
 && pip3 install --no-cache-dir "cuda-python==12.6.2.post1"
ENV PYTHONUNBUFFERED=1 TZ=Asia/Taipei
WORKDIR /app
COPY server.py .
CMD ["python3", "server.py"]
