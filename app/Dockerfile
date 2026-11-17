FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Asia/Taipei PLUGHUB_DATA=/data
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY plughub ./plughub
EXPOSE 8100
CMD ["uvicorn", "plughub.main:app", "--host", "0.0.0.0", "--port", "8100", "--proxy-headers"]
