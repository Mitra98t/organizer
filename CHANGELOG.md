# Changelog

Le novità di ogni versione, dalla più recente. Le versioni sono i tag git (`v0.7`, `v0.6.2`…); il numero in `package.json` è lo stesso.
Aggiornando non serve fare niente a mano: il database si migra da solo all'avvio (la versione dello schema è indicata quando cambia).

## 0.20.2 — 2026-10-30
- **Ricerca nei PDF (⌘F) sistemata** per i PDF con font asiatici, frequenti nei datasheet: mancavano le tabelle dei caratteri di PDF.js (cMaps), e quel testo non si leggeva né per la ricerca né per la selezione. Aggiunte anche le tabelle dei colori (ICC). Se la lettura fallisce lo stesso, la barra dice il motivo.
- **Suggerimenti più informativi** (`[[`, `#`, `@`, `>` e la barra comandi): sotto il nome una seconda riga con il contesto. Una nota su un file dice articolo, documento, chi l'ha scritta e il testo evidenziato; un documento l'articolo, la versione e le note aperte; una todo progetti, scadenza, assegnatario e articoli; una conversazione topic, messaggi e ultimo messaggio; un articolo categoria, posizione, firmware, codici alternativi e documenti; un progetto il progetto padre e le voci aperte. I collegamenti nei titoli si leggono con il loro nome.
- **Menu dei suggerimenti largo quanto serve** (fino a 960 px su desktop), anche quando il campo è stretto o a destra, come le note di un documento: si allarga verso sinistra. Sul telefono prende tutta la larghezza.
- Ricerca nei documenti (⌘F) più tollerante: maiuscole, accenti, spazi (anche quelli non separabili dei PDF) e trattini tipografici non contano. Se un PDF non ha testo (una scansione) o il testo non si legge, la barra lo dice invece di "nessun risultato".

## 0.20.1 — 2026-10-30
- Il menu dei suggerimenti (`[[`, `#`, `@`, `+`…) scorre insieme alla selezione con le frecce, ed è più largo (fino a 720 px): titoli e dettagli si leggono per intero.

## 0.20 — 2026-10-30
- **Note su un pezzo di testo nei PDF**: trascinando sul testo (o con doppio o triplo clic) la nota si attacca a quel testo, che resta evidenziato nel documento e citato nella nota; il clic su un punto per una nota lì resta com'è. Cliccando il testo evidenziato si apre la sua nota. Sul telefono: tieni premuto per selezionare, poi **Nota sul testo**. La citazione compare anche in `org doc notes` e nella todo creata dalla nota.
- **Citare una nota di un documento con `[[`**: le note sui file (anche quelle su un pezzo di testo) compaiono nei suggerimenti di `[[` e nella barra comandi come "nota su file"; il link `[[nota:ID]]` apre il documento sulla nota, e la nota selezionata mostra le voci che la citano ("Citata in"). Una nota non condivisa con te si vede come "non hai permessi sufficienti". Funziona anche nell'esportazione e importazione dei dati.
- Schema dati v23.

## 0.19 — 2026-10-30
- **Esporta e importa i tuoi dati** (Impostazioni → I tuoi dati, per tutti, non solo gli admin): un `.zip` con tutto il magazzino e i documenti (con i file) e quello che hai creato tu, posta compresa; niente cose private degli altri. Importandolo in un altro workspace, o su un altro server, i dati si aggiungono senza sovrascrivere: articoli già presenti restano come sono e prendono solo i documenti mancanti, progetti con lo stesso tag e contatti con la stessa mail si uniscono, i collegamenti `[[…]]` si aggiornano. Le aree in cui non puoi scrivere si saltano.

## 0.18.1 — 2026-10-30
- Correzione: il logo in alto a sinistra (barra laterale e pagina di accesso) usa l'icona dell'app scelta e cambia subito.

## 0.18 — 2026-10-30
- **Icona dell'app a scelta** (Impostazioni → Aspetto): una per ogni tema (le funky con lo sfondo sfumato) e alcune minimal (spunta nera, bianca o verde, punto, cerchio, casella), scelte indipendentemente dal tema; "Automatica" segue il tema. Vale per il dispositivo: cambia subito l'icona della scheda del browser e quella che il sistema prende quando installi l'app. Per l'app già installata va rimossa e aggiunta di nuovo (con Chrome su Android a volte si aggiorna da sola).
- Le icone le disegna il server, in SVG e PNG nelle misure che servono, senza file in più.

## 0.17.6 — 2026-10-30
- **Codici di 2 caratteri**: una lettera e una cifra (`Q5`, `R1`) si collegano da soli nelle mail, come parola a sé (non dentro `Q55`). Le sigle di sole lettere o sole cifre restano escluse.
- All'avvio il server ricontrolla i collegamenti automatici delle conversazioni attive con le regole della versione: chi aggiorna non deve fare niente.

## 0.17.5 — 2026-10-30
- **Collegamenti che non valgono più**: se il codice di un articolo cambia o gli si toglie un codice alternativo, le conversazioni di mail attive che non lo citano più perdono il collegamento automatico. Quelli messi a mano restano. Anche una conversazione che torna attiva viene ripulita così.

## 0.17.4 — 2026-10-30
- **Collegamenti delle mail sempre aggiornati**: quando nasce un articolo, ne cambia il codice o gli si aggiunge un codice alternativo, le conversazioni di mail attive che lo citano (anche scritto alla buona) gli si collegano da sole. Quelle archiviate si ricontrollano per intero quando tornano attive. I collegamenti tolti a mano non tornano.

## 0.17.3 — 2026-10-30
- Mail: nelle schede dei topic non c'è più il pallino per cambiare colore (si cambia aprendo il topic); la scheda mostra il colore nel bordo in alto.

## 0.17.2 — 2026-10-30
- **Codici scritti alla buona**: nelle mail un codice di magazzino con dei numeri si collega anche scritto senza trattini, punti o barre e senza gli zeri davanti ai numeri: `sch44`, `SCH.044` e `sch-44` trovano SCH-44. Vale per i codici principali e per quelli alternativi.
- Correzione: nella barra comandi le persone di una conversazione compaiono una volta sola.

## 0.17.1 — 2026-10-30
- **Temi nuovi** (Impostazioni → Aspetto): Monokai Pro, Ayu Mirage, Night Owl, Material Palenight tra gli scuri; Rosé Pine Dawn e Ayu Light tra i chiari.
- **Temi funky**, in una sezione loro: Synthwave '84, Vaporwave, Matrix, Terminale ambra, Cobalt2, Shades of Purple, Halloween, Bubblegum, Sorbetto e Limonata. Alcuni hanno lo sfondo sfumato dietro ai pannelli, l'accento luminoso (pulsanti, menu e titoli), angoli più tondi; Matrix e Terminale ambra usano il carattere da terminale.

## 0.17 — 2026-10-30
- **Barra in basso su telefono rifatta**: Progetti, Agenda, Magazzino, Mail, Impostazioni. Tenendo premuto un tasto si apre attorno al dito un menu radiale con le altre pagine del gruppo (Diario; Documenti; Contatti e Chat; Cestino, Novità, Feedback): scorrendo su una la si apre e prende il posto del tasto. Il menu si apre lontano dal dito e verso il centro dello schermo, così il dito non lo copre. Chat e Impostazioni non stanno più in alto.
- **Barra comandi** (⌘K o ⌘P, su telefono toccando "Cerca"): apre al volo pagine, voci, conversazioni di mail (anche cercando nel testo), articoli, documenti, progetti e contatti, con la ricerca di `[[`; "Cerca ovunque" porta alla pagina Cerca.
- **Barra laterale riordinata**: Progetti, Agenda (Diario), Magazzino (Documenti), Mail (Contatti), Chat; Cestino e Impostazioni in fondo, con Novità e Feedback.
- **Contatti da salvare**: regole per ignorare in un colpo tutti gli indirizzi o i nomi che contengono un pezzo (`noreply`, `@amazon.it`…). Le regole e gli indirizzi ignorati sono dell'account e valgono su tutti i dispositivi (quelli ignorati prima su un dispositivo ci passano da soli).
- **Schede chiudibili su telefono** in Magazzino, Documenti e Mail: "Chiudi tutto" lascia le intestazioni con il loro numero (a destra), toccandone una si apre solo quella.
- **Chat su telefono**: la barra per scrivere resta ferma in fondo, subito sopra la barra del menu; i messaggi scorrono sopra.
- Correzione: "Rispondi" e "Rispondi a tutti" aprono subito la bozza da scrivere (prima, arrivando da un link, si tornava alla mail).
- Correzione: con tante notifiche le righe della campanella si schiacciavano una sull'altra (soprattutto su telefono); ora la lista scorre e le righe sono più ariose. Su telefono anche i tag dei progetti dei topic vanno su una riga loro.
- Account v9.

## 0.16.1 — 2026-10-29
- Correzione: nella pagina di un topic, su schermi non larghissimi, l'albero delle mail (che resta in vista scorrendo) finiva sopra la colonna dei collegamenti. Ora l'albero ha la sua colonna a sinistra e mail e collegamenti stanno uno sotto l'altro a destra.

## 0.16 — 2026-10-29
- **Posta rifatta a topic e conversazioni.** Si riparte da zero: in Organizer restano solo le mail scritte qui (con le loro conversazioni), il resto lo ricarica Thunderbird.
  - **Primo collegamento**: l'estensione carica l'ultimo mese da tutte le cartelle (tranne spam, cestino e bozze), con i messaggi più vecchi citati; vale per ogni persona nuova e, questa volta, per tutti.
  - **Conversazioni ad albero**: ogni risposta sotto la mail a cui risponde, anche a destinatari diversi. Senza riferimenti (Outlook e simili) una mail va nella conversazione con lo stesso oggetto e una persona in comune.
  - **Topic**: raccolgono una o più conversazioni; di base una ciascuno. Nella pagina Mail si trascina una conversazione su un altro topic per unirle. Stella e colore (automatico) per topic e conversazioni.
  - Un **segnalino** con il numero di mail da leggere sta in alto a destra di ogni conversazione e di ogni topic, nelle schede e nell'albero; nell'albero ogni mail da leggere ha il suo pallino.
  - **Archiviare** vale per la singola conversazione; il topic va in archivio quando lo sono tutte e torna attivo con loro.
  - **Pagina del topic**: albero a sinistra, mail scelta al centro (Rispondi, Rispondi a tutti, bozze), a destra collegamenti, persone e allegati della conversazione.
  - Anche il **topic intero** si collega a un progetto (o a un articolo, un documento…), nella colonna a destra: vale per tutte le sue conversazioni, compare nel progetto e nei filtri per progetto.
  - **Collegamenti automatici** da codici di magazzino (anche alternativi) e progetti negli oggetti e nei testi, e da quello che citi nelle mail scritte qui; si tolgono con la × e non tornano.
- **Ricerca con `[[`**: più parole, ognuna in un campo qualsiasi (titolo, persone con il nome in rubrica o l'indirizzo, testo, tipo come "mail" o "documento", codici anche alternativi, versioni). Si possono citare anche le **conversazioni di mail** ricevute, cercando anche nel loro testo intero: `[[marco mail 500mA`. Nella conversazione citata compare "Citata in"; chi non la riceve vede "non hai permessi sufficienti".
- **Allegati e magazzino**: "Dal magazzino…" apre un modale con la ricerca dei documenti (nome, codice, articolo, tipo, versione); ogni allegato ricevuto ha "→ magazzino" con un modale per scegliere articolo e tipo.
- **Estensione per Thunderbird 1.5**: caricamento dell'ultimo mese e versione mostrata in Impostazioni (con un avviso se è vecchia). Va riscaricata e reinstallata.
- Schema dati v22, account v8.

## 0.15 — 2026-10-29
- **Mail a thread**: la pagina Mail mostra le conversazioni come schede su più colonne, divise in **Attivi** e **Archiviati**, con i filtri per stato (da leggere, da mandare, in attesa di risposta), allegati e progetto. Ogni scheda dice chi scrive, l'inizio dell'ultimo messaggio, i progetti e gli articoli collegati.
  - Aprire un thread lo **legge** e basta: resta dov'è. Il tasto a sinistra della scheda (o "Archivia" nel thread) lo **archivia**; torna attivo da solo se arriva o parte un nuovo messaggio.
  - Nella pagina del thread: i messaggi in ordine (i più vecchi raccolti in "messaggi precedenti"), **Rispondi** e **Rispondi a tutti** che preparano la bozza lì sotto, "Nuova mail nel thread", gli allegati ricevuti con "→ magazzino".
  - **Collegamenti**: nella colonna a destra colleghi il thread ad articoli (`#codice`), progetti (`@progetto`), documenti, contatti e voci (`[[`). Un codice di magazzino scritto in una mail ricevuta si collega da solo, e così quello che citi nelle mail che scrivi. L'articolo, il progetto, il documento o il contatto mostrano i suoi thread in "Thread di mail".
  - Quando arriva o parte una risposta a mail vecchie che Organizer non ha, l'estensione di Thunderbird gli passa anche quelle: il thread è completo.
  - **Rinomina** ed **Elimina**: dal menu ⋯ della scheda o accanto al titolo del thread. Eliminato, il thread va nel **cestino** con le mail scritte in Organizer che ne fanno parte, e si ripristina tutto insieme; in Thunderbird le mail restano, e se le ripassa non riaprono il thread.
  - Le mail ricevute e quelle già in Organizer diventano thread da sole (le ricevute già lette tra gli archiviati).
- **Porta il thread in Organizer**: in Thunderbird, tasto destro su una mail (anche vecchia, in Archivio o in qualunque cartella) → "Porta il thread in Organizer". Arriva tutta la conversazione: i messaggi prima di quella mail e tutte le risposte dopo (cercate per oggetto), in un thread solo, già letti ma tra gli **attivi**. Un thread che c'era già torna attivo e si completa.
- **Estensione per Thunderbird 1.4**: serve per i thread e per "Porta il thread in Organizer". Scaricala di nuovo da Impostazioni → Mail e Thunderbird e reinstallala (Thunderbird chiede il nuovo permesso per il menu): token e impostazioni restano.
- **Disegni DXF**: si vedono nel visualizzatore dei documenti, con zoom fino a 12× e le note nei punti, come i PDF. Su carta bianca: linee, polilinee con raccordi, cerchi, archi, ellissi, spline, testi, blocchi e quote; i layer spenti non si vedono. Nella pagina Documenti c'è anche l'anteprima piccola.
- **Giro di Organizer**: alla prima entrata l'app chiede "Vuoi fare il giro?"; si rifà da Impostazioni → App e aiuto. Il giro mostra le parti dell'app una alla volta, sull'app vera, in un workspace di prova solo tuo con contenuti finti (Anna e Luca non esistono). Alla fine lo elimini con un clic (e torni al tuo) o lo tieni per provare ancora; nel menu dei workspace è segnato "di prova".
- **Barra laterale a gruppi**: Agenda con Diario, Progetti, Mail con Contatti, Magazzino con Documenti, Chat; le voci sotto sono rientrate e i gruppi separati da una linea leggera.
- **Suggerimenti più tolleranti**: basta un pezzo di quello che cerchi, anche saltando lettere: `#almar` trova ALDO-MARCO-LUIGI, `#sch42` trova SCH-042. Vale per articoli, progetti, persone, contatti, categorie e collegamenti `[[`.
- Correzione: togliere una persona da un workspace (o eliminare il workspace di prova) mentre aveva l'app aperta poteva fermare il server.
- Schema dati v20, account v7.

## 0.14 — 2026-10-29
- **Notifiche**: la campanella in alto raccoglie le ultime, con il numero di quelle da leggere; aprendone una si va dove serve, anche in un altro workspace. Arrivano:
  - a chi viene **citato** con +persona in una voce, in un aggiornamento, in una nota su un documento o in chat, e a chi riceve una voce **assegnata** (++persona o menu Assegnata) o **condivisa**;
  - quando **arriva una mail** nella posta in arrivo (estensione di Thunderbird) o una risposta a una tua conversazione;
  - per **ogni messaggio** dei canali in cui sei; nei canali **silenziati** (pulsante "Silenzia" nel canale o Impostazioni → Notifiche) solo quando ti citano.
- **Notifiche di sistema**: Impostazioni → Notifiche → "Attiva le notifiche" su ogni dispositivo (Mac, iPhone con l'app installata sulla schermata Home, Android, browser): arrivano anche ad app chiusa, con "Manda una prova". I messaggi dello stesso canale si sostituiscono invece di accumularsi.
- Aprendo una voce o leggendo un canale le sue notifiche si segnano lette; mentre l'app è aperta le nuove compaiono anche in basso.
- `+persona` in un aggiornamento resta scritto, cita la persona e (se la voce è tua) gliela condivide.
- Chi entra nel workspace o in un canale trova letti i messaggi di prima.
- Schema dati v18, account v6.

## 0.13.1 — 2026-10-29
- **Menu a comparsa**: Tipo, Scadenza (o Data per le note), Assegnata e Visibile a si aprono come un menu accanto al pulsante, con la stessa grafica del menu dei tipi di documento. Scadenza: oggi, domani, lunedì prossimo, tra una settimana, tra un mese, un'altra data o nessuna. Visibile a: solo io, tutti, persona per persona (resta aperto mentre si scelgono). Si chiudono cliccando fuori o con Esc; ↑↓ per spostarsi.
- **Citazioni non accessibili**: in chat e negli altri testi, un collegamento a qualcosa che non è condiviso con te (o a un'area che non puoi vedere) mostra "Nota: non hai permessi sufficienti" invece di "voce 12". Le voci archiviate mostrano il loro titolo, quelle eliminate "voce eliminata".
- Correzione (da un feedback): scrivendo una nota su un documento, `+persona` ora suggerisce le persone (serve a condividerla).

## 0.13 — 2026-10-29
- **Tutto è privato di chi lo crea**, tranne magazzino e documenti: todo, diario, mail, progetti, contatti e note sui documenti li vede solo chi li ha creati (e chi ha una voce assegnata). Vale anche per gli admin. I dati già esistenti diventano privati di chi li aveva creati; chi aveva una voce assegnata la vede ancora.
- **Condividere**: `+marco` la rende visibile anche a Marco, `++marco` la condivide e gliela assegna, `+all` (o `+tutti`) la rende visibile a tutti, anche a chi entrerà dopo. Funziona nella barra in alto, nel titolo di una voce, nella barra dei progetti e nel testo delle note sui documenti; i suggerimenti propongono le persone e +all. In ogni voce, progetto, contatto e nota c'è **"Visibile a"**: chi l'ha creato sceglie con chi condividerlo e può togliere la condivisione. Nelle righe si vede di chi è una voce non tua e con chi hai condiviso le tue. "all" e "tutti" non possono più essere nomi utente.
- **Chat a canali**: la chat di prima è #generale (di tutti). Si creano canali con le persone scelte, ognuna che legge o anche scrive; i non letti sono per canale. Li gestiscono gli admin e chi ha il nuovo permesso **"Gestire i canali"** (Impostazioni → Permessi, di base no). CLI: `org chat -c canale`, `org chat canali`.
- **Feedback**: accanto a Novità (su telefono in Impostazioni → App e aiuto) si segnala un errore o un'idea, con testo e screenshot (scelti, trascinati o incollati con ⌘V); pagina, versione e browser si aggiungono da soli. Li rivede chi gestisce l'istanza (admin del primo workspace) nella pagina Feedback, o con `make feedback` che li esporta in `feedback/`.
- **Impostazioni rifatte**: categorie a sinistra (Account, Aspetto, Privacy e condivisione, Mail e Thunderbird, Workspace e persone, Permessi, CLI e token, Barra rapida, App e aiuto, Backup) e riquadri a destra; su telefono un elenco che apre una pagina per volta. Controlli più grandi, titoli e etichette per la lettura da tastiera e con lettori di schermo.
- **Offline**: senza rete si possono creare todo (in Agenda) e note (nel Diario). Restano in coda con "in coda offline" e finché non partono si possono modificare, segnare fatte o eliminare; tutto il resto si legge soltanto (una barra in alto lo spiega). Al ritorno della rete partono da sole, senza doppioni anche se l'invio si interrompe. Solo voci nuove: niente da mettere d'accordo con le modifiche fatte da altri.
- **Inviti come link**: in Impostazioni → Workspace e persone ogni invito è il suo link, da aprire, copiare o condividere; quello appena creato è evidenziato.
- **Permessi a tabella**: una riga per area (con cosa comprende), una colonna per persona, in ogni casella il livello per intero (Nessun accesso, Lettura, Scrittura) con il suo colore; sotto, la riga "Gestire i canali" e la legenda.
- Schema dati v17, account v5.

## 0.12.2 — 2026-10-28
- Correzione: dietro Cloudflare l'app poteva usare fino a 4 ore il codice della versione precedente (Cloudflare dice al browser di tenere JS e CSS 4 ore). Ora l'app ricontrolla sempre i suoi file con il server; un file non cambiato non si riscarica.

## 0.12.1 — 2026-10-28
- **Avviso di nuova versione**: se Organizer viene aggiornato mentre l'app è aperta, in alto compare "È disponibile Organizer X" con **Ricarica** (e il link alle Novità). Si controlla quando la connessione col server si riattiva, quando torni sull'app e ogni 30 minuti.

## 0.12 — 2026-10-28
- **Estensione Organizer per Thunderbird** (Impostazioni → Mail e Thunderbird: si scarica già impostata per il tuo indirizzo, poi un token). Con Thunderbird aperto, **Manda** apre la mail lì con gli allegati, anche se premi dal telefono; Thunderbird resta l'unico a conoscere le password della posta.
- **Stato automatico**: quando la mail parte da Thunderbird diventa "mandata" e "in attesa di risposta" da sola; quando arriva la risposta esce da "in attesa".
- **Conversazioni**: nella mail compaiono i messaggi mandati e le risposte arrivate (senza la citazione dei precedenti, "messaggio completo" per vederla), con i nomi degli allegati. Nelle liste (agenda, progetto, contatto, articolo) le mail con risposte hanno ↩ e il numero.
- **Rispondi** su una risposta arrivata: crea in Organizer la mail di risposta, negli stessi progetti; con Manda si apre in Thunderbird come risposta al messaggio originale, con la citazione sotto.
- **In arrivo**: nella pagina Mail le mail ricevute in Thunderbird (cartelle Posta in arrivo, non lo spam), con **Rispondi** e **Rispondi a tutti** (gli altri destinatari in Cc, senza i tuoi indirizzi) e Archivia. Sono personali: le vede solo chi le riceve, in ogni workspace. Al collegamento l'estensione recupera anche quelle arrivate mentre Thunderbird era chiuso (la prima volta gli ultimi 7 giorni). Nelle opzioni dell'estensione si può spegnere: allora a Organizer arrivano solo le risposte alle mail mandate da Organizer. Dopo 180 giorni le mail in arrivo si cancellano da Organizer (in Thunderbird restano).
- **Allegati nel magazzino**: un allegato di una mail ricevuta (in arrivo o nella conversazione) si salva come documento di un articolo con "→ magazzino", scegliendo codice e tipo. Il file lo prende Thunderbird, che deve essere collegato.
- **La posta è personale**: le mail di Organizer (da mandare, mandate, conversazioni) le vedono solo chi le ha scritte e chi le deve mandare (assegnate); la posta in arrivo solo chi la riceve. Nessun altro membro del workspace, nemmeno un admin, vede la posta degli altri: è scritto anche in Impostazioni → Permessi. Le mail già scritte da altri spariscono dalla tua vista; "privata" non serve più sulle mail.
- **Pagina Mail riorganizzata**: in "Da fare" solo ciò che è aperto (ricevute da leggere, da mandare, in attesa di risposta); le ricevute lette e le mail mandate vanno in **Archivio**. Una mail ricevuta aperta è letta e passa in archivio quando lasci la pagina; il tasto a sinistra la segna letta o da leggere. In alto i filtri: testo (oggetto, persone, indirizzi, testo), tipo, con allegati, progetto.
- Le mail ricevute hanno la stessa grafica delle mail di Organizer.
- **Mail su due colonne**: a sinistra conversazione, testo e aggiornamenti; a destra quello che la lega a Organizer: dettagli (tipo, scadenza, progetti, assegnata), persone (con azienda e ruolo, "+ rubrica" per chi non c'è), allegati in uscita (anche dal magazzino) e ricevuti (→ magazzino), articoli e collegamenti scritti nella mail, chi la cita. Sotto i 1100 px le colonne si impilano.
- **Contatti → Da salvare**: un pannello con gli indirizzi delle tue mail (ricevute, mandate, in copia) che non sono in rubrica, con il nome preso dalla mail: si salvano uno a uno, o si ignorano.
- Rispondi a tutti anche sui messaggi ricevuti nella conversazione di una mail. Il numero sulla voce Mail conta anche le mail arrivate da leggere.
- L'helper `organizer-mail://` resta come alternativa senza estensione.
- Schema dati v15, account v4.

## 0.11 — 2026-10-28
- **Accesso da fuori con Cloudflare Tunnel** al posto di Tailscale: `make tunnel` collega il tuo dominio all'app con HTTPS e senza porte aperte (connessione in uscita); il token sta in `.env`. Guida passo passo in `docs/DEPLOY.md`, anche per il futuro trasloco su Raspberry. Tolti i comandi `make remote`.
- L'app ascolta solo sul computer che la ospita (`127.0.0.1`): niente più porta aperta in rete locale (`APP_BIND=0.0.0.0` per riaprirla).
- Sicurezza dietro il tunnel: il limite dei tentativi di login usa l'indirizzo vero di chi si collega (`CF-Connecting-IP`), non quello del tunnel; in HTTPS il browser riceve HSTS.
- **Anteprima dei modelli 3D**: i documenti STL, 3MF e STEP si aprono in un visore 3D (trascina per ruotare, tasto destro per spostare, rotella per lo zoom, "Vista iniziale" per tornare all'inizio). Gli STEP sono convertiti in triangoli nel browser con OpenCascade, con i colori delle parti; i 3MF tengono i loro colori.
- **Note sui punti del modello**: clicchi sul modello e lasci una nota lì, come sui PDF. I segnaposto seguono la vista, quelli coperti da altre parti si attenuano, si trascinano sulla superficie; cliccando una nota la vista gira verso il punto. `org doc notes` le mostra sotto "Sul modello".
- Schema dati v14.

## 0.10 — 2026-10-28
- **Permessi**: in Impostazioni → Permessi un admin sceglie per ogni persona del workspace il livello di ogni area (todo e diario, mail, progetti, magazzino, documenti, contatti, chat): nessun accesso, lettura o scrittura. Le aree collegate si sistemano da sole (scrivere le mail richiede di leggere contatti, documenti, magazzino e progetti…; l'elenco è nella stessa sezione).
- Senza accesso un'area sparisce dal menu e dalle tab; in sola lettura si vede tutto ma i controlli per modificare sono spenti. Il server controlla ogni richiesta e manda solo i dati che si possono leggere: valgono anche per CLI e bot.
- Chi ha limitazioni vede i propri permessi in Impostazioni.
- Account v3.

## 0.9.2 — 2026-10-28
- Magazzino: **codici alternativi** per gli articoli, oltre al codice principale con cui sono noti. Si aggiungono e si tolgono nella scheda dell'articolo; `#ALTERNATIVO` nelle voci porta all'articolo, filtri, ricerca, suggerimenti e scheda rapida li trovano. Ogni codice appartiene a un solo articolo; scrivendo un alternativo come nuovo codice diventa il principale e il vecchio resta tra gli alternativi. CLI: `org item alias`.
- Tipo di documento: il menu che si apre ha le voci con il loro colore (il menu di sistema sul Mac non le colorava); si usa anche con la tastiera (↑↓, Invio, Esc).
- Correzione: i file `.json` non si caricavano come documenti né come allegati (dalla CLI e dall'app il server li scambiava per la creazione di un link: "Il link deve iniziare con http://"). Ora un caricamento si riconosce dal nome del file nella richiesta.
- Schema dati v13.

## 0.9.1 — 2026-10-28
- Note sui PDF e sulle immagini: i segnaposto si trascinano in un altro punto, anche su un'altra pagina (vicino ai bordi il documento scorre). Un clic senza trascinare seleziona la nota come prima.

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
