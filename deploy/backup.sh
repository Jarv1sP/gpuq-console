#!/bin/sh
set -eu
umask 077
base=/opt/gpuq-console
test -f "$base/data/portal.sqlite"
mkdir -p "$base/backups"
chmod 700 "$base/backups"
name="portal-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
sqlite3 "$base/data/portal.sqlite" ".backup '$base/backups/$name'"
test "$(sqlite3 "$base/backups/$name" 'PRAGMA integrity_check;')" = ok
# Restore this private key together with the DB to display current invite codes.
if test -f "$base/data/portal.sqlite.invite-key"; then
  # Use the backup's current mtime; preserving the original key's old mtime
  # would incorrectly prune even newly-created copies after 14 days.
  cp "$base/data/portal.sqlite.invite-key" "$base/backups/$name.invite-key"
fi
find "$base/backups" -maxdepth 1 -type f -name 'portal-*.sqlite' -mtime +14 -delete
find "$base/backups" -maxdepth 1 -type f -name 'portal-*.sqlite.invite-key' -mtime +14 -delete
