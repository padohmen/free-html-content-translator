FROM node:18-alpine
WORKDIR /app
COPY package.json ./package.json
RUN npm install --production
COPY server.js ./server.js
ENV PORT=8787
EXPOSE 8787
CMD ["npm","start"]
