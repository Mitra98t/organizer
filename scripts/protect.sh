#!/bin/sh
# Locks (macOS "Locked", chflags uchg) what must not be deleted by mistake: the folder that holds the data
# (ORGANIZER_DATA in .env: its parent, because SQLite must be able to create files in the data folder itself), the
# backups and .env. The Finder refuses to trash them ("is locked"), rm and mv answer "Operation not permitted".
# No password: whoever owns them unlocks them with `make unprotect` (or Finder → Get Info → Locked).
#   scripts/protect.sh on | off
set -eu
cd "$(dirname "$0")/.."
command -v chflags >/dev/null || { echo "chflags is only on macOS: on Linux use sudo chattr +i on the same files."; exit 1; }
case "${1:-}" in
on) flag=uchg; what="Locked" ;;
off) flag=nouchg; what="Unlocked" ;;
*) echo "Usage: $0 on|off"; exit 1 ;;
esac

data=$(sed -n 's/^ORGANIZER_DATA=//p' .env 2>/dev/null | tail -n 1)
if [ -n "$data" ]; then
  holder=$(dirname "$data")
  # Only a folder made for the data: never the root of the computer or of a disk, nor the home folder.
  if [ "$holder" = / ] || [ "$holder" = /Volumes ] || [ "$(dirname "$holder")" = /Volumes ] || [ "$holder" = "$HOME" ]; then
    holder=
  fi
  if [ -n "$holder" ] && [ -d "$holder" ]; then
    chflags "$flag" "$holder" && echo "$what $holder (the folder that holds the data)"
  else
    echo "Data folder not locked: put it inside a folder of its own (e.g. /Volumes/disk/organizer-data/data)."
  fi
fi
n=0
for f in backups/*.tgz; do
  [ -f "$f" ] || continue
  chflags "$flag" "$f" && n=$((n + 1))
done
echo "$what $n backups in backups/"
[ -f .env ] && chflags "$flag" .env && echo "$what .env"
[ "$1" = on ] && echo "To change .env afterwards: make unprotect, change it, make protect."
exit 0
