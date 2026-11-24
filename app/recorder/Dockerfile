# 攝影機錄影機（跑在 Jetson 上）：ffmpeg 原封不動存 RTSP 串流，給樹莓派剪片段
FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV PYTHONUNBUFFERED=1 TZ=Asia/Taipei
WORKDIR /app
COPY recorder.py .
CMD ["python", "recorder.py"]
