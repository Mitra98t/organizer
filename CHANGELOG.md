# Changelog

Le novità di ogni versione, dalla più recente. Le versioni sono i tag git (`v0.7`, `v0.6.2`…); il numero in `package.json` è lo stesso.
Aggiornando non serve fare niente a mano: il database si migra da solo all'avvio (la versione dello schema è indicata quando cambia).

## 0.7 — 2026-10-27

**Chat del workspace**
- Nuova pagina Chat (barra laterale; su telefono l'icona in alto) per i membri del workspace, in tempo reale.
- I messaggi collegano le cose dell'app: `@progetto`, `#CODICE`, `+persona` e, scrivendo `[[`, documenti, voci (todo, mail, note) e contatti. Nel messaggio diventano link con il nome sempre aggiornato.
- Messaggi non letti nel badge, notifica quando ne arriva uno mentre sei in un'altra pagina, modifica ed eliminazione dei propri messaggi, "Messaggi precedenti" per scorrere indietro.
- Nuova pagina `#/v/ID` che mostra una voce da sola (ci portano i link della chat).

**Mail**
- Nel testo di una mail `#` suggerisce gli articoli del magazzino e inserisce il codice senza `#` (la mail va a chi non usa l'app).
- Nei suggerimenti dei codici trattini e punti non contano: `#sch051` trova `SCH-051`.

**CLI e API pubbliche**
- `org`, la CLI per il terminale (cartella `cli/`, `make cli`): voci, progetti, magazzino, documenti (caricare, scaricare, aprire, rinominare), mail con allegati, chat (`org chat -f` la segue dal vivo), cestino, `--json` per gli script. Guida in [cli/README.md](cli/README.md).
- Token API per la CLI e per bot e script: si creano in Impostazioni → *CLI e token API* o con `org login`, si revocano dall'app. Autenticazione `Authorization: Bearer`, workspace scelto con `X-Workspace`.
- API documentate in [docs/API.md](docs/API.md); nuovi `GET /api/info`, `GET /api/entries/:id`, endpoint della chat. Il campo `due` delle voci accetta anche le date della barra rapida (`"ven"`, `"3g"`, `"25/11"`).
- Schema dati v9, account v2.

## 0.6.2 — 2026-10-27
- Nuovo tipo di documento **footprint** (impronte PCB), con il suo colore.

## 0.6.1 — 2026-10-27
- I documenti si rinominano dall'app: dal titolo nel visualizzatore o con la matita nella scheda articolo, nella pagina Documenti e nella revisione. Scaricando, il file prende quel nome con l'estensione originale.

## 0.6 — 2026-10-27
- **Workspace**: più insiemi di dati separati, ognuno con i suoi membri e ruoli (admin/membro), inviti per workspace, cambio dalla barra laterale. L'installazione esistente diventa il workspace "Principale".
- Contatti: fascia oraria, raggruppamento per azienda, fascia oraria o ruolo.
- Colori scelti a mano per progetti e categorie.
- PDF da link esterni visti direttamente nell'app (scaricati dal server, solo indirizzi pubblici).
- Articoli outdated e scartati, con pallini e filtri; colonne del magazzino più larghe.
- Pagine documento alte quanto la finestra; pulsante Magazzino nella pagina Documenti.
- Correzione: su telefono la barra in basso spariva nel Diario.
- Schema dati v6–v8.

## 0.5 — 2026-10-27
- Pagina **Documenti** con filtri e revisione affiancata fino a 3 documenti, ognuno con le sue note.
- Tipo e versione dei documenti modificabili; la versione firmware dell'articolo segue il firmware più recente.
- Voci in più progetti; link sugli articoli; drag and drop degli articoli tra categorie.
- Visualizzatore PDF più largo con note nascondibili e modalità espansa.
- Schema dati v5.

## 0.4 — 2026-10-27
- **Note sui documenti**: visualizzatore PDF (PDF.js incluso), immagini e testo; note posizionate su un punto della pagina o generali, risolte, trasformabili in todo.
- Contatti: suggerimento delle aziende già in rubrica.
- Schema dati v4.

## 0.3 — 2026-10-27
- **Sottoprogetti** a più livelli, riorganizzabili con drag and drop.
- Articoli collegati a mano ai progetti; la barra in alto crea articoli (in Magazzino) e progetti (in Progetti).
- Magazzino per categoria: colori, filtri, vista a colonne, scheda rapida al passaggio del mouse, composizione con autocompletamento.
- Esc per uscire dai campi e risalire; ripristino di un backup dalle Impostazioni.
- Schema dati v3.

## 0.2 — 2026-10-27
- **Autocompletamento** di `@progetto`, `#CODICE`, `!data`, `+utente`, `>destinatario`.
- **Cestino** con "Annulla" e pulizia automatica dopo 30 giorni.
- **Mail** con destinatari, oggetto, testo e allegati, aperte in Thunderbird con l'helper (`make mail-helper`), oppure `.eml`.
- **Contatti**: rubrica condivisa, `>nome` diventa l'email.
- Schema dati v2.

## 0.1 — 2026-10-27
- Prima versione: todo, mail, diario e magazzino (codici, firmware, documenti) sincronizzati in tempo reale; barra rapida con token; più utenti con inviti; PWA installabile; Docker con HTTPS opzionale.
- Makefile (avvio, reset, dati demo, backup, utenti), dati dimostrativi.
