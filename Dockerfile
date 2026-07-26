FROM node:22.22.0-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY scripts ./scripts
COPY templates ./templates

RUN chmod 0755 /app/bin/ao.js /app/scripts/*.mjs \
    && mkdir -p /var/lib/agents-chat-room \
    && chown -R node:node /app /var/lib/agents-chat-room

ENV AO_BIND=0.0.0.0 \
    AO_PORT=7331 \
    AO_DATABASE_PATH=/var/lib/agents-chat-room/ao.sqlite \
    NODE_ENV=production

EXPOSE 7331

USER node
CMD ["node", "src/server.js"]
