# STITCH exhibition submissions — one file of Node builtins. No package.json, so
# no install step and nothing from npm in the image.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./

# The volume mounts here. Made in the image and owned by `node`, so a fresh
# named volume starts out writable by the process.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8081 9091
CMD ["node", "server.mjs"]
