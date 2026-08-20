# hitrac-api: сборка и рантайм. Контейнер живёт в /opt/hitrac рядом с Traccar
# (network host, слушает 127.0.0.1:3000, наружу отдаётся nginx-ом как api.hitrack.am/v2/).
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# openssl нужен движкам Prisma
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY package.json ./
# миграции применяются при старте: новые ht_* таблицы появляются сами, tc_* не трогаем
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
