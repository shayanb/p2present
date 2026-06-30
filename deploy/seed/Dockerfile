# deploy/seed/Dockerfile — WebTorrent seeder.
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
# Install only production deps (webtorrent). No package-lock is committed; pin
# via the ^range in package.json or add a lockfile for reproducible builds.
RUN npm install --omit=dev --no-audit --no-fund

COPY server.mjs ./

ENV NODE_ENV=production
EXPOSE 8091 6881
USER node
CMD ["node", "server.mjs"]
