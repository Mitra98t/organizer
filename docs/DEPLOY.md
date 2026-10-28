# Accesso da fuori casa (e trasloco sul Raspberry)

Obiettivo: raggiungere Organizer da ovunque con il tuo dominio (es. `https://organizer.tuodominio.it`), con HTTPS valido e **nessuna porta aperta**: né sul router, né in rete locale.

Come funziona: l'app ascolta solo sul computer che la ospita (`127.0.0.1:8080`). Accanto gira `cloudflared` (servizio `tunnel` del `docker-compose.yml`), che apre una connessione **in uscita** verso Cloudflare; le richieste per il tuo dominio arrivano a Cloudflare e passano da quella connessione. Da internet non si vede il tuo indirizzo e non c'è niente in ascolto da raggiungere. Il certificato HTTPS lo gestisce Cloudflare.

Vale uguale oggi sul Mac e domani sul Raspberry: cambia solo dove gira Docker.

## 1. Il dominio su Cloudflare (una volta)

1. Crea un account gratuito su cloudflare.com.
2. **Add a domain** → il tuo dominio → piano **Free**.
3. Cloudflare ti mostra due nameserver: impostali nel pannello del registrar dove hai comprato il dominio (al posto di quelli attuali). Se il dominio ha già record (sito, mail), Cloudflare li importa: controlla che ci siano tutti prima di cambiare i nameserver.
4. Aspetta che Cloudflare dica che il dominio è **attivo** (di solito minuti, a volte qualche ora).

## 2. Il tunnel

1. Pannello Cloudflare → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** → tipo **Cloudflared** → nome, es. `organizer`.
2. Nella pagina di installazione scegli **Docker**: nel comando che ti mostra c'è `--token …`. Copia solo il token (la stringa lunga dopo `--token`).
3. Nella cartella del progetto, sul computer che ospita l'app, crea (o apri) il file `.env` e aggiungi una riga:

   ```
   TUNNEL_TOKEN=il-token-copiato
   ```

   `.env` è escluso da git: il token non finisce nel repository. Il token dà a chi lo ha la possibilità di far girare il tuo tunnel: tienilo come una password.
4. Avvia il tunnel:

   ```bash
   make tunnel
   ```

   Nel log devono comparire righe "Registered tunnel connection". Nel pannello il tunnel diventa **Healthy**.
5. Sempre nel tunnel → **Public Hostname** → **Add a public hostname**:
   - Subdomain: `organizer` (o quello che preferisci); Domain: il tuo dominio
   - Service: **HTTP**, URL: `app:8080`

   (`app` è il nome del container dell'app nella rete di Docker: il tunnel la raggiunge da dentro.)
6. Apri `https://organizer.tuodominio.it`: è Organizer, con il lucchetto.

7. **Cache del browser**: Cloudflare → il tuo dominio → *Caching* → *Configuration* → **Browser Cache TTL** → *Respect Existing Headers*. Altrimenti Cloudflare dice al browser di tenere JS e CSS 4 ore e dopo un aggiornamento la prima apertura userebbe il codice vecchio (l'app installata si ricontrolla comunque da sola).

Comandi utili: `make tunnel-status` (stato e log), `make tunnel-off` (spegne l'accesso da fuori), `make info`.

## 3. Dopo

- **Telefono**: apri l'indirizzo nuovo, accedi e installa l'app (iPhone: Safari → Condividi → "Aggiungi alla schermata Home"; Android: Chrome → "Installa app"). Se avevi installato quella con l'indirizzo di Tailscale, eliminala e reinstalla questa.
- **CLI**: `org login https://organizer.tuodominio.it`.
- **Helper Thunderbird**: funziona da solo con l'indirizzo da cui apri l'app.
- **Tailscale**: quando il nuovo indirizzo funziona, smetti di pubblicare l'app su Tailscale con `tailscale serve reset` (o dall'app di Tailscale), poi puoi disinstallarlo.
- **In casa**: anche dal telefono in Wi-Fi usi l'indirizzo con il dominio. L'app non è più raggiungibile su `http://IP-DEL-MAC:8080`; se ti serve, `APP_BIND=0.0.0.0` in `.env` e `make up` la riapre in rete locale (è una porta aperta in LAN).

## Il Mac come server, per ora

- L'app è raggiungibile solo quando il Mac è acceso e **non in stop**: Impostazioni di Sistema → Batteria / Energia → impedisci lo stop automatico (con alimentatore collegato), oppure lascia aperto `caffeinate -s` in un terminale.
- Docker Desktop deve partire da solo: Impostazioni di Docker → *Start Docker Desktop when you sign in*. Tunnel e app ripartono da soli con Docker.
- Limite di Cloudflare (piano Free): un singolo caricamento passa fino a 100 MB. File più grandi si caricano dal Mac stesso su `http://localhost:8080`.

## Sicurezza: cosa protegge cosa

- **Nessuna porta aperta**: il tunnel è in uscita; l'app ascolta solo su `127.0.0.1`.
- **HTTPS** sempre, con certificato di Cloudflare; il browser ricorda di usare solo HTTPS (HSTS).
- **Accesso all'app**: utente e password (scrypt), registrazione solo con invito, limite di 10 tentativi sbagliati ogni 15 minuti per indirizzo e utente (dietro il tunnel conta l'indirizzo vero, da `CF-Connecting-IP`). Sessioni con cookie `HttpOnly`, `Secure`, `SameSite=Lax`; token API revocabili; permessi per area.
- **In più (facoltativo)**: Cloudflare **Access** (Zero Trust → Access → Applications) mette davanti all'app un secondo accesso (codice via email, Google…). Attenzione: blocca anche la CLI, i bot e l'helper di Thunderbird, che usano le API senza passare da quella pagina; se lo attivi, crea una regola che lasci passare `/api/` o usa i service token di Cloudflare per quei programmi.
- **Prima di esporre un'installazione nuova** (es. il Raspberry): porta prima i dati (sezione sotto). Su un'installazione vuota la pagina di primo avvio crea l'admin per chi arriva per primo.

## Backup

Il disco del computer che ospita l'app è l'unica copia dei dati: fai `make backup` regolarmente (crea `backups/organizer-….tgz` con database e file) e copia quegli archivi altrove (un altro disco, un cloud).

## Più avanti: trasloco sul Raspberry

1. Raspberry Pi 4/5 (4 GB bastano), alimentatore ufficiale, disco esterno (meglio SSD), cavo di rete. Raspberry Pi OS Lite 64 bit scritto con Raspberry Pi Imager, SSH attivo.
2. Sul Raspberry: Docker, il disco montato all'avvio (es. `/mnt/organizer`) con i dati dell'app lì sopra, il progetto da GitHub.
3. Trasloco: `make backup` sul Mac → copia dell'archivio sul Raspberry → `make restore FILE=…` lì → prova in locale.
4. Stesso `.env` con lo stesso `TUNNEL_TOKEN` sul Raspberry, `make tunnel` lì e `make tunnel-off` sul Mac: il dominio passa al Raspberry senza toccare Cloudflare.

Lo script di preparazione del Raspberry si aggiunge quando c'è l'hardware.
