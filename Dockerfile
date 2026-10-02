# STITCH — a static exhibition site served by nginx.
#
# The site content is baked into the image rather than bind-mounted, so the
# running container and the commit it came from are the same artifact. That is
# what makes `nch-deploy rollback` mean something: it restores an image ID, and
# the image carries the page.
FROM nginx:1.29-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

# Copy the whole repository, then strip the infrastructure back out. Copying the
# repo wholesale is deliberate: Breeze adds pages and assets without touching
# this file, and a Dockerfile that names each file by hand would quietly stop
# shipping her work the day she adds a second one.
COPY . /usr/share/nginx/html/
RUN rm -rf /usr/share/nginx/html/deploy \
           /usr/share/nginx/html/Dockerfile \
           /usr/share/nginx/html/compose.yaml \
           /usr/share/nginx/html/.dockerignore \
           /usr/share/nginx/html/.gitignore \
           /usr/share/nginx/html/.env.example \
 && test -f /usr/share/nginx/html/index.html

# The usage beacon nginx adds to each page. It sits outside the document root
# so the strip above cannot remove it, and nginx serves it at /_u.js.
COPY deploy/usage/beacon.js /usr/share/nginx/beacon.js

EXPOSE 80
