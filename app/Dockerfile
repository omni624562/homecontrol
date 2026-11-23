# 新版畫面（React + Tailwind + shadcn/ui）：先編譯成靜態檔
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

FROM python:3.12-slim
# 版本：deploy.sh 用 git describe 帶進來，設定頁和 /api/health 會顯示
ARG VERSION=dev
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Asia/Taipei PLUGHUB_DATA=/data PLUGHUB_VERSION=$VERSION
WORKDIR /app
# 讀路由器的連線裝置清單用（SSH 金鑰登入，只讀）
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# 攝影機用的模型（認人、找臉、認是誰），下載後核對 SHA-256
COPY fetch_models.py .
RUN python fetch_models.py models
COPY plughub ./plughub
COPY --from=web /web/dist ./plughub/web
EXPOSE 8100
# 主程式卡住 2 分鐘 /api/health 會回 503（卡住時程式也會自己結束、由 Docker 重新啟動）
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8100/api/health', timeout=8).status == 200 else 1)"
CMD ["uvicorn", "plughub.main:app", "--host", "0.0.0.0", "--port", "8100", "--proxy-headers", "--timeout-graceful-shutdown", "3"]
