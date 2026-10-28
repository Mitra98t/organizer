# API di Organizer

Le stesse API REST che usa l'app, aperte ai programmi esterni: la CLI (`cli/`), bot (Telegram, Matrix…), script, integrazioni. Tutto è JSON su HTTP, senza dipendenze lato client.

Versione delle API: **1** (`GET /api/info`). Il numero cambia solo se un client esistente smetterebbe di funzionare; campi nuovi nelle risposte possono arrivare in qualunque momento, quindi ignora quelli che non conosci.

## Autenticazione

Ogni programma usa un **token personale**: ha gli stessi permessi della persona che l'ha creato, in tutti i suoi workspace.

- **Dall'app**: Impostazioni → *CLI e token API* → **Crea token**. Il token (`org_…`) si vede una volta sola; da lì si vede quando è stato usato l'ultima volta e si revoca.
- **Con utente e password** (lo fa `org login`):
  ```bash
  curl -X POST http://localhost:8080/api/auth/token \
    -H 'X-Requested-With: organizer' -H 'Content-Type: application/json' \
    -d '{"username":"fede","password":"…","name":"script backup"}'
  # → {"id":3,"name":"script backup","token":"org_…","user":{…}}
  ```
  Stesso limite di tentativi del login (10 errori in 15 minuti).

Poi a ogni richiesta:

```
Authorization: Bearer org_…
X-Workspace: 2          (facoltativo)
```

- **Workspace**: ogni workspace ha i suoi dati. `X-Workspace` dice su quale lavorare (gli id da `GET /api/workspaces`); senza, vale l'ultimo usato dalla persona nell'app, che quindi può cambiare. **Un bot dovrebbe sempre mandarlo.** Un workspace di cui non si fa parte → `403`.
- Un token non valido o revocato → `401` su qualunque endpoint.
- Con il token non serve l'header `X-Requested-With`: è la protezione CSRF dell'app, che usa un cookie. Le richieste senza token (come `/api/auth/token`) invece lo devono avere.
- I token si revocano dall'app, con `DELETE /api/tokens/:id`, e tutti insieme quando un admin reimposta la password della persona. Un token non può crearne altri.

## Permessi

Ogni membro di un workspace ha un livello per area: `none` (non la vede), `read`, `write`. Aree: `voci` (todo e note), `mail`, `progetti`, `magazzino`, `documenti`, `contatti`, `chat`. Gli admin hanno sempre tutto; chi non ha impostazioni ha scrittura ovunque. Le regole (e le dipendenze: per scrivere le mail serve leggere contatti, documenti, magazzino e progetti, ecc.) stanno in `public/js/perms.js`, condiviso tra app e server.

- `/api/sync` restituisce `perms` (i tuoi; `null` = tutto) e manda solo i dati delle aree che puoi leggere; agli admin anche `memberPerms` (`{ idUtente: perms | null }`).
- Una richiesta fuori dai permessi risponde `403` con il motivo ("Non hai il permesso di modificare l'area Mail…"). Le voci appartengono all'area del loro tipo (le mail a `mail`, todo e note a `voci`).
- Senza scrittura su progetti e magazzino, `@nuovo` in una voce non crea il progetto (403) e `#NUOVO` non crea l'articolo (resta testo).
- `PATCH /api/admin/users/:id` `{ perms: { mail: "read", chat: "none", canali: "write", … } }` (solo admin; `perms: null` = accesso pieno, senza gestione dei canali): le aree non indicate restano in scrittura e le dipendenze si completano alzando ciò che serve. `canali` (gestire i canali della chat) è `none` se non indicato.

## Visibilità e condivisione

Magazzino e documenti sono di tutto il workspace. Voci, progetti, contatti e note sui documenti sono privati di chi li crea (anche per gli admin) e si condividono:
- nel testo: `+utente` (lo vede anche lui), `++utente` (lo vede e gli si assegna la voce), `+all` (tutti); valgono per `POST /api/entries`, il titolo in `PATCH /api/entries/:id`, `share: ["utente", "all"]` in `POST /api/projects` e il testo delle note sui documenti;
- `PUT /api/shares/:tipo/:id` `{users: [id…], all: true|false}` sostituisce l'elenco (solo chi l'ha creato); tipo: `entry`, `project`, `contact`, `docnote`.

`POST /api/entries` accetta anche `client_id` (generato dal client: se la voce con quel `client_id` esiste già, restituisce quella invece di crearne un'altra) e `done` (`true` o la data: la todo arriva già fatta), per le voci create offline.

In `/api/sync` ogni oggetto ha `shared_all`, e `shares` elenca `{kind, obj_id, user_id}` di ciò che vedi. Una voce la vede anche l'assegnatario, una sotto-attività chi vede la voce sopra.

## Convenzioni

- Corpo delle richieste e risposte in JSON (`Content-Type: application/json`), salvo upload e download di file.
- Errori: status HTTP e `{"error": "messaggio leggibile"}`. `400` dati non validi, `401` non autenticato, `403` non permesso, `404` non trovato (o non visibile a te), `409` conflitto (es. codice già usato), `413` troppo grande, `429` troppi tentativi.
- `204` senza corpo quando non c'è niente da restituire; le creazioni rispondono `{"id": …}`.
- Date: le scadenze sono `AAAA-MM-GG`; gli istanti sono ISO 8601 UTC (`2026-10-27T14:37:49.124Z`).
- **`today`**: dove si accettano date relative (`!domani`, `"ven"`), passa la data di oggi del tuo fuso (`"today": "2026-10-27"`), altrimenti vale quella del server.
- Eliminare sposta nel **cestino** (recuperabile per 30 giorni, vedi sotto).

## Leggere

| | |
|---|---|
| `GET /api/info` | `{app, version, api}`, senza autenticazione |
| `GET /api/me` | account, workspace attivo (`id`, `name`, `role`) ed elenco dei workspace |
| `GET /api/workspaces` | i tuoi workspace: `[{id, name, role}]` |
| `GET /api/sync` | **tutti i dati del workspace** in una risposta (sotto) |
| `GET /api/entries/:id` | una voce con `projects`, `items`, `logs`, `subtasks`, `attachments`; anche se archiviata |
| `GET /api/archive?q=testo` | voci fatte da più di 30 giorni (fino a 200), filtrate per testo |
| `GET /api/trash` | contenuto del cestino |
| `GET /api/events` | notifiche in tempo reale (Server-Sent Events) |

`/api/sync` restituisce: `me`, `users` (`member: 1` per i membri attuali), `workspace`, `workspaces`, `projects`, `entries` (aperte e fatte negli ultimi 30 giorni), `logs`, `entryItems`, `entryProjects` (progetti oltre al principale `project_id`), `items`, `itemAliases` (codici alternativi: `item_id`, `code`), `itemLinks` (composizione `parent_id` → `child_id`), `projectItems`, `docs`, `contacts`, `categoryColors`, `docNotes`, `attachments`, `chat` (ultimi 100 messaggi), `chatReadId`, `chatUnread`, `trashCount`, `rev`. Supporta `ETag`/`If-None-Match` (→ `304` se non è cambiato niente).

`/api/events` manda un evento `change` (`data: {"rev": …, "by": idUtente}`) a ogni modifica nel workspace e un commento `: ping` ogni 25 secondi. Il modo semplice per reagire: a ogni `change`, rileggere `/api/sync` (con l'ETag).

## Collegamenti

In qualunque testo (titoli, note, aggiornamenti, testo delle mail, appunti, chat) si collega qualcosa con un token:

| token | collega |
|---|---|
| `[[voce:ID]]` | una voce (todo, mail o nota) |
| `[[doc:ID]]` | un documento |
| `[[progetto:ID]]` | un progetto (senza aggiungere la voce al progetto, come farebbe `@tag` nel titolo) |
| `[[contatto:ID]]` | un contatto |
| `#CODICE` | un articolo di magazzino |

L'app li mostra come link con il nome attuale; nelle mail mandate (`.eml`, helper Thunderbird) diventano il nome in testo semplice. Nel testo di una mail un codice di magazzino scritto senza `#` conta come collegamento all'articolo.

`GET /api/backlinks/:tipo/:id` (tipo: `voce`, `doc`, `progetto`, `contatto`, `articolo`): le voci che collegano l'elemento, anche archiviate, con `id`, `kind`, `title`, `due`, `done_at`, `contact`, `mail_subject`, `project_id`, `parent_id`, `updated_at`. Una mail con `done_at` è mandata, senza è da mandare. Oltre ai token contano: per un articolo `#CODICE` nelle voci; per un documento gli allegati delle mail; per un contatto le mail al suo indirizzo.

## Voci (todo, mail, note)

Una voce ha `kind` (`todo`, `mail`, `note`), `title`, `notes`, `due`, `done_at`, `project_id` (principale), `parent_id` (sotto-attività), `assignee_id`, `contact`, `mail_cc`, `mail_subject`, `pinned`, `private`.

**`POST /api/entries`**: si crea dal testo, con la sintassi della barra rapida, che il server interpreta:

```json
{ "text": "flash fw 2.3.1 #SCH-042 @rover !ven +marco", "today": "2026-10-27" }
```

| token | significato |
|---|---|
| `t:` `m:` `n:` all'inizio | tipo (predefinito: `kind` della richiesta, altrimenti `todo`) |
| `!oggi` `!domani` `!ven` `!3g` `!2s` `!1m` `!fm` `!25/11` `!2026-11-25` | scadenza (per le note: quando è successo) |
| `@tag` | progetto, creato se non esiste; più `@` = più progetti, il primo è il principale |
| `#CODICE` | articolo di magazzino, creato se non esiste; resta nel testo |
| `+utente` | assegnatario |
| `>chi` | destinatario della mail (un'email, o un nome della rubrica) |

Altri campi facoltativi: `kind`, `parent_id`, `project_id`, `assignee_id`, `private`. Risposta `{"id"}`.

**`PATCH /api/entries/:id`**, tutti facoltativi:
- `title`: accetta gli stessi token (`!lun` sposta la scadenza, `@tag` aggiunge un progetto);
- `notes`, `kind`, `done` (true/false), `pinned`, `private` (solo chi l'ha creata);
- `due`: `"2026-11-25"`, una data della barra rapida (`"ven"`, `"3g"`, `"25/11"`), `"no"` o `null` per toglierla. Uno spostamento lascia traccia nello storico;
- `assignee_id` (o `null`), `project_id` (o `null`);
- per le mail: `contact` (A), `mail_cc`, `mail_subject` (`null` = segue il titolo);
- `awaiting` (true/false): la mail mandata aspetta una risposta. Segnando una mail come fatta (`done: true`) diventa automaticamente `awaiting_reply = 1`; `awaiting: false` chiude il thread (nello storico resta "risposta arrivata"). Le mail in attesa stanno in `/api/sync` anche dopo 30 giorni.

Altro:

| | |
|---|---|
| `POST /api/entries/:id/log` `{text}` | aggiornamento nello storico; `!data` e `+utente` nel testo modificano la voce |
| `DELETE /api/logs/:id` | toglie un aggiornamento (proprio, o qualunque se admin) |
| `POST /api/entries/:id/projects` `{project_id}` | aggiunge un progetto (se non ce n'è uno principale, lo diventa) |
| `DELETE /api/entries/:id/projects/:pid` | toglie un progetto (togliendo il principale, lo diventa il successivo) |
| `DELETE /api/entries/:id` | nel cestino, con le sotto-attività |

## Progetti

Campi: `name`, `tag` (quello di `@tag`), `status` (`open`, `paused`, `closed`), `notes`, `parent_id`, `hue` (colore 0–359 o `null` = automatico), `private`.

| | |
|---|---|
| `POST /api/projects` `{name, tag?, parent_id?, private?}` | → `{id, tag}`; senza `tag` lo ricava dal nome |
| `PATCH /api/projects/:id` | uno o più campi sopra; un progetto non può finire dentro un suo sottoprogetto |
| `POST /api/projects/:id/items` `{code}` | collega a mano un articolo (creato se non esiste) |
| `DELETE /api/projects/:id/items/:itemId` | scollega |
| `DELETE /api/projects/:id` | nel cestino (solo chi l'ha creato o un admin) |

## Magazzino

Campi di un articolo: `code` (unico; lettere, numeri e `. _ - /`), `name`, `category`, `firmware`, `location`, `qty` (intero o `null`), `url`, `notes`, `status` (`""`, `outdated`, `discarded`).

| | |
|---|---|
| `POST /api/items` `{code, …campi, project_id?}` | nuovo articolo |
| `PATCH /api/items/:id` | campi; cambiando `code` si aggiornano anche i `#CODICE` nel testo delle voci |
| `POST /api/items/:id/aliases` `{code}` | aggiunge un codice alternativo (unico: non può essere il codice, principale o alternativo, di un altro articolo) |
| `DELETE /api/items/:id/aliases/:code` | toglie un codice alternativo |
| `POST /api/items/:id/children` `{code}` | composizione: l'articolo contiene `code` (creato se non esiste) |
| `DELETE /api/items/:id/children/:childId` | toglie dalla composizione |
| `PUT /api/categories/color` `{name, hue}` | colore di una categoria (`hue: null` = automatico) |
| `DELETE /api/items/:id` | nel cestino |

## Documenti

Tipi (`kind`): `firmware`, `datasheet`, `schema`, `footprint`, `manuale`, `foto`, `altro`, più quelli aggiunti dal workspace (`docKinds` in `/api/sync`, l'elenco completo; `customDocKinds` quelli aggiunti). `POST /api/doc-kinds` `{name}` ne aggiunge uno (una parola, minuscolo); `DELETE /api/doc-kinds/:nome` lo elimina e i suoi documenti diventano `altro`. Un tipo sconosciuto diventa `altro`.

**Caricare un file**: il corpo della richiesta è il file così com'è, i dati vanno nella query string. Il `Content-Type` del corpo diventa il tipo del file (`application/pdf` per vederlo nel visualizzatore).

```bash
curl -X POST "http://localhost:8080/api/items/7/docs?kind=firmware&version=1.1&name=fw_1.1.bin" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/octet-stream' \
  --data-binary @fw_1.1.bin
```

Parametri: `kind`, `name` (nome del file), `version`, `label` (nome mostrato). Un `firmware` con versione aggiorna il campo `firmware` dell'articolo. Limite: 200 MB (`MAX_UPLOAD_MB`).

**Collegare un link** (repo, wiki, PDF online): stesso endpoint, **senza** `name` nella query string, con corpo JSON `{"url": "https://…", "kind": "datasheet", "label": "…", "version": "…"}`. È `name` a distinguere un file da un link: un file `.json` si carica con `Content-Type: application/json` e `?name=…` come qualunque altro file.

| | |
|---|---|
| `GET /api/docs/:id/file` | scarica; il nome nel `Content-Disposition` è `label` più l'estensione originale (`?inline=1` per vederlo nel browser) |
| `GET /api/docs/:id/remote` | il PDF di un link esterno, scaricato dal server (solo indirizzi pubblici, max 60 MB) |
| `PATCH /api/docs/:id` `{label?, kind?, version?}` | rinomina, cambia tipo o versione |
| `DELETE /api/docs/:id` | nel cestino |

## Mail

Una mail è una voce con `kind: "mail"`. Il server non spedisce niente: la mail si apre già compilata nel client di posta.

| | |
|---|---|
| `POST /api/entries/:id/attachments?name=file.pdf` | allega un file (corpo grezzo, come i documenti) |
| `POST /api/entries/:id/attachments` `{doc_id}` | allega un documento del magazzino (senza `name` nella query string) |
| `DELETE /api/attachments/:id` | toglie un allegato |
| `GET /api/attachments/:id/file` | scarica un allegato |
| `GET /api/entries/:id/eml` | la mail come `.eml` (destinatari, oggetto, testo, allegati) |
| `POST /api/entries/:id/send` | `{token}` per l'helper Thunderbird: `organizer-mail://open?server=…&token=…` (15 minuti) |
| `POST /api/entries/:id/compose` | apre la mail nell'estensione di Thunderbird collegata (409 se non ce n'è una) |
| `GET /api/entries/:id/thread` | i messaggi della conversazione: `direction` (`out`, `in`), `message_id`, `from_addr`, `to_addr`, `subject`, `body`, `attachments`, `date` |
| `POST /api/mail/messages/:id/reply` | `{all}` (rispondi a tutti) → `{id}` della nuova mail di risposta a quel messaggio |
| `PATCH /api/mail/inbox/:id` | `{read, archived}` su una mail in arrivo (personale; l'elenco è `inbox` in `/api/sync`) |
| `GET /api/mail/inbox/:id` | la mail in arrivo con il testo intero |
| `POST /api/mail/inbox/:id/reply` | `{all}` → `{id}` della mail di risposta, nel workspace attivo |
| `POST /api/mail/attachments/save` | `{source: "inbox" o "message", id, n, item_id, kind}`: chiede all'estensione di caricare l'allegato n come documento dell'articolo |

Le mail sono personali: le voci `kind: "mail"` le vedono solo chi le ha create e l'assegnatario, anche per gli admin.

L'estensione di Thunderbird (cartella `thunderbird/`) usa queste, con un token; valgono per tutti i workspace dell'utente:

| | |
|---|---|
| `GET /api/mail/stream` | flusso di eventi (`outbox`, `watch`); finché è aperto l'estensione risulta collegata (`mailExt` in `/api/sync`) |
| `GET /api/mail/outbox` | mail da aprire: `ws`, `id`, `to`, `cc`, `subject`, `body`, `reply_to` (Message-ID), `files` |
| `POST /api/mail/outbox/:ws/:id/claim` | la prende (409 se l'ha già presa un altro Thunderbird) |
| `GET /api/mail/outbox/:ws/:id/file/:n` | allegato n |
| `POST /api/mail/sent` | `{ws, outbox_id, message_id, from, to, cc, subject, date}`: mandata, in attesa di risposta |
| `GET /api/mail/watch` | Message-ID delle conversazioni seguite |
| `POST /api/mail/incoming` | `{message_id, in_reply_to, references, from, to, cc, subject, date, body, attachments, inbox}` → `{matched}`; con `inbox: true` entra anche nella posta in arrivo |
| `POST /api/mail/identities` | `{addresses}`: i propri indirizzi, esclusi da "rispondi a tutti" |
| `GET /api/mail/fetches` | allegati da caricare come documenti: `id`, `ws`, `item_id`, `kind`, `message_id`, `part`, `name`; si caricano con `POST /api/items/:id/docs` e l'header `X-Workspace` |
| `POST /api/mail/fetches/:id/claim`, `/done` | presa in carico e fine (anche se non riuscita) |
| `GET /api/mail/thunderbird.xpi` | l'estensione, impostata per il server da cui si scarica |

## Contatti

Campi: `name`, `email`, `phone`, `company`, `role`, `timeslot` (fascia oraria), `notes`. `POST /api/contacts`, `PATCH /api/contacts/:id`, `DELETE /api/contacts/:id`. Nelle voci `>nome` diventa l'email del contatto, se il nome è univoco.

## Chat

Una chat per workspace, a canali. Un canale: `id`, `name`, `everyone` (tutti i membri leggono e scrivono) oppure `members` `[{user_id, can_write}]`. In `/api/sync`: `chatChannels` (con `member`, `can_write`, `unread`, `read_id`; chi gestisce i canali li riceve tutti), `chat` (gli ultimi 100 messaggi di ogni canale in cui sei), `chatUnread`, `canManageChannels`. Un messaggio: `id`, `channel_id`, `user_id`, `text`, `created_at`, `edited_at`. Senza `channel` vale il primo canale in cui sei.

I collegamenti stanno nel testo e l'app li mostra come link con il nome attuale: `#CODICE` (articolo), `@tag` (progetto), `+utente` (persona), `[[doc:ID]]` (documento), `[[voce:ID]]` (todo, mail o nota), `[[contatto:ID]]`.

| | |
|---|---|
| `GET /api/chat?channel=ID&limit=50` | ultimi messaggi del canale (per id o nome), in ordine cronologico (max 500) |
| `GET /api/chat?before=ID` | i precedenti a ID (per scorrere indietro) |
| `GET /api/chat?after=ID` | i successivi a ID (per un bot: a ogni evento `change` di `/api/events`) |
| `POST /api/chat` `{text, channel}` | scrive (max 4000 caratteri) → `{id, channel_id}`; 403 dove si può solo leggere |
| `PATCH /api/chat/:id` `{text}` | modifica un proprio messaggio |
| `DELETE /api/chat/:id` | elimina (i propri, o qualunque se admin o gestore dei canali) |
| `POST /api/chat/read` `{id, channel}` | letto fino a `id` nel canale |
| `POST /api/chat/channels` `{name, everyone, members}` | crea un canale (admin o permesso `canali`) |
| `PATCH /api/chat/channels/:id` | nome, `everyone`, `members` |
| `DELETE /api/chat/channels/:id` | elimina il canale |

## Feedback

| | |
|---|---|
| `POST /api/feedback` `{text, page, version, client}` | → `{id}` |
| `POST /api/feedback/:id/files?name=…` | un'immagine (corpo grezzo, PNG/JPEG/GIF/WebP, max 15 MB, 6 per feedback), entro un'ora |
| `GET /api/feedback?status=open\|all` | elenco con `files` (solo chi gestisce l'istanza) |
| `PATCH /api/feedback/:id` `{status: "open"\|"done"}` | |
| `GET /api/feedback/files/:id` | l'immagine |

Un ponte verso Telegram: segui `/api/events`, a ogni `change` leggi `/api/chat?after=ULTIMO` e inoltra; nella direzione opposta `POST /api/chat`. Dal terminale c'è `org chat -f`.

## Cestino

| | |
|---|---|
| `GET /api/trash` | `{days, entries, projects, items, docs, contacts, docNotes}` |
| `POST /api/trash/:tipo/:id/restore` | ripristina; tipo: `entry`, `project`, `item`, `doc`, `contact`, `docnote` |
| `DELETE /api/trash/:tipo/:id` | elimina per sempre (chi l'ha creato o eliminato, o un admin) |

## Token

| | |
|---|---|
| `GET /api/tokens` | i tuoi token: `id`, `name`, `hint` (ultime 4 lettere), `created_at`, `last_used_at`, `current` (quello in uso) |
| `POST /api/tokens` `{name}` | nuovo token (solo dall'app, non con un token) |
| `POST /api/auth/token` `{username, password, name}` | nuovo token con le credenziali |
| `DELETE /api/tokens/:id` | revoca |

## Esempio: un bot che risponde "cosa scade oggi?"

```js
// Node 22, nessuna dipendenza. ORGANIZER_URL, ORGANIZER_TOKEN, ORGANIZER_WS nell'ambiente.
const { ORGANIZER_URL: url, ORGANIZER_TOKEN: token, ORGANIZER_WS: ws } = process.env;
const headers = { Authorization: `Bearer ${token}`, 'X-Workspace': ws };

async function dueToday() {
  const today = new Date().toLocaleDateString('sv'); // AAAA-MM-GG nel fuso locale
  const d = await (await fetch(`${url}/api/sync`, { headers })).json();
  return d.entries.filter(e => !e.done_at && e.kind !== 'note' && e.due && e.due <= today).map(e => `• ${e.title}`);
}

async function add(text) {
  const r = await fetch(`${url}/api/entries`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, today: new Date().toLocaleDateString('sv') }),
  });
  if (!r.ok) throw new Error((await r.json()).error);
  return (await r.json()).id;
}
```

Per tutto il resto la CLI è un esempio completo: `cli/lib/client.js` (richieste) e `cli/lib/data.js` (lettura di `/api/sync`). Con `org api METODO PERCORSO [JSON]` si prova qualunque endpoint dal terminale.
