# Build context: repository root
FROM node:24-alpine AS build
WORKDIR /app
COPY bot/package.json bot/package-lock.json ./
RUN npm ci
COPY bot/tsconfig.json ./
COPY bot/src ./src
RUN npm run build

FROM node:24-alpine
# ffmpeg decodes sound files and music streams for voice; yt-dlp finds music
# (it needs Python; YouTube's player script runs on this image's Node).
# Rebuild the image to update yt-dlp when a site stops working.
RUN apk add --no-cache ffmpeg python3 \
 && wget -q -O /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp
WORKDIR /app
ENV NODE_ENV=production \
    SHARED_DIR=/shared
COPY bot/package.json bot/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Node definitions, graph limits, event catalog, schema version.
COPY shared/ /shared/
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]
