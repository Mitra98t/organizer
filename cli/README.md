# org: Organizer dal terminale

Un eseguibile a sé (`org`) che parla con il server tramite le [API pubbliche](../docs/API.md). Serve Node 22 sul computer, nessuna dipendenza.

```bash
make cli                                # dalla cartella del progetto: installa il comando org
org login http://localhost:8080         # utente e password → token salvato in ~/.config/organizer/cli.json
org help                                # tutti i comandi;  org COMANDO --help  per le opzioni
```

`org login` crea un token chiamato "cli <nome del computer>", che si vede (e si revoca) dall'app in Impostazioni → *CLI e token API*. `org logout` lo revoca. In alternativa: `org login URL --token org_…` con un token creato dall'app.

## Esempi

Il testo delle voci usa la sintassi della barra rapida. Nella shell va tra **apici singoli** (`!` e `#` hanno un significato per zsh e bash), oppure si lancia `org add` senza testo e lo si scrive al prompt.

```bash
org add 'flash fw 2.3.1 #SCH-042 @rover !ven +marco'
org add -p rover -d 3g controllare ripple       # le opzioni al posto dei token
cat lista.txt | org add                         # una voce per riga
org add --parent 12 'compilare con gcc 13'      # sotto-attività

org ls                     # todo e mail aperte, per scadenza
org ls -p rover --late     # del progetto (e sottoprogetti), scadute o di oggi
org ls --mine --mail       # le mail che toccano a me
org ls --note -p rover     # il diario del progetto
org show 12                # tutto: note, storico, sotto-attività, allegati
org done 12 13
org due 12 lun             # oppure 3g, 25/11, fm, no
org log 12 'il jumper J3 era aperto, slitta !mer'
org edit 12                # titolo e note in $EDITOR
org mv 12 13 serra-iot     # sposta in un altro progetto
org assign 12 marco

org proj                                   # albero dei progetti con le voci aperte
org proj add Firmware motori --in rover    # sottoprogetto
org proj mv firmware-motori -              # di nuovo al primo livello
org proj set rover -s paused --color 210

org item scheda                            # magazzino, filtrato
org item show SCH-042
org item add SCH-060 scheda relè -c scheda -l B4 -q 3
org item mv SCH-060 SCH-061 relè           # cambia categoria
org item link PRD-ROVER-1 SCH-060          # composizione

org doc up SCH-060 fw_1.1.bin -V 1.1       # tipo dedotto: firmware (aggiorna la versione dell'articolo)
org doc up SCH-060 relay.kicad_mod         # → footprint
org doc up SCH-060 *.pdf -k datasheet
org doc link SCH-060 https://…/relay.pdf -k datasheet --label 'Datasheet relè'
org doc SCH-060                            # documenti dell'articolo
org doc get 7 -o ~/Downloads
org doc open 7                             # con il visualizzatore di sistema
org doc notes 7                            # le note scritte sul PDF, per pagina (--all anche le risolte)
org doc rename 7 G5V datasheet
org doc kinds --add gerber                 # nuovo tipo di documento

org mail new 'invio firmware #SCH-060 >acquisti@pcbfab.example @rover'
org mail edit 22                           # A, Cc, Oggetto e testo in $EDITOR
org mail attach 22 report.pdf --doc 7      # file dal computer o documenti del magazzino
org mail send 22 --done                    # aperta in Thunderbird con gli allegati (make mail-helper)
org mail eml 22                            # oppure come .eml
org mail replied 22                        # la risposta è arrivata: esce da "in attesa di risposta"

org chat                                   # ultimi messaggi della chat del workspace
org chat -f                                # e resta in ascolto
org chat send 'flashate le #SCH-042 di @rover, +marco tocca a te'

org search jtag
org trash ; org restore entry 12
```

## Script

- `--json` su ogni comando di lettura: `org ls --late --json | jq -r '.[].title'`.
- `-w ID` per un solo comando su un altro workspace; `org ws NOME` per cambiare quello predefinito della CLI.
- Variabili d'ambiente al posto della configurazione: `ORGANIZER_URL`, `ORGANIZER_TOKEN`, `ORGANIZER_WS`.
- Login non interattivo: `echo "$PW" | org login URL -u fede --password-stdin`.
- `org api GET /sync`, `org api PATCH /entries/12 '{"done":true}'`: qualunque endpoint, con il token già pronto.
- Exit code 1 in caso di errore; i messaggi vanno su stderr.
- Certificato self-signed (Caddy in LAN): `NODE_EXTRA_CA_CERTS=/percorso/root.crt org …`.

`NO_COLOR=1` toglie i colori; `VISUAL`/`EDITOR` scelgono l'editor.
