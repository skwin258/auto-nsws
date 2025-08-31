# ---- 基底：Node 20（小而乾淨）
FROM node:20-slim

# 時區 + CJK 字型（顯示中文用）
ENV TZ=Asia/Taipei
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      tzdata fonts-noto-cjk && \
    rm -rf /var/lib/apt/lists/*

# 工作目錄
WORKDIR /app

# 先裝相依
COPY package*.json ./
# 用 npm ci，有 package-lock 就走 ci，沒有就退回 npm i
RUN npm ci --omit=dev || npm i --omit=dev

# 複製程式碼
COPY . .

# 預設啟動：你的排程程式
CMD ["node", "auto-news.js"]
