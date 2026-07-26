FROM node:22.22.0-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY templates ./templates

RUN chmod 0755 /app/bin/ao.js \
    && mkdir -p /data \
    && chown -R node:node /app /data

ENV AO_BIND=0.0.0.0 \
    AO_PORT=7331 \
    AO_DATABASE_PATH=/data/ao.sqlite \
    NODE_ENV=production

VOLUME ["/data"]
EXPOSE 7331

USER node
CMD ["node", "src/server.js"]
