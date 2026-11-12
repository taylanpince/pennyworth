FROM node:24.14.1-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY src ./src
USER 1000:1000
CMD ["node","--disable-warning=ExperimentalWarning","src/main.mjs"]
