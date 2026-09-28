# Build context: repository root
FROM dunglas/frankenphp:1-php8.5-alpine

RUN install-php-extensions pdo_sqlite redis

WORKDIR /app
COPY api/ /app/

ENV SERVER_NAME=":9000" \
    SERVER_ROOT="/app/public"
EXPOSE 9000
