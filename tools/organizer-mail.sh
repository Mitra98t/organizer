#!/usr/bin/env bash
# Apre in Thunderbird una mail preparata in Organizer, con destinatari, oggetto, testo e allegati.
# Il sistema lo invoca con un link del tipo:
#   organizer-mail://open?server=https%3A%2F%2Fmac.tailnet.ts.net%2F&token=XXXX
# Installazione: make mail-helper  (registra lo schema organizer-mail:// su macOS o Linux)
#
# Variabili utili: THUNDERBIRD=/percorso/thunderbird   ORGANIZER_INSECURE=1 (certificati self-signed)
set -euo pipefail

cache="${XDG_CACHE_HOME:-$HOME/.cache}/organizer-mail"
mkdir -p "$cache"
logfile="$cache/helper.log"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$logfile"; }
notify() {
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"${1//\"/\'}\" with title \"Organizer Mail\"" >/dev/null 2>&1 || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "Organizer Mail" "$1" || true
  fi
}
die() { log "ERRORE: $*"; notify "$*"; exit 1; }
urldecode() { local s="${1//+/ }"; printf '%b' "${s//%/\\x}"; }

url="${1:-}"
[[ "$url" == organizer-mail://* ]] || die "link non valido: $url"
log "ricevuto $url"

server=""; token=""
IFS='&' read -ra pairs <<< "${url#*\?}"
for kv in "${pairs[@]}"; do
  case "${kv%%=*}" in
    server) server="$(urldecode "${kv#*=}")" ;;
    token) token="${kv#*=}" ;;
  esac
done
[[ "$server" =~ ^https?://[^[:space:]]+$ ]] || die "indirizzo del server non valido"
[[ "$token" =~ ^[A-Za-z0-9_-]{16,}$ ]] || die "token non valido"
server="${server%/}"

curl_opts=(-fsS --max-time 300)
[[ "${ORGANIZER_INSECURE:-0}" == 1 ]] && curl_opts+=(-k)

# Pulizia delle mail aperte nei giorni precedenti (Thunderbird copia gli allegati quando si invia).
find "$cache" -mindepth 1 -maxdepth 1 -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true
dir="$cache/$token"
rm -rf "$dir"
mkdir -p "$dir"

fetch() { curl "${curl_opts[@]}" "$server/api/mailpkg/$token/$1" -o "$2" || die "download fallito ($1) da $server"; }
fetch manifest "$dir/manifest"
fetch body "$dir/body.html"

to=""; cc=""; subject=""; attachments=""
while IFS=$'\t' read -r key a b; do
  case "$key" in
    TO) to="$a" ;;
    CC) cc="$a" ;;
    SUBJECT) subject="$a" ;;
    ATTACH)
      [[ "$a" =~ ^[0-9]+$ && "$b" =~ ^[A-Za-z0-9._()+-]+$ ]] || die "allegato non valido: $b"
      fetch "file/$a" "$dir/$b"
      attachments+="${attachments:+,}file://$dir/$b"
      ;;
  esac
done < "$dir/manifest"

compose="to='$to',cc='$cc',subject='$subject',message='$dir/body.html'"
[[ -n "$attachments" ]] && compose+=",attachment='$attachments'"

tb=()
if [[ -n "${THUNDERBIRD:-}" ]]; then
  tb=("$THUNDERBIRD")
else
  for c in /Applications/Thunderbird.app/Contents/MacOS/thunderbird \
           "$HOME/Applications/Thunderbird.app/Contents/MacOS/thunderbird" \
           "$(command -v thunderbird 2>/dev/null || true)" \
           "$(command -v thunderbird-esr 2>/dev/null || true)"; do
    if [[ -n "$c" && -x "$c" ]]; then tb=("$c"); break; fi
  done
  if [[ ${#tb[@]} -eq 0 ]] && command -v flatpak >/dev/null 2>&1 && flatpak info org.mozilla.Thunderbird >/dev/null 2>&1; then
    tb=(flatpak run org.mozilla.Thunderbird)
  fi
fi
[[ ${#tb[@]} -gt 0 ]] || die "Thunderbird non trovato (imposta THUNDERBIRD=/percorso/thunderbird)"

log "apro ${tb[*]} -compose $compose"
# Se Thunderbird è già aperto, la nuova istanza passa la richiesta a quella esistente.
nohup "${tb[@]}" -compose "$compose" >> "$logfile" 2>&1 &
