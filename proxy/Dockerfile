# proxy/Dockerfile  — CommonJS, zonder host package.json
FROM node:18-alpine

WORKDIR /app

# Maak minimale package.json en installeer prod-deps
RUN npm init -y \
 && npm pkg set type=commonjs \
 && npm install express cors axios body-parser --production

# Kopieer alléén je server-bestand en noem het .cjs (forceert CommonJS)
COPY server.js ./server.cjs

ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "server.cjs"]
