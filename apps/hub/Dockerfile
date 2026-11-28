# Build context: repository root (see docker-compose.yml).
FROM node:22-alpine AS web
WORKDIR /web
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web/ ./
RUN npm run build

FROM node:22-alpine AS hub
WORKDIR /hub
COPY apps/hub/package.json apps/hub/package-lock.json ./
RUN npm ci
COPY apps/hub/ ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# ffmpeg converts voice messages recorded in the browser to each service's voice note format.
RUN apk add --no-cache ffmpeg
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIR=/app/web \
    MIGRATIONS_DIR=/app/migrations \
    ATTACHMENTS_DIR=/data/attachments
COPY --from=hub /hub/node_modules ./node_modules
COPY --from=hub /hub/dist ./dist
COPY --from=hub /hub/package.json ./
COPY apps/hub/migrations ./migrations
COPY --from=web /web/dist ./web
# Pre-create the volume path so a fresh named volume is writable by the node user.
RUN mkdir -p /data/attachments && chown -R node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:8080/api/auth/me >/dev/null || exit 1
CMD ["node", "dist/index.js"]
