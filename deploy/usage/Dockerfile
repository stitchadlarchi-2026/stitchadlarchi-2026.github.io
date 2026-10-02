# STITCH usage counters — one file of Node builtins. No package.json, so no
# install step and nothing from npm in the image.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./

USER node
EXPOSE 8080 9090
CMD ["node", "server.mjs"]
