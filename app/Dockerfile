# 新版畫面（React + Tailwind + shadcn/ui）：先編譯成靜態檔
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Asia/Taipei PLUGHUB_DATA=/data
WORKDIR /app
# 讀路由器的連線裝置清單用（SSH 金鑰登入，只讀）
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY plughub ./plughub
COPY --from=web /web/dist ./plughub/web
EXPOSE 8100
CMD ["uvicorn", "plughub.main:app", "--host", "0.0.0.0", "--port", "8100", "--proxy-headers", "--timeout-graceful-shutdown", "3"]
