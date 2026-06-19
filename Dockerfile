FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && apk add --no-cache tini

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && apk del .build-deps

COPY src ./src

# Build provenance — injected by the GitHub Actions build (build-and-push.yml).
# Surfaced at GET /api/health and /api/health/version so the frontend can verify
# exactly which build is live without shell access to the host.
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
