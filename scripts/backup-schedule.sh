#!/bin/sh
# Automatic backups (scripts/backup.sh) at 01:00 and 13:00.
#   scripts/backup-schedule.sh on    turns them on (macOS: a launchd agent; elsewhere it prints the crontab line)
#   scripts/backup-schedule.sh off   turns them off (the backups already made stay)
#   scripts/backup-schedule.sh log   the last lines of the log
# On macOS a time missed while the Mac sleeps is made up when it wakes.
set -eu
cd "$(dirname "$0")/.."
DIR=$(pwd)
AGENT=local.organizer.backup
PLIST="$HOME/Library/LaunchAgents/$AGENT.plist"
LOG="$HOME/Library/Logs/organizer-backup.log"

case "${1:-}" in
on)
  if [ "$(uname)" != Darwin ]; then
    echo "Not macOS: add this line with crontab -e"
    echo "0 1,13 * * * cd $DIR && ./scripts/backup.sh >> \$HOME/organizer-backup.log 2>&1"
    exit 0
  fi
  docker_dir=$(dirname "$(command -v docker)")
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AGENT</string>
  <key>ProgramArguments</key><array><string>$DIR/scripts/backup.sh</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$docker_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>1</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>13</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$AGENT" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Automatic backups on: at 01:00 and 13:00 in backups/ (the 2 most recent are kept). Log: $LOG"
  ;;
off)
  launchctl bootout "gui/$(id -u)/$AGENT" 2>/dev/null || true
  [ -f "$PLIST" ] && rm -- "$PLIST"
  echo "Automatic backups off (the files in backups/ stay)."
  ;;
log)
  tail -n 20 "$LOG" 2>/dev/null || echo "No automatic backup yet."
  ;;
*)
  echo "Usage: $0 on|off|log"
  exit 1
  ;;
esac
