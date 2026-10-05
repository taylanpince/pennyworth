# syntax=docker/dockerfile:1
FROM node:24.14.1-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.14.1-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /state && chown 1000:100 /state
# Holds the Slack user token (rotating) in /state, mounted from the secrets dir.
USER 1000:1000
EXPOSE 8082
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8082/healthz').then(r=>process.exit(r.status<600?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/src/main.js"]
