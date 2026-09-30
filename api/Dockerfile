# Build context: repository root
FROM dunglas/frankenphp:1-php8.5-alpine

RUN install-php-extensions pdo_sqlite redis pcntl

WORKDIR /app
COPY api/ /app/
# Node definitions, event catalog, schema version: shared with dashboard and bot.
COPY shared/ /shared/
RUN chmod +x /app/bin/entrypoint.sh

ENV SERVER_NAME=":9000" \
    SERVER_ROOT="/app/public" \
    SHARED_DIR="/shared"
EXPOSE 9000

ENTRYPOINT ["/app/bin/entrypoint.sh"]
CMD ["--config", "/etc/frankenphp/Caddyfile", "--adapter", "caddyfile"]
