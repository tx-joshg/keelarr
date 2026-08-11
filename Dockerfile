FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache docker-cli docker-cli-compose

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY README.md ./README.md
COPY docs ./docs
COPY public ./public
COPY src ./src
COPY data/.gitkeep ./data/.gitkeep

ENV NODE_ENV=production \
    STACKARR_PORT=4687 \
    STACKARR_DATA_DIR=/app/data

EXPOSE 4687

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:4687/api/health >/dev/null 2>&1 || exit 1

CMD ["npm", "start"]
