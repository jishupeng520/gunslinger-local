FROM node:22-alpine

WORKDIR /app

# 先安装生产依赖，利用 Docker 构建缓存加快后续启动。
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

# 以非 root 用户运行，避免容器内服务拥有不必要的权限。
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
