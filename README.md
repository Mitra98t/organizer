# Organizer

Todo, mail da mandare, diario e magazzino (codici prodotto, schede, firmware, documenti), sincronizzati in tempo reale tra telefono, Mac, Linux e i tuoi amici.

Un'unica web app installabile (PWA): niente store, niente build native. Backend Node.js + SQLite, **zero dipendenze npm**.

## Avvio

```bash
make up
```

Apri <http://localhost:8080>: al primo accesso crei l'utente amministratore.

Per provarla subito con dei dati di esempio (cancella quelli esistenti):

```bash
make demo
```

e accedi con `demo` / `demo1234` (c'è anche `marco` / `demo1234` per vedere la collaborazione).

`make` da solo elenca tutti i comandi:

| Comando | Cosa fa |
|---|---|
| `make up` / `down` / `restart` / `logs` | gestione del container |
| `make https` | avvia anche Caddy in HTTPS |
| `make reset` | cancella tutti i dati e riparte da zero (chiede conferma) |
| `make demo` | reset + dati demo |
| `make seed` | carica i dati demo senza cancellare (`FORCE=1` se ci sono già dati) |
| `make backup` / `make restore FILE=...` | backup completo in `backups/` e ripristino |
| `make users` / `invite` / `reset-password UTENTE=x` / `make-admin UTENTE=x` | utenti |
| `make info` | indirizzi locale e LAN |
| `make dev` / `dev-demo` / `test` | sviluppo locale senza Docker (dati in `./data`) |

I comandi che cancellano chiedono di scrivere "si"; per gli script: `CONFIRM=1`.

Senza Docker e senza make (serve Node ≥ 22.13): `npm start` (dati in `./data`), oppure `npm run dev` con riavvio automatico.

## Come si usa: la barra rapida

Scrivi poche parole e premi Invio. I token fanno il resto:

| Token | Significato |
|---|---|
| `t:` `m:` `n:` | tipo: todo (predefinito), mail, nota del diario |
| `!oggi` `!domani` `!ven` `!3g` `!2s` `!1m` `!fm` `!25/11` `!2026-12-01` `!no` | scadenza (per le note: quando è successo) |
| `@rover` | progetto, creato al volo se non esiste |
| `#SCH-042` | articolo di magazzino: resta nel testo come link, creato se non esiste |
| `+marco` | assegna a un utente |
| `>acquisti@ditta.it` | destinatario della mail |

```
flash fw nuovo #SCH-042 @rover !ven
m: preventivo 50 schede >acquisti@ditta.it !domani
n: la rev B della SCH-042 vuole bootloader >= 2.3 #SCH-042
```

**Aggiornare man mano**: apri una voce e scrivi un aggiornamento ("manca il cavo JTAG, slitta !lun"). Resta lo storico con data e la scadenza si sposta, lasciando traccia di quanto è slittata. Gli stessi token funzionano modificando il titolo. Le sotto-attività nascono quando scopri che una cosa ne contiene altre.

La barra rapida tiene conto di dove sei: in un progetto le voci finiscono lì, nella scheda di un articolo vengono collegate al suo codice, in Mail e Diario cambia il tipo predefinito.

Scorciatoie da tastiera: `n` o `/` per scrivere, `Ctrl/⌘ K` per cercare.

## Magazzino

Ogni articolo ha codice, descrizione, categoria, versione firmware, posizione, quantità e note (pinout, procedura di flash…). Gli carichi documenti (firmware, datasheet, schemi, manuali, foto) o link esterni. Un file di tipo firmware con versione aggiorna da solo il campo Firmware, e per ogni file si vede lo sha256. "Composizione" collega prodotti e schede. In basso trovi tutte le voci che citano quel `#CODICE`. Se rinomini un codice, i riferimenti nel testo delle voci vengono aggiornati.

## Più persone

Impostazioni → Persone → **Crea invito**: mandi il link, chi lo apre si registra (link valido 7 giorni, una sola registrazione). Tutto è condiviso tranne le voci e i progetti marcati **privati**. Le modifiche arrivano a tutti in tempo reale.

## Telefono e altri computer

L'app è già raggiungibile in rete locale su `http://IP-DEL-MAC:8080`. Funziona, ma in HTTP semplice i browser non attivano installazione completa e modalità offline. Per averle serve HTTPS:

**Opzione consigliata: Tailscale** (gratis, funziona anche fuori casa, certificato valido)
1. Installa Tailscale sul Mac e sul telefono, stesso account.
2. Sul Mac: `tailscale serve --bg 8080`
3. Sul telefono apri `https://nome-del-mac.tuo-tailnet.ts.net` e installa l'app.

**Opzione Caddy** (HTTPS in LAN con CA interna: il telefono deve fidarsi del certificato di Caddy)
```bash
SITE_ADDRESS=192.168.1.153 docker compose --profile https up -d
```

Installazione: iPhone → Safari → Condividi → "Aggiungi alla schermata Home". Android → Chrome → "Installa app". Mac → Safari "Aggiungi al Dock" o Chrome. Linux → Chrome/Chromium.

Offline: l'app si apre con gli ultimi dati sincronizzati e le voci scritte nella barra rapida vanno in coda; partono appena torna la rete.

## Hosting futuro

Su un VPS con un dominio che punta al server:
```bash
SITE_ADDRESS=todo.miodominio.it CADDY_TLS="tls tu@mail.it" docker compose --profile https up -d
```
Caddy ottiene il certificato Let's Encrypt da solo. Puoi togliere la porta `8080` pubblica in `docker-compose.yml` (impostando `APP_PORT=127.0.0.1:8080`).

## Backup

- Solo database: Impostazioni → Backup (admin) scarica un file `.db` consistente.
- Tutto (database + file caricati): `make backup` crea `backups/organizer-AAAAMMGG-HHMMSS.tgz`
  (ferma l'app per qualche secondo così la copia di SQLite è coerente).
- Ripristino: `make restore FILE=backups/organizer-....tgz`.

## Manutenzione

```bash
make users
make reset-password UTENTE=marco
make make-admin UTENTE=marco
make invite
```

Variabili: `APP_PORT` (porta pubblicata, predefinita 8080), `MAX_UPLOAD_MB` (predefinito 200).

## Struttura

```
server/       HTTP, API REST, autenticazione, SSE (Node, solo moduli standard)
  db.js       schema SQLite e migrazioni (PRAGMA user_version)
  demo.js     dati dimostrativi (make demo / make seed)
public/       PWA senza build: HTML, CSS, moduli ES
  js/parse.js parser della barra rapida, condiviso con il server
test/         node --test
tools/        generatore icone
```

Dati: `/data/organizer.db` (SQLite, WAL) e `/data/uploads/` nel volume `organizer-data`.

Sicurezza: password con scrypt, sessioni in cookie HttpOnly (token salvati come hash), protezione CSRF tramite header obbligatorio, limite tentativi di login, file scaricati serviti con `nosniff` e CSP sandbox.
