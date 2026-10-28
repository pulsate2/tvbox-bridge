# syntax=docker/dockerfile:1

# tvbox-bridge：Node 网关 + JDK（companion 解析进程）
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# JRE 17 用于运行 companion-service.jar（CatVod spider 运行时）
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openjdk-17-jre-headless \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/* \
 && java -version 2>&1 | head -n 1

WORKDIR /app

# 依赖层（package-lock 不变时可复用缓存）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public
# companion-service.jar 由 companion-build/build.sh 生成（CI 中先构建再 docker build）。
# 缺失时服务仍可启动，只是 Spider 站点不可用（CMS 站点不受影响）。
COPY companion/ ./companion/

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    JAR_CACHE_DIR=/data/jars \
    COMPANION_HOME=/data

# /data 持久化：companion 载荷缓存（~/.tvbox_bridge）与预下载的 spider jar
RUN mkdir -p /data/jars && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
