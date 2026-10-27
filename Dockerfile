# The hosted half of Text Display: the web app only.
#
# There is deliberately no npm install here. The server is plain Node with no
# runtime dependencies - koffi is listed in package.json only for the Windows
# machine that sends the NDI feed, and nothing the server loads requires it.
# That keeps this image tiny and free of native builds.
FROM node:22-alpine

# tini reaps zombies and passes signals through, so docker stop actually stops
# the server instead of waiting out the timeout.
RUN apk add --no-cache tini

WORKDIR /app

COPY package.json ./
COPY src/ ./src/
COPY public/ ./public/

# Message history and settings live on a volume so an image rebuild never
# takes the church's data with it.
ENV TEXT_DISPLAY_DATA=/data
ENV PORT=4321

# Behind Docker every request arrives from the bridge network rather than
# loopback, so the host-only admin guard would lock everyone out, including
# the person sitting at the server. Restrict access at the network instead.
ENV TEXT_DISPLAY_ADMIN_LOCALHOST_ONLY=0

RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4321)+'/api/state',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/serve.js"]
