FROM node:22-alpine

WORKDIR /app

# O projeto nao tem dependencias: nada de npm install.
COPY package.json ./
COPY server.js auth.js health.js ./
COPY public ./public

ENV PORT=8090 \
    HOST=0.0.0.0 \
    NODE_ENV=production

# catalogo, EPG, usuarios e sessoes ficam aqui (monte um volume)
VOLUME ["/app/.cache"]

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:8090/health || exit 1

CMD ["node", "server.js"]
