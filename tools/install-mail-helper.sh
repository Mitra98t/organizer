#!/usr/bin/env bash
# Registra lo schema organizer-mail:// così il pulsante "Manda" apre Thunderbird con gli allegati.
#   tools/install-mail-helper.sh              installa per l'utente corrente (macOS o Linux)
#   tools/install-mail-helper.sh --uninstall  rimuove
# APP_DIR e NO_REGISTER=1 servono solo per provarlo senza toccare il sistema.
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
    echo "Rimosso $app"
    exit 0
  fi
  mkdir -p "$(dirname "$app")"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  # Un'app AppleScript minima: riceve il link e lo passa allo script bash nelle sue Resources.
  cat > "$tmp/handler.applescript" <<'APPLESCRIPT'
on open location theURL
	set helper to (POSIX path of (path to me)) & "Contents/Resources/organizer-mail.sh"
	do shell script "/bin/bash " & quoted form of helper & " " & quoted form of theURL & " > /dev/null 2>&1 &"
end open location

on run
	display dialog "Organizer Mail apre in Thunderbird le mail preparate in Organizer. Non serve avviarlo a mano." buttons {"OK"} default button 1 with title "Organizer Mail"
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
  # Info.plist modificato: la firma ad-hoc di osacompile va rifatta, altrimenti macOS rifiuta l'app.
  codesign --force --deep --sign - "$app" >/dev/null 2>&1
  [[ "${NO_REGISTER:-0}" == 1 ]] || "$lsregister" -f "$app"
  echo "Installato $app"
  ;;
Linux)
  bin="$HOME/.local/bin/organizer-mail"
  desktop="$HOME/.local/share/applications/organizer-mail.desktop"
  if [[ "$action" == --uninstall ]]; then
    rm -f "$bin" "$desktop"
    command -v update-desktop-database >/dev/null && update-desktop-database "$(dirname "$desktop")" || true
    echo "Rimosso"
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
  echo "Installato $bin"
  ;;
*)
  echo "Sistema non supportato: su Windows o telefono usa \"Apri con app mail\" o \"Scarica .eml\"." >&2
  exit 1
  ;;
esac

echo "Ora in Organizer: Impostazioni → Mail → spunta \"Helper Thunderbird installato su questo computer\"."
echo "La prima volta il browser chiede il permesso di aprire Organizer Mail: consenti e ricorda la scelta."
