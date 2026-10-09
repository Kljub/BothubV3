#!/bin/sh
# Migrates the database, shares the data files with the bot, then starts FrankenPHP (image default entrypoint).
set -e
# Encryption at rest: a plain database (older install) is encrypted first.
php /app/bin/encrypt-db.php
php /app/bin/migrate.php
php /app/bin/share-data.php
exec docker-php-entrypoint "$@"
