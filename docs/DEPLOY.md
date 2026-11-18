# Access from outside (and moving to a Raspberry Pi)

Goal: reach Organizer from anywhere with your own domain (e.g. `https://organizer.example.com`), with valid HTTPS and **no open ports**: neither on the router nor on the local network.

How it works: the app listens only on the computer that hosts it (`127.0.0.1:8080`). Next to it runs `cloudflared` (the `tunnel` service in `docker-compose.yml`), which opens an **outgoing** connection to Cloudflare; requests for your domain reach Cloudflare and go through that connection. From the internet your address is not visible and there is nothing listening to reach. Cloudflare manages the HTTPS certificate.

It works the same on a Mac today and on a Raspberry Pi tomorrow: only the place where Docker runs changes.

## 1. The domain on Cloudflare (once)

1. Create a free account on cloudflare.com.
2. **Add a domain** → your domain → **Free** plan.
3. Cloudflare shows you two nameservers: set them in the dashboard of the registrar where you bought the domain (instead of the current ones). If the domain already has records (website, mail), Cloudflare imports them: check they are all there before changing the nameservers.
4. Wait until Cloudflare says the domain is **active** (usually minutes, sometimes a few hours).

## 2. The tunnel

1. Cloudflare dashboard → **Zero Trust** → **Networks** → **Tunnels** → **Create a tunnel** → type **Cloudflared** → a name, e.g. `organizer`.
2. On the installation page pick **Docker**: the command it shows contains `--token …`. Copy only the token (the long string after `--token`).
3. In the project folder, on the computer that hosts the app, create (or open) the `.env` file and add a line:

   ```
   TUNNEL_TOKEN=the-copied-token
   ```

   `.env` is excluded from git: the token does not end up in the repository. The token lets whoever has it run your tunnel: keep it like a password.
4. Start the tunnel:

   ```bash
   make tunnel
   ```

   Lines saying "Registered tunnel connection" must show up in the log. In the dashboard the tunnel becomes **Healthy**.
5. Still in the tunnel → **Public Hostname** → **Add a public hostname**:
   - Subdomain: `organizer` (or whatever you prefer); Domain: your domain
   - Service: **HTTP**, URL: `app:8080`

   (`app` is the name of the app's container in the Docker network: the tunnel reaches it from inside.)
6. Open `https://organizer.example.com`: it is Organizer, with the padlock.

7. **Browser cache**: Cloudflare → your domain → *Caching* → *Configuration* → **Browser Cache TTL** → *Respect Existing Headers*. Otherwise Cloudflare tells the browser to keep JS and CSS for 4 hours, and after an update the first opening would use the old code (the installed app checks again by itself anyway).

Useful commands: `make tunnel-status` (status and log), `make tunnel-off` (turns off access from outside), `make info`.

## 3. Afterwards

- **Phone**: open the new address, sign in and install the app (iPhone: Safari → Share → "Add to Home Screen"; Android: Chrome → "Install app"). If you had installed it from another address (e.g. a Tailscale one), remove it and install this one.
- **CLI**: `org login https://organizer.example.com`.
- **Thunderbird**: the extension downloaded from the new address is already set up for it; the old helper works by itself with the address you open the app from.
- **At home**: from the phone on Wi-Fi you use the domain address too. The app is no longer reachable at `http://COMPUTER-IP:8080`; if you need it, `APP_BIND=0.0.0.0` in `.env` and `make up` open it on the local network again (it is an open port on the LAN).

## A Mac as the server

- The app is reachable only while the Mac is on and **not asleep**: System Settings → Battery / Energy → prevent automatic sleep (with the power adapter connected), or keep `caffeinate -s` open in a terminal.
- Docker Desktop must start by itself: Docker settings → *Start Docker Desktop when you sign in*. Tunnel and app restart by themselves with Docker.
- Cloudflare limit (Free plan): a single upload goes through up to 100 MB. Bigger files can be uploaded from the host itself at `http://localhost:8080`.

## Security: what protects what

- **No open ports**: the tunnel is outgoing; the app listens only on `127.0.0.1`.
- **HTTPS** always, with Cloudflare's certificate; the browser remembers to use only HTTPS (HSTS).
- **Access to the app**: user and password (scrypt), sign-up only with an invite, a limit of 10 wrong attempts every 15 minutes per address and user (behind the tunnel the real address counts, from `CF-Connecting-IP`). Every login, failed attempt, block and token is written in the **access log** (Settings → Access for whoever runs the instance, `make access` from the terminal), with address, country (`CF-IPCountry`) and browser; a block sends a notification. Sessions with `HttpOnly`, `Secure`, `SameSite=Lax` cookies; revocable API tokens; permissions per area.
- **Extra (optional)**: Cloudflare **Access** (Zero Trust → Access → Applications) puts a second sign-in in front of the app (code by email, Google…). Careful: it also blocks the CLI, bots and the Thunderbird extension, which use the API without going through that page; if you turn it on, create a rule that lets `/api/` through or use Cloudflare service tokens for those programs.
- **Before exposing a new installation** (e.g. the Raspberry Pi): bring the data over first (section below). On an empty installation the first-start page creates the admin for whoever arrives first.

## Backup

The disk of the computer that hosts the app is the only copy of the data: run `make backup` regularly (it creates `backups/organizer-….tgz` with the database and the files) and copy those archives somewhere else (another disk, a cloud).

## Later: moving to a Raspberry Pi

1. Raspberry Pi 4/5 (4 GB are enough), official power supply, external disk (better an SSD), network cable. Raspberry Pi OS Lite 64-bit written with Raspberry Pi Imager, SSH on.
2. On the Raspberry Pi: Docker, the disk mounted at boot (e.g. `/mnt/organizer`) with the app's data on it, the project from GitHub.
3. The move: `make backup` on the old host → copy the archive to the Raspberry Pi → `make restore FILE=…` there → try it locally.
4. The same `.env` with the same `TUNNEL_TOKEN` on the Raspberry Pi, `make tunnel` there and `make tunnel-off` on the old host: the domain moves to the Raspberry Pi without touching Cloudflare.
