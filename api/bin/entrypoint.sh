#!/bin/sh
# Migrates the database, shares the data files with the bot, then starts FrankenPHP (image default entrypoint).
set -e
php /app/bin/migrate.php
php /app/bin/share-data.php
exec docker-php-entrypoint "$@"
