FROM node:25-alpine

WORKDIR /app

COPY index.html styles.css app.js server.js README.md explain.md ./
COPY assets ./assets

ENV NODE_ENV=production
ENV PORT=4173
ENV DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data

EXPOSE 4173

USER node

CMD ["node", "server.js"]
