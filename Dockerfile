# syntax=docker/dockerfile:1

# 国内构建加速：Alpine 软件源与 npm 源，可通过 --build-arg 覆盖。
ARG APK_MIRROR=https://mirrors.aliyun.com/alpine
ARG NPM_REGISTRY=https://registry.npmmirror.com

FROM node:22-alpine AS deps
ARG APK_MIRROR
ARG NPM_REGISTRY
WORKDIR /app
# 默认的 dl-cdn.alpinelinux.org 在国内经常极慢，先换成国内镜像再装编译依赖。
RUN sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${APK_MIRROR}#g" /etc/apk/repositories \
    && apk add --no-cache libc6-compat python3 make g++
COPY package.json package-lock.json ./
RUN npm config set registry "${NPM_REGISTRY}" \
    && npm ci --no-audit --no-fund

FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
ARG APK_MIRROR
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${APK_MIRROR}#g" /etc/apk/repositories \
    && apk add --no-cache libc6-compat libstdc++ tzdata su-exec \
    && addgroup -g 1001 -S nodejs \
    && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data \
    && chown nextjs:nodejs /app/data

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
