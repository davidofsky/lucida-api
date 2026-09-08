FROM node:22-bookworm-slim

WORKDIR /app

# The system libs cloakbrowser's Chromium needs.
COPY package.json package-lock.json ./
RUN npm ci \
  && npx playwright-core install-deps chromium \
  && rm -rf /var/lib/apt/lists/*

COPY . .
RUN npm run build

# cloakbrowser downloads its Chromium into the home cache on first launch; keep it writable.
# (Only chown the cache dir — a recursive chown of /app/node_modules is huge and needless;
# the node user just needs to read the app, which root-owned files already allow.)
RUN mkdir -p /home/node/.cloakbrowser && chown node:node /home/node/.cloakbrowser
USER node

ENV NODE_ENV=production
# The server binds 127.0.0.1 by default, which is unreachable from outside the container.
ENV HOST=0.0.0.0
EXPOSE 3000

# start-period covers the Chromium download plus the Cloudflare challenge solve at boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
