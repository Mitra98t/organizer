# Changelog

Le novità di ogni versione, dalla più recente. Le versioni sono i tag git (`v0.7`, `v0.6.2`…); il numero in `package.json` è lo stesso.
Aggiornando non serve fare niente a mano: il database si migra da solo all'avvio (la versione dello schema è indicata quando cambia).

## 0.9 — 2026-10-28

**Temi**
- Impostazioni → Tema: oltre a Organizer (automatico, chiaro, scuro) temi ispirati a Neovim e VS Code: Tokyo Night, Catppuccin Mocha e Latte, Gruvbox scuro e chiaro, Nord, Dracula, One Dark, Rosé Pine, Kanagawa, Everforest, GitHub scuro e chiaro, Solarized scuro e chiaro. Ogni tema ha l'anteprima dei suoi colori; vale per il dispositivo.

**Interfaccia più uniforme**
- Campi, menu, pulsanti e chip hanno la stessa altezza: nei dettagli di una voce tipo, scadenza, pulsanti della scadenza, progetti e assegnatario stanno sulla stessa linea. I progetti di una voce sono in un riquadro come gli altri campi.
- Filtri uguali in ogni pagina: la parola sullo sfondo del suo colore (categorie del magazzino, tipi di documento, todo/mail in Agenda, stato degli articoli), con il bordo pieno quando è attivo; la riga dei filtri usa tutta la larghezza e le spiegazioni stanno sempre sotto i filtri.
- Pagina Documenti: per la revisione affiancata un pulsante disegnato apposta al posto della casella, che mostra la posizione (1, 2, 3) in cui si aprirà il documento.
- Documenti: passando il mouse sul nome di un documento (pagina Documenti e scheda dell'articolo) compare una scheda con tipo, articolo, versione, dimensione e un'anteprima piccola (prima pagina dei PDF, immagini, prime righe dei file di testo).
- Scheda dell'articolo: la descrizione è più larga degli altri campi.
- Nella pagina Novità non c'è più la barra per aggiungere.

## 0.8.3 — 2026-10-28
- Pagina **Novità** con questo changelog, una scheda per versione e quella in uso segnata: su computer dal pulsante in fondo alla barra laterale (con "nuovo" finché non la apri dopo un aggiornamento), su telefono da Impostazioni.

## 0.8.2 — 2026-10-28
- Pagina Documenti: il pulsante a pannelli ora mostra la vista per categoria del magazzino (con gli articoli e i loro documenti), come nel magazzino; l'altro pulsante la vista per tipo di documento.
- Viste a colonne (magazzino per categoria, documenti raggruppati) disposte "a muro" come la home di Pinterest: ogni blocco va nella colonna più corta, così sotto un blocco basso non resta spazio vuoto. Si ricompongono quando la finestra cambia larghezza.

## 0.8.1 — 2026-10-28
- Mail: un tasto solo le fa avanzare. Da mandare → (clic) in attesa di risposta, con la clessidra → (clic) risposta arrivata, in archivio. Su una mail in archivio lo stesso tasto la rimette in attesa. Tolto il pulsante "risposta arrivata".
- Mail mandate: freccia ↑ in fondo alla riga per riportarle tra quelle da mandare (es. per un sollecito).
- Ogni contatto ha un colore (automatico, o scelto dal pallino accanto al nome nella sua pagina): il suo nome è colorato nelle mail, in rubrica e nei backlink.
- Impostazioni → Contatti: i contatti si colorano per contatto (automatico o scelto, come prima), oppure per azienda, fascia oraria o ruolo (stesso colore per lo stesso valore). Preferenza di questo dispositivo.
- Schema dati v12.

## 0.8 — 2026-10-28

**Mail in attesa di risposta**
- Una mail segnata come mandata finisce in **In attesa di risposta** (pagina Mail e pagina del progetto), dalla più vecchia, con da quanti giorni aspetta. "Risposta arrivata" chiude il thread e lo scrive nello storico; se una mail non richiede risposta, "Nessuna risposta" nel messaggio che compare dopo l'invio (o il chip "attende risposta" nella mail).
- I thread in attesa restano visibili anche dopo 30 giorni.
- CLI: `org mail` mostra anche i thread in attesa; `org mail replied ID` li chiude.

**Documenti**
- Pagina Documenti, vista per articolo: ora le colonne sono le categorie del magazzino (come il magazzino a colonne), con dentro gli articoli e i loro documenti. L'altra vista resta per tipo di documento.
- Nuovi tipi di documento oltre a quelli fissi: "+ nuovo tipo" nella pagina Documenti o "+ nuovo tipo…" in fondo a ogni menu del tipo. Ognuno ha il suo colore; i tipi aggiunti si eliminano dalla loro colonna (i documenti diventano "altro"). CLI: `org doc kinds [--add NOME] [--rm NOME]`.
- Nelle colonne strette (Documenti su schermi medi) dimensione e data vanno a capo invece di essere tagliate.

**Progetti**
- Il colore del progetto si sceglie dal pallino accanto al nome, che apre il popup dei colori come per le categorie del magazzino (prima i colori stavano sempre in vista tra i campi).

- Schema dati v11.

## 0.7.4 — 2026-10-27
- Descrizione degli articoli, appunti di progetti e contatti, dettagli delle voci e testo delle mail si leggono come la chat: `#CODICE`, collegamenti `[[…]]` e link colorati e cliccabili dentro il testo. Un clic sul testo (o Invio) apre il campo per scrivere; uscendo si salva e si torna alla lettura.
- Nel testo delle mail anche i codici di magazzino scritti senza `#` sono colorati e cliccabili.

## 0.7.3 — 2026-10-27
- Tutte le pagine usano la larghezza intera della finestra (prima si fermavano a 1480 px; anche la chat).
- Viste a colonne (magazzino per categoria, documenti raggruppati): 3 colonne su schermo grande (da 1400 px), 2 su medio, 1 su telefono.

## 0.7.2 — 2026-10-27
- **Ricerca nel documento**: ⌘F (Ctrl+F) nella pagina di un PDF o di un file di testo apre una barra di ricerca; i risultati sono evidenziati sulla pagina (anche con lo zoom), con il conteggio, Invio / Maiusc+Invio per passare al successivo o al precedente, Esc per chiudere. Fuori dai documenti ⌘F resta la ricerca del browser.
- CLI: `org doc notes ID` mostra le note scritte su un documento, prima le generali poi pagina per pagina con lo stesso numero del segnaposto nell'app (`--all` anche le risolte); `org doc` indica quante note aperte ha ogni documento.

## 0.7.1 — 2026-10-27

**Collegamenti ovunque**
- `[[` funziona in ogni campo di testo: titoli e dettagli delle voci, aggiornamenti, testo delle mail, appunti di progetti, articoli e contatti, note sui documenti, barra rapida, chat. Collega voci (un todo a un altro todo, una mail, una nota), documenti, articoli, progetti e contatti.
- Nel menu dei suggerimenti ogni riga ha l'etichetta del tipo (todo, mail, nota, documento, articolo, progetto, contatto) e lo stato (da mandare, mandata, fatta), così si distingue cosa si sta collegando.
- I collegamenti si vedono come link con il nome attuale: nei titoli e, sotto i campi di testo, come riga di link.

**Backlink**
- Ogni elemento collegato mostra chi lo collega, con le mail divise in **da mandare** e **mandate**: articoli ("Nelle mail"), documenti, progetti, contatti e voci ("Citata in"). Comprende le mail archiviate.
- Nel testo delle mail i codici di magazzino senza `#` contano come collegamento all'articolo; per i documenti contano anche gli allegati, per i contatti le mail al loro indirizzo.
- Le voci fatte da più di 30 giorni si aprono in sola lettura dai backlink, con "Riapri".
- Nella scheda articolo le mail stanno solo in "Nelle mail" (non più in "Da fare").

**Mail**
- Nelle mail mandate (Thunderbird, `.eml`, app mail) i collegamenti diventano il nome di ciò che collegano.
- Correzione: con il Cc vuoto il `.eml` aveva una riga vuota tra le intestazioni e arrivava senza oggetto.

**CLI e API**
- `GET /api/backlinks/:tipo/:id`; la CLI mostra i collegamenti con il nome (`«…»`), `org show` le voci che citano la voce, `org item show` le mail da mandare e mandate.
- Schema dati v10 (i collegamenti delle voci esistenti si calcolano al primo avvio).

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
