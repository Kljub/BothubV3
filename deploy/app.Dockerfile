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

# SQLite with encryption (SQLite3 Multiple Ciphers, SQLCipher 4 format): built
# as libsqlite3.so.0 for pdo_sqlite. Same SQLite version as the bot's
# better-sqlite3-multiple-ciphers.
FROM dunglas/frankenphp:1-php8.5-alpine AS sqlite3mc
RUN apk add --no-cache build-base curl unzip
RUN curl -fsSL -o /tmp/mc.zip https://github.com/utelle/SQLite3MultipleCiphers/releases/download/v2.5.1/sqlite3mc-2.5.1-sqlite-3.53.4-amalgamation.zip  && echo "4125f8ff275ea953dabb3289331b20a0e76d4fc060f57148f4a5df3bf3b0d5e0  /tmp/mc.zip" | sha256sum -c -  && mkdir /tmp/mc && cd /tmp/mc && unzip -q /tmp/mc.zip  && gcc -O2 -fPIC -shared -DSQLITE_THREADSAFE=1 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_RTREE       -DSQLITE_ENABLE_MATH_FUNCTIONS -DSQLITE_ENABLE_DBSTAT_VTAB -o /tmp/libsqlite3.so.0 sqlite3mc_amalgamation.c -lm -lpthread

FROM dunglas/frankenphp:1-php8.5-alpine
RUN install-php-extensions pdo_sqlite redis pcntl zip \
 && apk add --no-cache bash
# Bodies: plugin zips arrive base64 in JSON (max. 5 MB -> 8M); plugin webhooks
# (Plex) may send a small file with the form, which PHP parses before index.php.
RUN printf 'post_max_size=16M\nupload_max_filesize=3M\nmax_file_uploads=2\n' > "$PHP_INI_DIR/conf.d/bothub-limits.ini"

COPY --from=sqlite3mc /tmp/libsqlite3.so.0 /tmp/libsqlite3.so.0
RUN cp /tmp/libsqlite3.so.0 "$(readlink -f /usr/lib/libsqlite3.so.0)" && rm /tmp/libsqlite3.so.0  && php -r '$p = new PDO("sqlite::memory:"); $p->exec("PRAGMA cipher = \"sqlcipher\""); exit($p->query("PRAGMA cipher")->fetchColumn() === "sqlcipher" ? 0 : 1);'

WORKDIR /app
COPY api/ /app/
COPY shared/ /shared/
COPY --from=go /out/bothub-dashboard /out/bothub-gateway /usr/local/bin/
COPY deploy/start-app.sh /usr/local/bin/start-app
RUN chmod +x /app/bin/entrypoint.sh /usr/local/bin/start-app

# The API listens on localhost only: the gateway in this container is its only client.
ENV SERVER_NAME=":9000" \
    CADDY_SERVER_EXTRA_DIRECTIVES="bind 127.0.0.1" \
    KEYS_DIR="/keys" \
    SERVER_ROOT="/app/public" \
    SHARED_DIR="/shared"
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/start-app"]
