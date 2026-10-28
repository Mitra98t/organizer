# Organizer: comandi rapidi. `make` da solo mostra l'elenco.
# I comandi distruttivi chiedono conferma; per saltarla: CONFIRM=1 (es. `make demo CONFIRM=1`).

COMPOSE     ?= docker compose
DATA_VOLUME := organizer_organizer-data
NODE        := node --disable-warning=ExperimentalWarning
APP_PORT    ?= 8080

.DEFAULT_GOAL := help
.PHONY: help up down restart logs ps https wait reset demo seed backup restore \
        users invite workspaces reset-password make-admin mail-helper mail-helper-uninstall cli cli-uninstall tunnel tunnel-off tunnel-status shell info test dev dev-reset dev-demo confirm

help: ## Mostra questo elenco
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ---------- Docker ----------
up: ## Costruisce e avvia l'app (http://localhost:8080)
	$(COMPOSE) up -d --build app
	@$(MAKE) --no-print-directory wait
	@echo "Organizer pronto su http://localhost:$(APP_PORT)"

down: ## Ferma tutti i container, tunnel compreso (i dati restano)
	$(COMPOSE) --profile https --profile tunnel down

restart: ## Riavvia l'app
	$(COMPOSE) restart app
	@$(MAKE) --no-print-directory wait

logs: ## Segue i log dell'app
	$(COMPOSE) logs -f --tail=100 app

ps: ## Stato dei container
	$(COMPOSE) --profile https --profile tunnel ps

https: ## Avvia anche Caddy in HTTPS (SITE_ADDRESS=... per IP o dominio)
	$(COMPOSE) --profile https up -d --build
	@$(MAKE) --no-print-directory wait
	@echo "Organizer pronto su https://$${SITE_ADDRESS:-localhost}"

wait:
	@printf 'Attendo il server'; \
	for i in $$(seq 1 40); do \
	  if $(COMPOSE) exec -T app wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1; then echo ' ok'; exit 0; fi; \
	  printf '.'; sleep 1; \
	done; echo ' timeout'; $(COMPOSE) logs --tail=30 app; exit 1

# ---------- dati ----------
reset: confirm ## CANCELLA tutti i dati (database e file) e riparte da zero
	$(COMPOSE) rm -sf app
	-docker volume rm $(DATA_VOLUME)
	@$(MAKE) --no-print-directory up

demo: reset ## Riparte da zero e carica i dati demo (login demo / demo1234)
	@$(MAKE) --no-print-directory seed

seed: ## Carica i dati demo senza cancellare nulla (FORCE=1 se ci sono già dati)
	$(COMPOSE) exec -T app $(NODE) server/demo.js $(if $(FORCE),--force)
	@echo "Ricarica la pagina nel browser per vederli."

backup: ## Salva database e file caricati in backups/ (ferma l'app per qualche secondo)
	@mkdir -p backups
	$(COMPOSE) stop app
	@f=backups/organizer-$$(date +%Y%m%d-%H%M%S).tgz; \
	docker run --rm -v $(DATA_VOLUME):/data:ro alpine tar czf - -C /data . > $$f \
	  && echo "Backup salvato in $$f ($$(du -h $$f | cut -f1))"; \
	$(COMPOSE) start app
	@$(MAKE) --no-print-directory wait

restore: confirm ## Ripristina un backup: make restore FILE=backups/organizer-....tgz
	@test -f "$(FILE)" || { echo "Uso: make restore FILE=backups/organizer-AAAAMMGG-HHMMSS.tgz"; exit 1; }
	$(COMPOSE) stop app
	docker run --rm -i -v $(DATA_VOLUME):/data alpine \
	  sh -c 'find /data -mindepth 1 -delete && tar xzf - -C /data && chown -R 1000:1000 /data' < "$(FILE)"
	$(COMPOSE) start app
	@$(MAKE) --no-print-directory wait

# ---------- utenti ----------
users: ## Elenca gli utenti
	$(COMPOSE) exec -T app $(NODE) server/cli.js users

invite: ## Codice invito (7 giorni) per un workspace: make invite [WS=2] (predefinito: il primo)
	$(COMPOSE) exec -T app $(NODE) server/cli.js invite $(WS)

workspaces: ## Elenca i workspace
	$(COMPOSE) exec -T app $(NODE) server/cli.js workspaces

reset-password: ## Nuova password per un utente: make reset-password UTENTE=marco
	@test -n "$(UTENTE)" || { echo "Uso: make reset-password UTENTE=nome"; exit 1; }
	$(COMPOSE) exec -T app $(NODE) server/cli.js reset-password $(UTENTE)

make-admin: ## Rende admin di un workspace: make make-admin UTENTE=marco [WS=2]
	@test -n "$(UTENTE)" || { echo "Uso: make make-admin UTENTE=nome [WS=id]"; exit 1; }
	$(COMPOSE) exec -T app $(NODE) server/cli.js make-admin $(UTENTE) $(WS)

# ---------- accesso da fuori casa (Cloudflare Tunnel, nessuna porta aperta) ----------
tunnel: ## Accesso da internet con il tuo dominio via Cloudflare Tunnel (token in .env, vedi docs/DEPLOY.md)
	@grep -qs '^TUNNEL_TOKEN=.' .env || { echo "Manca TUNNEL_TOKEN nel file .env: vedi docs/DEPLOY.md"; exit 1; }
	$(COMPOSE) --profile tunnel up -d tunnel
	@sleep 4; $(COMPOSE) --profile tunnel logs --tail=8 tunnel

tunnel-off: ## Spegne il tunnel: l'app resta raggiungibile solo da questo computer
	$(COMPOSE) --profile tunnel stop tunnel

tunnel-status: ## Stato del tunnel e ultime righe del suo log
	@$(COMPOSE) --profile tunnel ps tunnel
	@$(COMPOSE) --profile tunnel logs --tail=20 tunnel

# ---------- mail ----------
mail-helper: ## Installa l'helper che apre le mail in Thunderbird con gli allegati (macOS/Linux)
	tools/install-mail-helper.sh

mail-helper-uninstall: ## Rimuove l'helper Thunderbird
	tools/install-mail-helper.sh --uninstall

# ---------- terminale ----------
cli: ## Installa il comando `org` (CLI, serve Node 22 sul computer); poi: org login http://localhost:8080
	npm install --global ./cli
	@echo "Fatto: prova con  org help"

cli-uninstall: ## Rimuove il comando `org`
	npm uninstall --global organizer-cli

shell: ## Shell dentro il container
	$(COMPOSE) exec app sh

info: ## Indirizzi a cui raggiungere l'app
	@echo "Locale: http://localhost:$(APP_PORT)"
	@if grep -qs '^APP_BIND=0.0.0.0' .env; then \
	  ip=$$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | cut -d' ' -f1); \
	  [ -n "$$ip" ] && echo "LAN:    http://$$ip:$(APP_PORT)"; \
	else echo "LAN:    chiusa (solo questo computer; APP_BIND=0.0.0.0 in .env per aprirla)"; fi
	@$(COMPOSE) --profile tunnel ps --status running tunnel 2>/dev/null | grep -q tunnel \
	  && echo "Da fuori: tunnel Cloudflare attivo (l'indirizzo è il public hostname scelto su Cloudflare)" \
	  || echo "Da fuori: tunnel spento (make tunnel)"

# ---------- sviluppo locale (senza Docker, dati in ./data) ----------
test: ## Esegue i test
	npm test

dev: ## Avvia in locale con riavvio automatico (porta 8080, dati in ./data)
	DATA_DIR=data PORT=$(APP_PORT) npm run dev

dev-reset: confirm ## CANCELLA i dati locali in ./data
	rm -rf data

dev-demo: dev-reset ## Dati locali da zero con i dati demo (poi: make dev)
	DATA_DIR=data $(NODE) server/demo.js

confirm:
	@if [ "$(CONFIRM)" != "1" ]; then \
	  printf 'Questa operazione cancella dati. Scrivi "si" per continuare: '; read ans; \
	  [ "$$ans" = "si" ] || { echo "Annullato."; exit 1; }; \
	fi
