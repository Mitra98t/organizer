# Organizer: quick commands. `make` alone shows the list.
# Destructive commands ask for confirmation; to skip it: CONFIRM=1 (e.g. `make demo CONFIRM=1`).

COMPOSE     ?= docker compose
DATA_VOLUME := organizer_organizer-data
NODE        := node --disable-warning=ExperimentalWarning
APP_PORT    ?= 8080

.DEFAULT_GOAL := help
.PHONY: help up down restart logs ps https wait reset demo seed backup backup-auto backup-schedule backup-unschedule backup-log restore \
        users invite workspaces reset-password make-admin mail-helper mail-helper-uninstall feedback cli cli-uninstall tunnel tunnel-off tunnel-status shell info test dev dev-reset dev-demo confirm

help: ## Shows this list
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ---------- Docker ----------
up: ## Builds and starts the app (http://localhost:8080)
	$(COMPOSE) up -d --build app
	@$(MAKE) --no-print-directory wait
	@echo "Organizer ready at http://localhost:$(APP_PORT)"

down: ## Stops all the containers, tunnel included (the data stays)
	$(COMPOSE) --profile https --profile tunnel down

restart: ## Restarts the app
	$(COMPOSE) restart app
	@$(MAKE) --no-print-directory wait

logs: ## Follows the app's logs
	$(COMPOSE) logs -f --tail=100 app

ps: ## Containers' status
	$(COMPOSE) --profile https --profile tunnel ps

https: ## Also starts Caddy with HTTPS (SITE_ADDRESS=... for an IP or a domain)
	$(COMPOSE) --profile https up -d --build
	@$(MAKE) --no-print-directory wait
	@echo "Organizer ready at https://$${SITE_ADDRESS:-localhost}"

wait:
	@printf 'Waiting for the server'; \
	for i in $$(seq 1 40); do \
	  if $(COMPOSE) exec -T app wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1; then echo ' ok'; exit 0; fi; \
	  printf '.'; sleep 1; \
	done; echo ' timeout'; $(COMPOSE) logs --tail=30 app; exit 1

# ---------- data ----------
reset: confirm ## DELETES all the data (database and files) and starts from scratch
	$(COMPOSE) rm -sf app
	-docker volume rm $(DATA_VOLUME)
	@$(MAKE) --no-print-directory up

demo: reset ## Starts from scratch and loads the demo data (login demo / demo1234)
	@$(MAKE) --no-print-directory seed

seed: ## Loads the demo data without deleting anything (FORCE=1 if there is data already)
	$(COMPOSE) exec -T app $(NODE) server/demo.js $(if $(FORCE),--force)
	@echo "Reload the page in the browser to see it."

feedback: ## Exports the open feedback to feedback/ (ALL=1 also the resolved ones): text and screenshots
	@rm -rf feedback
	$(COMPOSE) exec -T app node --disable-warning=ExperimentalWarning server/feedback-export.js /tmp/feedback-export $(if $(ALL),--all,)
	@$(COMPOSE) cp app:/tmp/feedback-export ./feedback >/dev/null && echo "Open feedback/ (one folder per feedback, feedback.md + images)"

backup: ## Saves database and uploaded files in backups/ (stops the app for a few seconds)
	@mkdir -p backups
	$(COMPOSE) stop app
	@f=backups/organizer-$$(date +%Y%m%d-%H%M%S).tgz; \
	docker run --rm -v $(DATA_VOLUME):/data:ro alpine tar czf - -C /data . > $$f \
	  && echo "Backup saved in $$f ($$(du -h $$f | cut -f1))"; \
	$(COMPOSE) start app
	@$(MAKE) --no-print-directory wait

backup-auto: ## Backup without stopping the app; keeps the 2 most recent automatic ones (what the schedule runs)
	@./scripts/backup.sh

backup-schedule: ## Automatic backups at 01:00 and 13:00 (macOS launchd; elsewhere it prints the crontab line)
	@./scripts/backup-schedule.sh on

backup-unschedule: ## Turns the automatic backups off (the files already made stay)
	@./scripts/backup-schedule.sh off

backup-log: ## The last lines of the automatic backups' log
	@./scripts/backup-schedule.sh log

restore: confirm ## Restores a backup: make restore FILE=backups/organizer-....tgz
	@test -f "$(FILE)" || { echo "Usage: make restore FILE=backups/organizer-YYYYMMDD-HHMMSS.tgz"; exit 1; }
	$(COMPOSE) stop app
	docker run --rm -i -v $(DATA_VOLUME):/data alpine \
	  sh -c 'find /data -mindepth 1 -delete && tar xzf - -C /data && chown -R 1000:1000 /data' < "$(FILE)"
	$(COMPOSE) start app
	@$(MAKE) --no-print-directory wait

# ---------- users ----------
users: ## Lists the users
	$(COMPOSE) exec -T app $(NODE) server/cli.js users

invite: ## Invite code (7 days) for a workspace: make invite [WS=2] (default: the first one)
	$(COMPOSE) exec -T app $(NODE) server/cli.js invite $(WS)

workspaces: ## Lists the workspaces
	$(COMPOSE) exec -T app $(NODE) server/cli.js workspaces

reset-password: ## New password for a user: make reset-password NAME=marco
	@test -n "$(NAME)" || { echo "Usage: make reset-password NAME=username"; exit 1; }
	$(COMPOSE) exec -T app $(NODE) server/cli.js reset-password $(NAME)

make-admin: ## Makes someone admin of a workspace: make make-admin NAME=marco [WS=2]
	@test -n "$(NAME)" || { echo "Usage: make make-admin NAME=username [WS=id]"; exit 1; }
	$(COMPOSE) exec -T app $(NODE) server/cli.js make-admin $(NAME) $(WS)

# ---------- access from outside (Cloudflare Tunnel, no open ports) ----------
tunnel: ## Access from the internet with your domain via Cloudflare Tunnel (token in .env, see docs/DEPLOY.md)
	@grep -qs '^TUNNEL_TOKEN=.' .env || { echo "TUNNEL_TOKEN is missing in the .env file: see docs/DEPLOY.md"; exit 1; }
	$(COMPOSE) --profile tunnel up -d tunnel
	@sleep 4; $(COMPOSE) --profile tunnel logs --tail=8 tunnel

tunnel-off: ## Turns the tunnel off: the app stays reachable only from this computer
	$(COMPOSE) --profile tunnel stop tunnel

tunnel-status: ## The tunnel's status and the last lines of its log
	@$(COMPOSE) --profile tunnel ps tunnel
	@$(COMPOSE) --profile tunnel logs --tail=20 tunnel

# ---------- mail ----------
mail-helper: ## Installs the helper that opens mails in Thunderbird with the attachments (macOS/Linux)
	tools/install-mail-helper.sh

mail-helper-uninstall: ## Removes the Thunderbird helper
	tools/install-mail-helper.sh --uninstall

# ---------- terminal ----------
cli: ## Installs the `org` command (CLI, needs Node 22 on the computer); then: org login http://localhost:8080
	npm install --global ./cli
	@echo "Done: try  org help"

cli-uninstall: ## Removes the `org` command
	npm uninstall --global organizer-cli

shell: ## Shell inside the container
	$(COMPOSE) exec app sh

info: ## Addresses the app can be reached at
	@echo "Local:   http://localhost:$(APP_PORT)"
	@if grep -qs '^APP_BIND=0.0.0.0' .env; then \
	  ip=$$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | cut -d' ' -f1); \
	  [ -n "$$ip" ] && echo "LAN:     http://$$ip:$(APP_PORT)"; \
	else echo "LAN:     closed (this computer only; APP_BIND=0.0.0.0 in .env to open it)"; fi
	@$(COMPOSE) --profile tunnel ps --status running tunnel 2>/dev/null | grep -q tunnel \
	  && echo "Outside: Cloudflare tunnel on (the address is the public hostname chosen on Cloudflare)" \
	  || echo "Outside: tunnel off (make tunnel)"

# ---------- local development (without Docker, data in ./data) ----------
test: ## Runs the tests
	npm test

dev: ## Starts locally with automatic restart (port 8080, data in ./data)
	DATA_DIR=data PORT=$(APP_PORT) npm run dev

dev-reset: confirm ## DELETES the local data in ./data
	rm -rf data

dev-demo: dev-reset ## Local data from scratch with the demo data (then: make dev)
	DATA_DIR=data $(NODE) server/demo.js

confirm:
	@if [ "$(CONFIRM)" != "1" ]; then \
	  printf 'This deletes data. Type "yes" to continue: '; read ans; \
	  [ "$$ans" = "yes" ] || { echo "Cancelled."; exit 1; }; \
	fi
