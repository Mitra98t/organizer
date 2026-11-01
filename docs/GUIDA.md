# Organizer — guida completa

Tutto quello che Organizer sa fare, pagina per pagina. Per la presentazione con le immagini: [README](../README.md).

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
| `make tunnel` / `tunnel-off` / `tunnel-status` | accesso da fuori con il tuo dominio via Cloudflare Tunnel, senza porte aperte (vedi docs/DEPLOY.md) |
| `make mail-helper` / `mail-helper-uninstall` | helper che apre le mail in Thunderbird con gli allegati |
| `make dev` / `dev-demo` / `test` | sviluppo locale senza Docker (dati in `./data`) |

I comandi che cancellano chiedono di scrivere "si"; per gli script: `CONFIRM=1`.

Senza Docker e senza make (serve Node ≥ 22.13): `npm start` (dati in `./data`), oppure `npm run dev` con riavvio automatico.

## Come si usa: la barra rapida

Scrivi poche parole e premi Invio. I token fanno il resto:

| Token | Significato |
|---|---|
| `t:` `m:` `n:` | tipo: todo (predefinito), mail, nota del diario |
| `!oggi` `!domani` `!ven` `!3g` `!2s` `!1m` `!fm` `!25/11` `!2026-12-01` `!no` | scadenza (per le note: quando è successo) |
| `@rover` | progetto, creato al volo se non esiste; più `@` = più progetti (il primo è il principale) |
| `#SCH-042` | articolo di magazzino: resta nel testo come link, creato se non esiste |
| `+marco` `++marco` `+all` | condivide con Marco; condivide e gli assegna la voce; condivide con tutti (senza: solo tu) |
| `>acquisti@ditta.it` | destinatario della mail |

```
flash fw nuovo #SCH-042 @rover !ven
m: preventivo 50 schede >acquisti@ditta.it !domani
n: la rev B della SCH-042 vuole bootloader >= 2.3 #SCH-042
```

**Aggiornare man mano**: apri una voce e scrivi un aggiornamento ("manca il cavo JTAG, slitta !lun"). Resta lo storico con data e la scadenza si sposta, lasciando traccia di quanto è slittata. Gli stessi token funzionano modificando il titolo. Le sotto-attività nascono quando scopri che una cosa ne contiene altre.

**Autocompletamento**: appena scrivi `@`, `#`, `!`, `+` o `>` compare un menu con progetti, articoli (con firmware), date già calcolate ("ven 30 ott · tra 3g"), utenti e destinatari usati di recente. `↑↓` per scegliere, `Tab` o `Invio` per completare, `Esc` per chiudere; su telefono basta toccare. Funziona anche nel titolo di una voce, nelle sotto-attività e negli aggiornamenti.

Nelle liste ogni voce ha un'etichetta e un bordo colorato per tipo (verde todo, blu mail, viola nota), e ogni progetto ha un suo colore fisso, così in Agenda si capisce al volo cosa si sta guardando. I filtri Tutto / Todo / Mail in cima all'Agenda mostrano anche i conteggi.

La barra in alto cambia con la pagina: in **Magazzino** aggiunge articoli (`SCH-060 scheda relè /scheda @rover`: codice, descrizione, `/categoria`, `@progetto` a cui collegarlo; se il codice esiste già Invio apre la sua scheda), in **Progetti** crea progetti (`Firmware motori @rover` lo crea come sottoprogetto di @rover).

`Esc` esce dal campo; fuori dai campi chiude le voci aperte e poi torna all'elenco (da un progetto a Progetti, da un articolo a Magazzino).

Nelle altre pagine la barra rapida tiene conto di dove sei: in un progetto le voci finiscono lì, nella scheda di un articolo vengono collegate al suo codice, in Mail e Diario cambia il tipo predefinito.

Scorciatoie da tastiera: `n` o `/` per scrivere, `Ctrl/⌘ K` per cercare.

## Temi

Impostazioni → Aspetto: Organizer (automatico, chiaro, scuro), temi ispirati a quelli più usati in Neovim e VS Code (Tokyo Night, Catppuccin, Gruvbox, Nord, Dracula, One Dark, Monokai Pro, Ayu, Night Owl, Palenight, Rosé Pine, Kanagawa, Everforest, GitHub, Solarized) e qualche tema funky (Synthwave '84, Vaporwave, Matrix, Terminale ambra, Cobalt2, Shades of Purple, Halloween, Bubblegum, Sorbetto, Limonata), con sfondi sfumati, accenti luminosi o il carattere da terminale. Il tema vale per il dispositivo.

Nella stessa pagina si sceglie l'**icona dell'app**: quella di un tema (anche diverso da quello in uso), una minimal, oppure "Automatica", che segue il tema. Cambia subito l'icona della scheda del browser; per l'app già installata va rimossa e aggiunta di nuovo alla schermata Home o al Dock, perché il sistema tiene l'icona di quando l'hai installata.

## Muoversi nell'app

- **Barra laterale** (computer): Progetti, Agenda (con Diario), Magazzino (con Documenti), Mail (con Contatti), Chat; in fondo Cestino, Impostazioni, Novità e Feedback.
- **Barra in basso** (telefono): Progetti, Agenda, Magazzino, Mail, Impostazioni. Un tocco apre la pagina; **tenendo premuto** si apre attorno al dito un menu con le altre pagine del gruppo (Agenda e Diario; Magazzino e Documenti; Mail, Contatti e Chat; Impostazioni, Cestino, Novità, Feedback): scorri sul tasto che vuoi e lascia. La pagina scelta prende il posto del tasto nella barra. I tasti con altre pagine dietro hanno un trattino sotto l'icona.
- **Barra comandi**: ⌘K o ⌘P (Ctrl+K su Windows/Linux; su telefono toccando "Cerca"). Si scrivono un po' di parole e si apre al volo una pagina, una voce, una conversazione di mail, un articolo, un documento, un progetto o un contatto, con la stessa ricerca di `[[` (vedi sotto). ↑↓ e Invio; in fondo "Cerca ovunque" porta alla pagina Cerca.
- **Schede chiudibili** (telefono): in Magazzino, Documenti e Mail "Chiudi tutto" lascia solo le intestazioni delle schede, con il loro numero; toccandone una si apre solo quella.

## Collegamenti e backlink

In qualunque campo di testo `[[` apre i suggerimenti per collegare una voce (todo, mail, nota), una conversazione di mail ricevuta, un documento, un articolo, un progetto o un contatto; ogni suggerimento ha l'etichetta del suo tipo. Dopo `[[` si possono scrivere più parole, e ognuna può stare in un posto diverso: titolo, persone (nome in rubrica o indirizzo), testo, tipo ("mail", "todo", "documento"…), codici. Per esempio `[[marco mail 500mA` trova la mail in cui c'è Marco e nel cui testo c'è "500mA": il testo intero delle mail ricevute lo cerca il server, solo nella tua posta. Una conversazione citata (`[[mail:7]]`) la vede solo chi la riceve; gli altri leggono "non hai permessi sufficienti". Si possono citare anche le **note sui documenti** (`[[nota:9]]`, etichetta "nota su file"), cercandole per testo, testo evidenziato o nome del file: il link apre il documento sulla nota, e la nota mostra in "Citata in" le voci che la citano. Come la nota, la vede solo chi può vederla. Nel testo resta un token (`[[voce:12]]`) che l'app mostra come link con il nome sempre aggiornato; nelle mail mandate diventa il nome in chiaro.

Ciò che viene collegato lo sa: articoli, documenti, progetti, contatti e voci mostrano chi li collega, con le mail divise in **da mandare** e **mandate** (anche quelle vecchie). Così si vede subito se il datasheet è già partito per il fornitore o se è in una mail ancora da mandare.

## Progetti

Una voce (todo, mail, nota) può stare in più progetti: nell'editor i progetti sono chip con × e un campo per aggiungerne altri; compare nella pagina di ognuno.

Un progetto può stare dentro un altro (campo "Dentro" nella sua pagina, o `@padre` quando lo crei), a più livelli. L'elenco li mostra ad albero con le voci aperte sommate e si riorganizza **trascinando**: un progetto rilasciato su un altro ci finisce dentro, rilasciato sulla riga in cima torna principale (su telefono: tieni premuto e trascina; dopo ogni spostamento c'è "Annulla"); nella pagina di un progetto ci sono i sottoprogetti e, se attivo "includi le voci dei sottoprogetti", anche le loro voci. La sezione **Magazzino del progetto** raccoglie gli articoli collegati a mano (con autocompletamento; un codice nuovo crea l'articolo) e quelli citati con `#CODICE` nelle voci.

## Documenti e note

Con più file, **Scarica tutti** nella sezione Documenti dell'articolo li scarica in un unico `.zip` (`CODICE-documenti.zip`, ognuno con il nome dato nell'app; i link restano fuori).

Cliccando un documento nella scheda di un articolo si apre il visualizzatore con le note a lato. Il documento usa tutta la larghezza della pagina; con **note** nascondi la barra delle note (la preferenza resta), con **espandi** sparisce anche il resto dell'app e il documento occupa tutta la finestra (Esc per tornare).

- **PDF** (con PDF.js, incluso nel progetto in `public/vendor/pdfjs`, nessuna connessione esterna) e **immagini**: clicchi un punto e lasci una nota lì; il segnaposto numerato resta al suo posto a ogni zoom e si trascina per spostarlo, anche su un’altra pagina. Cliccando una nota il documento scorre al punto, e viceversa.
  Nei PDF puoi anche **selezionare del testo** trascinando (o con doppio clic su una parola, triplo su una riga): diventa una nota su quel testo, che resta evidenziato nel documento e citato nella nota. Cliccando il testo evidenziato si apre la sua nota. Sul telefono tieni premuto per selezionare e poi tocca **Nota sul testo**. Questi segnaposto non si spostano: restano attaccati al testo. Nei PDF fatti di sole immagini (scansioni) non c'è testo da selezionare.
- **Disegni DXF** (con dxf-parser, incluso nel progetto): il disegno diventa un'immagine su carta bianca (linee, polilinee, cerchi, archi, ellissi, spline, testi, blocchi, quote; i layer spenti no) e funziona come un'immagine: zoom fino a 12×, note nei punti. I DWG no: il formato è chiuso, si esportano in DXF dal programma CAD.
- **Modelli 3D** (STL, 3MF, STEP, con three.js e OpenCascade inclusi nel progetto): il modello si gira, si sposta e si ingrandisce; clicchi un punto della superficie e lasci una nota lì. I segnaposto seguono la vista e si trascinano sul modello; cliccando una nota la vista si gira verso il punto. Gli STEP si convertono nel browser: un modello grande può richiedere qualche secondo.
- **File di testo**: anteprima del contenuto.
- **Tabelle CSV e TSV** (`.csv`, `.tsv`, `.scsv`): le colonne in una tabella con righe zebrate, intestazione che resta in vista scorrendo e numero di riga. Il separatore (virgola, punto e virgola, tab o `|`) si riconosce da solo; i campi fra virgolette possono contenere il separatore e andare a capo; i CSV salvati da Excel con le lettere accentate si leggono giusti. Si vedono le prime 5000 righe (fino a 8 MB): oltre, si scarica il file.
- **Cerca nel documento**: ⌘F (Ctrl+F su Linux) apre la ricerca nel PDF, nel file di testo o nella tabella aperta; Invio e Maiusc+Invio passano da un risultato all'altro, Esc chiude. Nella revisione affiancata cerca nel documento toccato per ultimo. Funziona sui PDF con testo vero (non sulle scansioni).
- **Link a un PDF** (es. un datasheet su mouser.com): il server lo scarica al momento e lo mostra come un PDF caricato, con le stesse note. Solo indirizzi internet pubblici (mai la rete locale), solo PDF, massimo 60 MB (`REMOTE_MAX_MB`); se il sito mostra una pagina o una protezione anti-bot al posto del file, compare il motivo e il link originale.
- **Qualsiasi altro file o link** (firmware, archivi, …): niente anteprima, ma le **note generali** sul file funzionano per tutti.

Su schermo largo la pagina del documento (e la revisione) è alta quanto la finestra: scorre solo il documento.

La pagina **Documenti** (barra laterale; su telefono dalla barra in basso) raccoglie tutti i documenti per articolo o per tipo, con filtri e "con note aperte". Spunta fino a 3 documenti e **Rivedi affiancati**: si aprono uno accanto all'altro, ognuno con le sue note (si aprono nel pannello in cui clicchi). Un documento si **rinomina** dal titolo nel visualizzatore o con la matita accanto al nome (scheda articolo, Documenti, revisione): il file originale non cambia, ma quando lo scarichi prende il nuovo nome con la sua estensione. Tipo e versione di un documento si cambiano in qualsiasi momento, qui, nella scheda dell'articolo o nel visualizzatore; se cambia un firmware, l'articolo prende la versione del firmware più recente.

Ogni nota si può modificare, segnare come risolta (sparisce, si rivede con il filtro "risolte"), eliminare (va nel cestino) o trasformare in todo con **→ todo**: la voce nasce con il `#CODICE` dell'articolo e negli aggiornamenti un link che riapre il documento su quella nota. Il file originale non viene modificato: le note vivono nell'app. Nella scheda dell'articolo ogni documento mostra quante note aperte ha; la ricerca trova anche il testo delle note.

## Mail

Una voce di tipo mail è una mail vera: destinatari (A, Cc) con suggerimenti dalla rubrica, oggetto (se vuoto usa il titolo), testo e allegati. Gli allegati possono essere file caricati (anche trascinandoli) o documenti già presenti in magazzino, per esempio il firmware da mandare al cliente. Nel testo `#` suggerisce gli articoli del magazzino e inserisce il codice senza `#` (es. `#sch051` → `SCH-051`).

Ogni mail ha un tasto solo che la fa avanzare: un clic la segna mandata e la mette **In attesa di risposta** (con la clessidra), un altro clic quando la risposta è arrivata la manda in archivio. Così i thread ancora aperti non si perdono. Se una mail non richiede risposta, "Nessuna risposta" subito dopo averla segnata mandata. La freccia ↑ in fondo alla riga di una mail mandata la riporta tra quelle da mandare (per un sollecito). Ogni contatto ha un colore, che si cambia dal pallino nella sua pagina: il suo nome nelle mail è colorato così. In Impostazioni → Contatti si può colorare invece per azienda, fascia oraria o ruolo.

### Con Thunderbird (estensione)

L'estensione **Organizer per Thunderbird** collega l'app al tuo Thunderbird (cartella `thunderbird/`, si scarica pronta da Impostazioni → Mail e Thunderbird):

1. **Scarica l'estensione**: il file `.xpi` è già impostato per l'indirizzo da cui apri l'app.
2. In Thunderbird: menu ≡ → Componenti aggiuntivi e temi → ingranaggio → "Installa componente aggiuntivo da file…".
3. **Crea token per Thunderbird** nella stessa sezione e incollalo nelle opzioni dell'estensione → "Salva e collega".

Poi, con Thunderbird aperto:
- **Manda** apre la mail in Thunderbird con destinatari, oggetto, testo e allegati, anche se premi dal telefono (si apre sul computer). Le risposte scritte in Organizer si aprono come risposta al messaggio originale.
- Quando la invii diventa **mandata** e **in attesa di risposta** da sola.
- **Primo collegamento** (di ogni persona; dalla posta a topic vale per tutti): l'estensione carica l'ultimo mese da tutte le cartelle tranne spam, cestino e bozze, più i messaggi più vecchi citati. Si vedono tutte le conversazioni recenti, anche quelle iniziate prima, da archiviare.
- **Conversazioni**: ogni mail va nella conversazione della mail a cui risponde (riferimenti In-Reply-To e References); se mancano, come fanno molti client, in quella con lo stesso oggetto (senza Re:, R:, Fwd:) e almeno una persona in comune, entro 60 giorni. Una conversazione è un albero: ogni risposta sotto quella a cui risponde, anche se va a destinatari diversi.
- **Topic**: la pagina Mail mostra i topic come schede su più colonne, ognuno con le sue conversazioni. Di base ogni conversazione è un topic a sé; trascinandola su un altro topic si uniscono (e trascinandola sulla zona che compare in basso torna a sé). **Attivi** e **Archiviati**, con i filtri con stella, da leggere, da mandare, in attesa di risposta, allegati e progetto. Topic e conversazioni hanno **stella** e **colore** (automatico finché non lo scegli).
- **Archiviare** vale per la conversazione (il tasto a sinistra): un topic è archiviato quando lo sono tutte le sue. Una mail nuova riporta in vita la conversazione e il suo topic.
- **Pagina del topic**: a sinistra l'albero (conversazioni e mail, come un forum), al centro la mail scelta (aprirla la legge), con **Rispondi** e **Rispondi a tutti**: la bozza nasce nell'albero, si scrive lì e parte da Thunderbird. A destra i collegamenti del topic intero (es. il suo progetto, vale per tutte le conversazioni) e, per la conversazione scelta: archivia, nuova mail, **collegamenti**, persone, allegati ricevuti.
- **Collegamenti**: codici di magazzino (anche alternativi, e anche scritti alla buona: `sch44` per SCH-44) e progetti scritti negli oggetti e nei testi si collegano da soli, come quello che citi nelle mail scritte qui; articoli, progetti, documenti e contatti mostrano le conversazioni in "Conversazioni di mail". Un collegamento sbagliato si toglie con la ×, e non torna.
- **Porta il thread in Organizer** (tasto destro su una mail in Thunderbird, in qualunque cartella): arriva tutta la conversazione, i messaggi prima e le risposte dopo (cercate per oggetto, fino a 200), tra le attive.
- Dal menu ⋯ una conversazione si rinomina, si sposta in un altro topic o si elimina (va nel cestino con le sue mail scritte qui); un topic si rinomina o si elimina con tutte le sue conversazioni.
- In Contatti, **Da salvare** elenca gli indirizzi delle mail che non sono in rubrica. "Ignora" non lo propone più; "Ignora tutti quelli che contengono…" toglie in un colpo indirizzi e nomi con un pezzo in comune (`noreply`, `@amazon.it`, `newsletter`). Le regole sono del tuo account (valgono su tutti i dispositivi) e si tolgono dallo stesso pannello.
- **Allegati nel magazzino**: su ogni allegato di una mail ricevuta, "→ magazzino" apre un modale in cui cerchi l'articolo (codice, anche alternativo, nome, categoria) e scegli il tipo: Thunderbird carica il file e compare tra i documenti dell'articolo. Per allegare a una mail un file del magazzino, "Dal magazzino…" apre la ricerca dei documenti come nella pagina Documenti.

La posta è **solo di chi la riceve**: nessun altro del workspace la vede, nemmeno gli admin. Thunderbird resta l'unico a conoscere le password della posta. Con "Passa a Organizer tutta la posta in arrivo" (opzioni dell'estensione, attivo di base) le mail ricevute vengono copiate nel database di Organizer (nel tuo workspace predefinito, visibili solo a te). Spento, l'estensione manda a Organizer solo le risposte alle tue conversazioni, riconosciute confrontando gli identificativi dei messaggi (Message-ID). Con più computer si può installarla su ognuno: la mail si apre su uno solo.

### Senza estensione

Un link `mailto:` non può portare allegati, quindi in alternativa c'è un piccolo helper locale da installare una volta per computer:

```bash
make mail-helper
```

Poi in Impostazioni → Mail spunta "Helper Thunderbird installato su questo computer". La prima volta il browser chiede se aprire "Organizer Mail": consenti e ricorda la scelta. Come funziona: il pulsante apre un link `organizer-mail://` con un token valido 15 minuti; l'helper scarica testo e allegati dal server e lancia `thunderbird -compose`. Su macOS è una piccola app in `~/Applications/Organizer Mail.app`, su Linux un file `.desktop`. Rimozione: `make mail-helper-uninstall`. Log: `~/.cache/organizer-mail/helper.log`. Con HTTPS self-signed (Caddy interno) imposta `ORGANIZER_INSECURE=1`.

Senza helper (per esempio dal telefono) **Manda** e **App mail** aprono l'app di posta predefinita senza allegati; **.eml** scarica la mail completa di allegati.

## Contatti

Rubrica condivisa con nome, email, telefono, azienda, ruolo, **fascia oraria** (testo libero: "mattina", "14-18", "Shenzhen (UTC+8)"…) e note, tutto modificabile; azienda, ruolo e fascia oraria suggeriscono i valori già usati. **Raggruppa** per azienda, fascia oraria o ruolo: ogni valore diventa una tab con il suo conteggio. I contatti vengono suggeriti nei campi A/Cc e dopo `>` nella barra rapida; `>luca` diventa l'email del contatto "Luca …". Nella scheda di un contatto ci sono le sue mail e "Nuova mail"; i destinatari usati ma non in rubrica si aggiungono con un clic.

## Cestino

Eliminare sposta nel cestino: voci (con le loro sotto-attività), progetti, articoli, documenti, contatti e thread di mail (con le loro mail scritte in Organizer). Dopo ogni eliminazione compare "Annulla". Dal Cestino si ripristina o si elimina definitivamente; dopo 30 giorni (variabile `TRASH_DAYS`) gli elementi spariscono da soli, file compresi. Scrivere `@tag` o `#CODICE` di qualcosa che è nel cestino lo ripristina.

## Magazzino

Ogni articolo ha il suo **codice** (quello con cui è noto) e può avere dei **codici alternativi** (del fornitore, del produttore, vecchie sigle), da aggiungere nella sua scheda sotto il codice. Un `#ALTERNATIVO` scritto in una voce porta allo stesso articolo, e filtri, ricerca e suggerimenti li trovano; i suggerimenti inseriscono sempre il codice principale. Ogni codice appartiene a un solo articolo. Scrivendo un alternativo come nuovo codice dell'articolo, diventa il principale e quello di prima resta tra gli alternativi.

Ogni articolo ha uno **stato**: attivo, **in valutazione** (lo si sta provando), **outdated** (superato) o **scartato** (valutato e lasciato perdere), da scegliere nella sua scheda. Negli elenchi e nelle colonne compare come pallino (blu / arancione / rosso) e in cima ci sono i filtri per stato e "nascondi scartati".

Ogni articolo può avere un **link** facoltativo (pagina prodotto, repo, wiki). Nella vista per categoria un articolo si sposta in un'altra categoria **trascinandolo** nella colonna (o in "Nuova categoria").

**Colori**: progetti e categorie hanno un colore automatico, che si può cambiare (pagina del progetto → Colore; categoria → clic sul pallino colorato nella vista per categoria o nella scheda dell'articolo; "A" torna all'automatico).

Il colore di un articolo dipende dalla sua categoria, ovunque compaia (elenchi, `#CODICE` nel testo, suggerimenti); senza categoria è grigio. Si può filtrare per categoria o passare alla vista **per categoria**, a colonne sugli schermi larghi. Nella composizione e nei collegamenti ai progetti il codice si autocompleta; se non esiste viene creato.

Ogni articolo ha codice, descrizione, categoria, versione firmware, posizione, quantità e note (pinout, procedura di flash…). Le note si scrivono in **Markdown**: `# titolo`, `**grassetto**`, `*corsivo*`, `- elenco`, `- [ ] da fare`, `> avviso`, `` `codice` `` e blocchi tra ```` ``` ````; i `#CODICI` e i `[[…]]` restano link. Il Markdown vale anche per i dettagli di todo e diario, le note di progetti e contatti e le note sui documenti; non per il testo delle mail, che parte così com'è. Gli carichi documenti (firmware, datasheet, schemi, footprint, manuali, foto) o link esterni. Un file di tipo firmware con versione aggiorna da solo il campo Firmware, e per ogni file si vede lo sha256. "Composizione" collega prodotti e schede. In basso trovi tutte le voci che citano quel `#CODICE`. Se rinomini un codice, i riferimenti nel testo delle voci vengono aggiornati.

## Workspace e più persone

Un **workspace** è un insieme di dati separato (progetti, voci, magazzino, contatti, documenti) con i suoi membri. Lo stesso account può stare in più workspace con ruoli diversi: admin in uno, membro in un altro. Si cambia dal selettore in cima alla barra laterale (su telefono: Impostazioni → Workspace); chiunque può crearne uno nuovo e ne diventa admin.

- **Inviti**: Impostazioni → Persone → **Crea invito** (solo admin) e mandi il link. Chi non ha un account si registra; chi ce l'ha già accede con le sue credenziali (o, se è già collegato, preme "Entra nel workspace"). Link valido 7 giorni, per una persona.
- **Admin del workspace**: invita, toglie persone, nomina altri admin, rinomina o elimina il workspace, fa backup e ripristino. Un workspace ha sempre almeno un admin.
- **Privato di default**: dentro un workspace magazzino e documenti sono di tutti; todo, diario, mail, progetti, contatti e note sui documenti li vede solo chi li ha creati (e chi ha una voce assegnata), finché non li condivide con `+persona`, `++persona` (e gliela assegna) o `+all`, oppure da "Visibile a". Vale anche per gli admin. Le modifiche arrivano in tempo reale solo a chi è nello stesso workspace.

**Permessi**: in Impostazioni → Permessi un admin sceglie per ogni persona (non admin) cosa vede e cosa può modificare in ogni area: todo e diario, mail, progetti, magazzino, documenti, contatti, chat. Per ogni area: nessun accesso (l'area sparisce dall'app), lettura o scrittura. Le aree collegate si sistemano da sole: dando la scrittura alle mail, contatti, documenti, magazzino e progetti diventano almeno leggibili. Il server controlla ogni richiesta, quindi i permessi valgono anche per la CLI e per i bot. I permessi decidono cosa si può fare nelle aree, non fanno vedere ciò che gli altri non condividono; la posta in arrivo da Thunderbird è sempre solo di chi la riceve. In più c'è **Gestire i canali** (sì/no, di base no) per la chat.

Sul server: `accounts.db` contiene account, sessioni, workspace e inviti; ogni workspace ha il suo file (`organizer.db` il primo, `ws-<id>.db` gli altri). Aggiornando da una versione senza workspace, l'installazione esistente diventa il workspace "Principale" (nome cambiabile con `WORKSPACE_NAME`) con gli stessi utenti e ruoli.

## Chat

Ogni workspace ha una chat a **canali** (Chat nella barra laterale; su telefono l'icona in alto). #generale è di tutti; gli altri canali hanno le loro persone, ognuna che legge o anche scrive. Li creano e li gestiscono gli admin e chi ha il permesso "Gestire i canali". Nei messaggi si collegano le cose dell'app: `@progetto`, `#CODICE`, `+persona` e, scrivendo `[[`, un documento, una voce (todo, mail, nota) o un contatto, scelti dai suggerimenti. Nel messaggio diventano link con il nome sempre aggiornato. Il numero sul badge sono i messaggi non letti di tutti i canali; dal terminale `org chat -f` la segue dal vivo (`-c canale` per un canale, `org chat canali` per l'elenco).

## Notifiche

La campanella in alto raccoglie le notifiche: citazioni (+persona in voci, aggiornamenti, note sui documenti e chat), voci assegnate o condivise, mail arrivate (con l'estensione di Thunderbird) e i messaggi dei canali (nei canali silenziati solo le citazioni). In Impostazioni → Notifiche si attivano anche come **notifiche di sistema** su ogni dispositivo: arrivano ad app chiusa. Su iPhone/iPad servono l'app installata sulla schermata Home e iOS 16.4 o successivo; su Mac funzionano da Safari, dall'app nel Dock e da Chrome. Le chiavi per le notifiche (VAPID) si creano da sole in `/data/vapid.json` e finiscono nei backup; `PUSH_SUBJECT` (es. `mailto:tu@esempio.it`) è facoltativo.

## Offline

Senza rete l'app mostra gli ultimi dati sincronizzati in sola lettura. Si possono creare todo (Agenda) e note (Diario): restano in coda ("in coda offline") e finché non partono si cambiano, si segnano fatte o si eliminano. Quando la rete torna partono da sole; ognuna ha un identificativo, quindi un invio interrotto e ripetuto non crea doppioni. Il resto (mail, progetti, magazzino, modifiche alle voci esistenti) aspetta la rete: così non ci sono conflitti con le modifiche degli altri.

## Feedback

"Feedback" accanto a Novità (su telefono in Impostazioni → App e aiuto) manda un errore o un'idea con testo e screenshot. Li rivede chi gestisce l'istanza (gli admin del primo workspace) nella pagina Feedback; dal terminale `make feedback` li esporta in `feedback/` (una cartella per feedback con `feedback.md` e le immagini; `ALL=1` anche i risolti). Le immagini stanno in `/data/feedback` e finiscono nei backup.

## Giro di Organizer

Alla prima entrata l'app chiede se fare il giro (si rifà da Impostazioni → App e aiuto). Il giro apre un **workspace di prova** solo tuo, con contenuti finti (progetti, magazzino, un PDF e un modello 3D con le note, mail, chat; Anna e Luca esistono solo lì e non ricevono niente), e mostra le parti dell'app una alla volta sull'app vera: ci si può scrivere e provare. Alla fine si elimina con un clic e si torna al proprio workspace, oppure si tiene (nel menu dei workspace è segnato "di prova") e si elimina più tardi dalla stessa sezione delle Impostazioni.

## Terminale (CLI) e API

`org` è la CLI: un eseguibile a parte (cartella `cli/`, serve Node 22) per fare dal terminale quasi tutto quello che si fa nell'app: scrivere e riorganizzare voci, progetti e magazzino, caricare e scaricare documenti, preparare mail con allegati.

```bash
make cli                          # installa il comando org
org login http://localhost:8080   # utente e password, una volta
org add 'flash fw #SCH-042 @rover !ven'
org ls -p rover
org doc up SCH-042 fw_2.4.0.bin -V 2.4.0
```

Guida completa in [cli/README.md](../cli/README.md). La CLI usa le API pubbliche, le stesse per bot e script: si autenticano con un **token** creato in Impostazioni → *CLI e token API* (o da `org login`). Endpoint ed esempi in [docs/API.md](API.md).

## Telefono e altri computer

L'app ascolta solo sul computer che la ospita (`http://localhost:8080`): nessuna porta aperta, nemmeno in rete locale. Da qualsiasi altro dispositivo, in casa o fuori, ci si arriva con il proprio dominio attraverso **Cloudflare Tunnel** (gratuito): HTTPS valido, installazione come app su telefono e modalità offline.

```bash
make tunnel        # dopo aver messo TUNNEL_TOKEN nel file .env
make tunnel-status
make tunnel-off
```

La configurazione passo passo (dominio su Cloudflare, tunnel, telefono, sicurezza, trasloco su Raspberry) è in [docs/DEPLOY.md](DEPLOY.md). Per riaprire l'app in rete locale senza tunnel: `APP_BIND=0.0.0.0` in `.env`.

Installazione: iPhone → Safari → Condividi → "Aggiungi alla schermata Home". Android → Chrome → "Installa app". Mac → Safari "Aggiungi al Dock" o Chrome. Linux → Chrome/Chromium.

Offline: l'app si apre con gli ultimi dati sincronizzati e le voci scritte nella barra rapida vanno in coda; partono appena torna la rete.

## Hosting futuro

Su un VPS con un dominio che punta al server:
```bash
SITE_ADDRESS=todo.miodominio.it CADDY_TLS="tls tu@mail.it" docker compose --profile https up -d
```
Caddy ottiene il certificato Let's Encrypt da solo. Puoi togliere la porta `8080` pubblica in `docker-compose.yml` (impostando `APP_PORT=127.0.0.1:8080`).

## Esportare e importare i propri dati

Chiunque, non solo gli admin: Impostazioni → *I tuoi dati* (*Backup e dati* per gli admin).

- **Esporta i miei dati** scarica un `.zip`: dentro `organizer-export.json` (leggibile) e in `files/` i file veri. Contiene tutto il magazzino e i documenti del workspace (sono di tutti) e quello che hai creato tu: todo, diario, mail scritte, progetti, contatti, note sui documenti, la tua posta. Le cose private degli altri e la chat no. Solo le aree che puoi leggere.
- **Importa dati…** aggiunge un'esportazione al workspace in cui sei, anche su un altro server, **senza sovrascrivere niente**: un articolo con lo stesso codice (o alternativo) resta com'è e prende solo i documenti che gli mancano; un progetto con lo stesso tag e un contatto con la stessa mail si uniscono a quelli che ci sono. Tutto quello che arriva diventa tuo. Le aree in cui non puoi scrivere si saltano (il riepilogo lo dice). I collegamenti `[[…]]` nei testi puntano alle cose nuove; quelli a cose non esportate diventano il loro nome in chiaro.

## Backup

- Solo database: Impostazioni → Backup e dati (admin) → **Scarica backup** (file `.db`). Contiene tutto il workspace, anche le cose private dei membri: per spostare solo le proprie cose c'è l'esportazione qui sopra.
- Ripristino dal browser: stesso pannello → **Ripristina da backup…** con un file `.db`, anche di una versione precedente dell'app (viene aggiornato). Prima di sovrascrivere il server salva una copia del database attuale (`pre-restore-*.db` nel volume, tiene le ultime 3); dopo, tutti rientrano con le credenziali del backup. I file caricati non sono nel `.db`: se mancano, il ripristino lo segnala.
- Tutto (database + file caricati): `make backup` crea `backups/organizer-AAAAMMGG-HHMMSS.tgz`
  (ferma l'app per qualche secondo così la copia di SQLite è coerente).
- Ripristino: `make restore FILE=backups/organizer-....tgz`.

## Manutenzione

```bash
make users
make workspaces
make reset-password UTENTE=marco
make make-admin UTENTE=marco WS=2
make invite WS=2
```

Variabili: `APP_PORT` (porta pubblicata, predefinita 8080), `MAX_UPLOAD_MB` (predefinito 200), `TRASH_DAYS` (predefinito 30).

## Struttura

```
server/       HTTP, API REST, autenticazione, SSE (Node, solo moduli standard)
  db.js       schema SQLite e migrazioni (PRAGMA user_version)
  demo.js     dati dimostrativi (make demo / make seed)
  mail.js     allegati, .eml e pacchetto per l'helper Thunderbird
  thunderbird.js  ponte con l'estensione di Thunderbird (coda, mandate, risposte, conversazioni)
  contacts.js rubrica
  trash.js    cestino e pulizia automatica
  backup.js   ripristino di un backup .db dal browser
  tokens.js   token API per la CLI e i programmi esterni
  chat.js     chat del workspace
public/       PWA senza build: HTML, CSS, moduli ES
  js/parse.js parser della barra rapida, condiviso con il server
cli/          la CLI `org` (eseguibile a sé, usa solo le API pubbliche)
docs/API.md   API per CLI, bot e script
CHANGELOG.md  novità di ogni versione
test/         node --test
tools/        generatore icone, helper Thunderbird (organizer-mail.sh) e suo installer
thunderbird/  estensione Organizer per Thunderbird (si scarica da Impostazioni)
public/vendor/pdfjs  PDF.js 6.4.299 (Apache-2.0), solo i file necessari al visualizzatore
public/vendor/three  three.js 0.186.1 (MIT) e i suoi addon per STL, 3MF e la rotazione della vista
public/vendor/occt   occt-import-js 0.0.23 (LGPL-2.1, OpenCascade) per leggere gli STEP, in un worker
public/vendor/dxf-parser  dxf-parser 1.1.2 (MIT) per leggere i DXF
```

Dati: `/data/organizer.db` (SQLite, WAL) e `/data/uploads/` nel volume `organizer-data`.

Sicurezza: password con scrypt, sessioni in cookie HttpOnly (token salvati come hash), protezione CSRF tramite header obbligatorio, limite tentativi di login, file scaricati serviti con `nosniff` e CSP sandbox.
