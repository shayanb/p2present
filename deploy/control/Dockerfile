# deploy/control/Dockerfile — p2present control API (zero npm deps; Node built-ins).
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY server.mjs ./

# No dependencies to install — uses only Node ≥ 20 globals (fetch/FormData/Blob).
ENV NODE_ENV=production
EXPOSE 8090
USER node
CMD ["node", "server.mjs"]
