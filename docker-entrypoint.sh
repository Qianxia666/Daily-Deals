#!/bin/sh
set -eu

DB_PATH="${DATABASE_PATH:-./data/app.db}"
DB_DIR=$(dirname "$DB_PATH")

mkdir -p "$DB_DIR"
chown -R nextjs:nodejs "$DB_DIR"

exec su-exec nextjs:nodejs "$@"
