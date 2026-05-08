FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && apk add --no-cache tini

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && apk del .build-deps

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
