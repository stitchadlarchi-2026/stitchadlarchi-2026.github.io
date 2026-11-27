# STITCH exhibition submissions — Node builtins only. No package.json, so no
# install step and nothing from npm in the image.
FROM node:22-alpine

WORKDIR /app
COPY server.mjs metadata.mjs r2.mjs zip.mjs console.mjs ./
COPY console ./console

# The volumes mount here: /data for records and headshots (backed up nightly),
# /files for posters and booklets. Made in the image and owned by `node`, so
# fresh named volumes start out writable by the process.
RUN mkdir -p /data /files && chown node:node /data /files
VOLUME /data /files

USER node
EXPOSE 8081 9091 9092
CMD ["node", "server.mjs"]
