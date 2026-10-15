FROM node:24-alpine

ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
WORKDIR /app

RUN apk add --no-cache su-exec
COPY package.json server.mjs ./
COPY index.html about.html contact.html robots.txt sitemap.xml ./
COPY careers ./careers
COPY assets ./assets
RUN mkdir -p /data && chown -R node:node /app /data

EXPOSE 3000
CMD ["/bin/sh", "-c", "mkdir -p \"$DATA_DIR\" && chown node:node \"$DATA_DIR\" && exec su-exec node node server.mjs"]
