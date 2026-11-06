#!/usr/bin/env bash
# Registers the organizer-mail:// scheme so the "Send" button opens Thunderbird with the attachments.
#   tools/install-mail-helper.sh              installs for the current user (macOS or Linux)
#   tools/install-mail-helper.sh --uninstall  removes it
# APP_DIR and NO_REGISTER=1 are only for trying it without touching the system.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
helper="$here/organizer-mail.sh"
action="${1:-install}"

case "$(uname -s)" in
Darwin)
  app="${APP_DIR:-$HOME/Applications}/Organizer Mail.app"
  lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
  if [[ "$action" == --uninstall ]]; then
    [[ -d "$app" ]] && { "$lsregister" -u "$app" 2>/dev/null || true; rm -rf "$app"; }
    echo "Removed $app"
    exit 0
  fi
  mkdir -p "$(dirname "$app")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  # A minimal AppleScript app: it receives the link and passes it to the bash script in its Resources.
  cat > "$tmp/handler.applescript" <<'APPLESCRIPT'
on open location theURL
	set helper to (POSIX path of (path to me)) & "Contents/Resources/organizer-mail.sh"
	do shell script "/bin/bash " & quoted form of helper & " " & quoted form of theURL & " > /dev/null 2>&1 &"
end open location

on run
	display dialog "Organizer Mail opens in Thunderbird the mails prepared in Organizer. There is no need to start it by hand." buttons {"OK"} default button 1 with title "Organizer Mail"
end run
APPLESCRIPT
  rm -rf "$app"
  osacompile -o "$app" "$tmp/handler.applescript"
  install -m 755 "$helper" "$app/Contents/Resources/organizer-mail.sh"
  plist="$app/Contents/Info.plist"
  pb() { /usr/libexec/PlistBuddy -c "$1" "$plist" >/dev/null 2>&1 || true; }
  pb "Delete :CFBundleIdentifier"
  pb "Add :CFBundleIdentifier string it.organizer.mail"
  pb "Add :LSUIElement bool true"
  pb "Delete :CFBundleURLTypes"
  /usr/libexec/PlistBuddy \
    -c "Add :CFBundleURLTypes array" \
    -c "Add :CFBundleURLTypes:0 dict" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLName string Organizer Mail" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" \
    -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string organizer-mail" \
    "$plist"
  # Info.plist changed: osacompile's ad-hoc signature must be redone, otherwise macOS refuses the app.
  codesign --force --deep --sign - "$app" >/dev/null 2>&1
  [[ "${NO_REGISTER:-0}" == 1 ]] || "$lsregister" -f "$app"
  echo "Installed $app"
  ;;
Linux)
  bin="$HOME/.local/bin/organizer-mail"
  desktop="$HOME/.local/share/applications/organizer-mail.desktop"
  if [[ "$action" == --uninstall ]]; then
    rm -f "$bin" "$desktop"
    command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$desktop")" || true
    echo "Removed"
    exit 0
  fi
  install -Dm755 "$helper" "$bin"
  mkdir -p "$(dirname "$desktop")"
  cat > "$desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Organizer Mail
Exec=$bin %u
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/organizer-mail;
DESKTOP
  command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$desktop")" || true
  xdg-mime default organizer-mail.desktop x-scheme-handler/organizer-mail
  echo "Installed $bin"
  ;;
*)
  echo "System not supported: on Windows or a phone use the default mail app or the \".eml\" button." >&2
  exit 1
  ;;
esac

echo "Now in Organizer: Settings → Mail and Thunderbird → Without the extension → tick \"Helper installed on this computer\"."
echo "The first time the browser asks for permission to open Organizer Mail: allow it and remember the choice."
