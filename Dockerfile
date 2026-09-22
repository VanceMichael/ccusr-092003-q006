
FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./

COPY . .

ENV PORT=8080 DATABASE_PATH=/data/app.sqlite3
EXPOSE 8080
# 数据卷在启动时才挂载，迁移在启动前执行
CMD ["sh", "-c", "npm run migrate && npm start"]
