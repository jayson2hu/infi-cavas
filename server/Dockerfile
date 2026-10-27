FROM oven/bun:1.3.14
WORKDIR /app/server
COPY server/package.json server/bun.lock ./
RUN bun install --frozen-lockfile
COPY server ./
COPY shared /app/shared
COPY specs /app/specs
COPY LICENSE /app/LICENSE
EXPOSE 8787
CMD ["bun", "run", "start"]
