# 构建 Vite 前端产物。
FROM oven/bun:1.3.14 AS web-build

WORKDIR /app/web
COPY web/package.json web/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --cache-dir=/root/.bun/install/cache
COPY VERSION /app/VERSION
COPY CHANGELOG.md /app/CHANGELOG.md
COPY LICENSE /app/LICENSE
COPY web ./
COPY shared /app/shared
RUN bun run build

# 默认保持纯前端；平台 Compose 通过构建参数启用 API 代理。
FROM nginx:1.27-alpine

ARG NGINX_CONF=nginx.web-only.conf
COPY --from=web-build /app/web/dist /usr/share/nginx/html
COPY ${NGINX_CONF} /etc/nginx/conf.d/default.conf
COPY LICENSE /usr/share/nginx/html/LICENSE
COPY web/docker-entrypoint.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

EXPOSE 3000
