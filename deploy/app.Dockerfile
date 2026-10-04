# Build context: repository root.
# The "app" container: Go dashboard, Go gateway (sign-in, sessions, access),
# PHP API (FrankenPHP) and the outbox relay, started by deploy/start-app.sh.
# Bot core and Redis run in their own containers.

FROM golang:1.27-alpine AS go
WORKDIR /src
COPY dashboard/go.mod dashboard/go.sum ./
RUN go mod download
COPY dashboard/ ./
COPY shared/ /shared/
ENV SHARED_DIR=/shared
RUN go test ./... \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/bothub-dashboard ./cmd/dashboard \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/bothub-gateway ./cmd/mockapi

FROM dunglas/frankenphp:1-php8.5-alpine
RUN install-php-extensions pdo_sqlite redis pcntl zip \
 && apk add --no-cache bash
# Bodies: plugin zips arrive base64 in JSON (max. 5 MB -> 8M); plugin webhooks
# (Plex) may send a small file with the form, which PHP parses before index.php.
RUN printf 'post_max_size=16M\nupload_max_filesize=3M\nmax_file_uploads=2\n' > "$PHP_INI_DIR/conf.d/bothub-limits.ini"

WORKDIR /app
COPY api/ /app/
COPY shared/ /shared/
COPY --from=go /out/bothub-dashboard /out/bothub-gateway /usr/local/bin/
COPY deploy/start-app.sh /usr/local/bin/start-app
RUN chmod +x /app/bin/entrypoint.sh /usr/local/bin/start-app

ENV SERVER_NAME=":9000" \
    SERVER_ROOT="/app/public" \
    SHARED_DIR="/shared"
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/start-app"]
