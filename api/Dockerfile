# Build context: repository root
FROM dunglas/frankenphp:1-php8.5-alpine

RUN install-php-extensions pdo_sqlite redis pcntl zip
# Bodies: plugin zips arrive base64 in JSON (max. 5 MB -> 8M); plugin webhooks
# (Plex) may send a small file with the form, which PHP parses before index.php.
RUN printf 'post_max_size=16M\nupload_max_filesize=3M\nmax_file_uploads=2\n' > "$PHP_INI_DIR/conf.d/bothub-limits.ini"

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
