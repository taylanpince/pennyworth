# syntax=docker/dockerfile:1
FROM node:24.22.3-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
ARG BOARD_NAME=Pennyworth
ARG BOARD_ICON=/icon.png
ARG BOARD_APP_ID=/
RUN BOARD_NAME="$BOARD_NAME" BOARD_ICON="$BOARD_ICON" BOARD_APP_ID="$BOARD_APP_ID" npm run build && npm prune --omit=dev

FROM node:24.22.3-bookworm-slim
ENV NODE_ENV=production
# pdftotext: attached PDFs get a text version the agents can read (D-43).
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Bucket/rank state lives in /data/board (mounted).
USER 1000:1000
EXPOSE 3120
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3120/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/src/main.js"]
