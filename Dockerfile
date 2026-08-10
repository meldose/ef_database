FROM node:22-alpine

WORKDIR /app
COPY package.json server.js ./
COPY public ./public
COPY integrations ./integrations

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    PORT=3000 \
    ALTEGRO_PERSISTENCE=true \
    ALTEGRO_DATA_FILE=/app/data/altegro-state.json

EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
