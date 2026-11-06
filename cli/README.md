# org: Organizer from the terminal

A standalone executable (`org`) that talks to the server through the [public API](../docs/API.md). It needs Node 22 on the computer, no dependencies.

```bash
make cli                                # from the project folder: installs the org command
org login http://localhost:8080         # user and password → token saved in ~/.config/organizer/cli.json
org help                                # all the commands;  org COMMAND --help  for the options
```

`org login` creates a token called "cli <computer name>", which shows up (and can be revoked) in the app in Settings → *CLI and tokens*. `org logout` revokes it. Alternatively: `org login URL --token org_…` with a token created in the app.

**Language**: English, or Italian with `ORG_LANG=it` (or an Italian system locale, e.g. `LANG=it_IT.UTF-8`). The server's error messages follow the same language.

## Examples

The text of entries uses the quick bar syntax. In the shell it goes between **single quotes** (`!` and `#` mean something to zsh and bash), or run `org add` without text and type it at the prompt.

```bash
org add 'flash fw 2.3.1 #SCH-042 @rover !fri +marco'
org add -p rover -d 3d check ripple            # options instead of tokens
cat list.txt | org add                         # one entry per line
org add --parent 12 'build with gcc 13'        # subtask

org ls                     # open todos and mails, by due date
org ls -p rover --late     # of the project (and subprojects), overdue or due today
org ls --mine --mail       # the mails that are up to me
org ls --note -p rover     # the project's journal
org show 12                # everything: notes, history, subtasks, attachments
org done 12 13
org due 12 mon             # or 3d, 25/11, eom, none
org log 12 'jumper J3 was open, postponed !wed'
org edit 12                # title and notes in $EDITOR
org mv 12 13 greenhouse-iot # moves to another project
org assign 12 marco

org proj                                   # project tree with the open entries
org proj add Motor firmware --in rover     # subproject
org proj mv motor-firmware -               # back to the top level
org proj set rover -s paused --color 210

org item board                             # inventory, filtered
org item show SCH-042
org item add SCH-060 relay board -c board -l B4 -q 3
org item mv SCH-060 SCH-061 relay          # changes category
org item link PRD-ROVER-1 SCH-060          # composition
org item alias SCH-060 G5V-1-DC5           # alternative code (--rm to remove it)

org doc up SCH-060 fw_1.1.bin -V 1.1       # kind guessed: firmware (updates the item's version)
org doc up SCH-060 relay.kicad_mod         # → footprint
org doc up SCH-060 *.pdf -k datasheet
org doc link SCH-060 https://…/relay.pdf -k datasheet --label 'Relay datasheet'
org doc SCH-060                            # the item's documents
org doc get 7 -o ~/Downloads
org doc open 7                             # with the system viewer
org doc notes 7                            # the notes written on the PDF, by page (--all also the resolved ones)
org doc rename 7 G5V datasheet
org doc mv 7 SCH-061                       # to another item, with the notes (cp: a copy)
org doc kinds --add gerber                 # new document kind

org mail new 'send firmware #SCH-060 >purchasing@pcbfab.example @rover'
org mail edit 22                           # To, Cc, Subject and text in $EDITOR
org mail attach 22 report.pdf --doc 7      # files from the computer or inventory documents
org mail send 22 --done                    # opened in Thunderbird with the attachments (make mail-helper)
org mail eml 22                            # or as .eml
org mail replied 22                        # the reply arrived: it leaves "awaiting reply"

org chat                                   # latest messages of the workspace chat
org chat -f                                # and keep listening
org chat send 'flashed the #SCH-042 of @rover, +marco your turn'

org search jtag
org trash ; org restore entry 12
```

The built-in document kinds are `firmware`, `datasheet`, `schematic`, `footprint`, `manual`, `photo` and `other` (the Italian names `schema`, `manuale`, `foto` and `altro` work too).

## Scripts

- `--json` on every reading command: `org ls --late --json | jq -r '.[].title'`.
- `-w ID` for a single command on another workspace; `org ws NAME` to change the CLI's default one.
- Environment variables instead of the configuration: `ORGANIZER_URL`, `ORGANIZER_TOKEN`, `ORGANIZER_WS`.
- Non-interactive login: `echo "$PW" | org login URL -u fede --password-stdin`.
- `org api GET /sync`, `org api PATCH /entries/12 '{"done":true}'`: any endpoint, with the token ready.
- Exit code 1 on error; messages go to stderr.
- Self-signed certificate (Caddy on the LAN): `NODE_EXTRA_CA_CERTS=/path/to/root.crt org …`.

`NO_COLOR=1` removes the colours; `VISUAL`/`EDITOR` choose the editor.
