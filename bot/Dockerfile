# Build context: repository root
FROM node:24-alpine AS build
WORKDIR /app
COPY bot/package.json bot/package-lock.json ./
RUN npm ci
COPY bot/tsconfig.json ./
COPY bot/src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY bot/package.json bot/package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/index.js"]
