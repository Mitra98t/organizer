#!/bin/sh
# Automatic backup (make backup-schedule: at 01:00 and 13:00): a consistent copy of the data, taken while the app keeps
# running, saved on this computer in backups/ (outside Docker: it survives a Docker reset). Only the KEEP most recent
# automatic backups are kept (default 2); the manual ones (make backup) are never touched.
# A backup much smaller than the previous one (an empty database after a reset, say) is kept, but the older ones are
# not removed: the good copies are not lost.
set -eu
cd "$(dirname "$0")/.."
KEEP=${KEEP:-2}
COMPOSE=${COMPOSE:-docker compose}
stamp() { date '+%Y-%m-%d %H:%M:%S'; }

mkdir -p backups
f="backups/organizer-auto-$(date +%Y%m%d-%H%M%S).tgz"
tmp="$f.part"
trap 'rm -f "$tmp"' EXIT

if ! $COMPOSE exec -T app sh -c 'node --disable-warning=ExperimentalWarning server/snapshot.js /tmp/backup && tar czhf - -C /tmp/backup .; s=$?; rm -rf /tmp/backup; exit $s' > "$tmp"; then
  echo "$(stamp) backup failed (is the app running?), the old ones are kept" >&2
  exit 1
fi
# Only a complete archive goes in the folder.
if ! tar tzf "$tmp" | grep -qx './accounts.db'; then
  echo "$(stamp) backup incomplete, the old ones are kept" >&2
  exit 1
fi

# The largest automatic backup there is: a new one less than half of it removes nothing (also on the following runs,
# until the data is back or the old files are removed by hand).
largest=0
for old in backups/organizer-auto-*.tgz; do
  [ -f "$old" ] || continue
  n=$(wc -c < "$old" | tr -d ' ')
  [ "$n" -gt "$largest" ] && largest=$n
done
mv "$tmp" "$f"
chflags uchg "$f" 2>/dev/null || true # locked (macOS): rm and the Finder do not delete it by mistake
size=$(wc -c < "$f" | tr -d ' ')
echo "$(stamp) saved $f ($(du -h "$f" | cut -f1))"

if [ "$size" -lt $((largest / 2)) ]; then
  echo "$(stamp) less than half of the largest automatic backup: none removed, check the data" >&2
  exit 0
fi
ls -1 backups/organizer-auto-*.tgz | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  chflags nouchg "$old" 2>/dev/null || true
  rm -f -- "$old"
  echo "$(stamp) removed $old"
done
