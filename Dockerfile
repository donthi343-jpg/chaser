FROM node:22-alpine
WORKDIR /app
COPY . .
ENV NODE_ENV=production DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
