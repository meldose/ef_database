FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
COPY public ./public
COPY integrations ./integrations
COPY infrastructure ./infrastructure
COPY migrations ./migrations
COPY scripts ./scripts

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    PORT=3000 \
    ALTEGRO_PERSISTENCE=true \
    ALTEGRO_PERSISTENCE_DRIVER=postgres \
    OBJECT_STORAGE_DRIVER=s3 \
    ALTEGRO_SYNC_MODE=async

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
