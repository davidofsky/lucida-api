FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

USER node

ENV NODE_ENV=production
# The server binds 127.0.0.1 by default, which is unreachable from outside the container.
ENV HOST=0.0.0.0
EXPOSE 3000

# start-period covers the challenge solve the server waits for at boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
