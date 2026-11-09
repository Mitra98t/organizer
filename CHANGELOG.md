# Changelog

What's new in each version, most recent first. Versions are the git tags (`v0.7`, `v0.6.2`…); the number in `package.json` is the same.
Updating needs nothing by hand: the database migrates by itself at startup (the schema version is given when it changes).

## 0.29.1 — 2026-11-09
- **Attachments sent** in a topic's side column, under the received ones: the files of the conversation's sent mails, both those attached in Organizer (with the item's code if they come from the inventory) and those of messages sent from Thunderbird (with the preview). A mail written here that comes back as a sent message is not counted twice.

## 0.29.0 — 2026-11-09
- **Archiving journal notes**: a note no longer needed is archived instead of deleted (open it, **Archive**; "Undo" in the message). It leaves the Journal and the Journal sections of projects and items and goes into **Archived notes**, closed, at the bottom of the same pages, where **Active again** brings it back. Search and links still find it.
- CLI: `org ls --note` leaves archived notes out (`--all` shows them), `org show` says when it was archived.
- Data schema v27.

## 0.28.0 — 2026-11-09
- **From a piece of a mail to a todo or a note**: select some text in the mail you are reading and a small **+** appears next to it (on a phone below the selection). It opens a window: **Todo in the Agenda** or **Note in the Journal**, a title (with the bar's syntax and its suggestions: `!fri`, `@project`, `#code`) and the quoted text, which can be changed. The entry keeps the text as a quote in its details with the link to the conversation, which lists it under "Mentioned in".

## 0.27.4 — 2026-11-09
- **Quoting levels in colour**: in received mails each level of quoting has its own muted colour (blue, green, ochre, plum, then again), on the line and on the text, so it's easier to see who wrote what. The messages of an Outlook history share the first level.

## 0.27.3 — 2026-11-09
- **Quoted text easier to read**: the history Outlook appends to a reply (From / Sent / To / Subject, also in Italian, German, French and Spanish) is split into its messages, one under the other, each with a compact header (sender, date, subject) and its own quotes. "On … wrote:" and "Il … ha scritto:" become "Name · date". The noise of mails converted from HTML (`[cid:…]` images, `<mailto:…>`, links written twice, runs of blank lines) is gone.

## 0.27.2 — 2026-11-09
- **Received mails read like in a mail program**: quoted lines are indented (also nested), so replies written between the quoted lines ("inline") are visible instead of being cut off; "On … wrote:" in grey; the quote at the bottom (and Outlook's "Original Message") folded into "quoted text (n lines)"; forwarded messages visible; the signature in grey; links clickable. The previews in the lists show the text outside the quotes.

## 0.27.1 — 2026-11-09
- **Moving entries between chains by dragging**: an entry under another one, dragged onto a third, moves there (it no longer waits for the first one). Dropped on **Drop here: it no longer waits**, at the bottom while dragging, it leaves every chain and goes back to its date; dropped on the Eventually column it becomes "eventually" on its own. "Undo" in the message.
- No more permanent hints about dragging (Agenda, Projects, Inventory, Mail, Documents): the drop zones show up only while something is being dragged.

## 0.27.0 — 2026-11-09
- **Eventually**: things that will happen but nobody knows when ("Mirko lands", "repaint the lab") get `!eventually` (Italian `!primaopoi`), or **Eventually** in the date menu. They are not "no due date" (still to be scheduled): the Agenda keeps them in a column on the right, a third of the width, with what waits for them underneath (on a phone the column is below). They never become overdue; a date takes them out.
- **Drag and drop in the Agenda**: drag an entry onto another and it waits for it; drag it onto the Eventually column and it becomes "eventually". "Undo" in the message. On a phone, hold the entry for a moment and then drag.
- The history says "due date 12/11 → eventually"; the CLI shows "eventually" instead of a date.
- Data schema v26.

## 0.26.0 — 2026-11-09
- **Entries that wait for others**: "try the PS5 with Mirko" can wait for "Mirko lands". Write `^` and part of the other title in the bar (`^mirko`, the menu offers the open todos and mails), or open the entry and use **Waits for**; under **Then** you write what comes after. Until what it waits for is done, the entry is not in Overdue, Today or the other dates: it sits under that entry in the Agenda, in a chain, and does not count as overdue. When the first one is done it goes back to its date, and whoever has it is told they can go on. Entries whose chain is not in the Agenda (filtered out) are under **Waiting**. No loops, and notes cannot wait.
- CLI: `org add "… ^17"` works, `org show` lists what an entry waits for and what comes after.
- A few labels were still in Italian in the English interface (the "new" badge on the phone, the bar's help, two suggestions, "pinned").
- Data schema v25.

## 0.25.3 — 2026-11-08
- **Downloaded documents always keep their extension**: a renamed document takes the original file's extension also when the new name ends with a dot ("datasheet." → `datasheet.pdf`, not `datasheet..pdf`), when the original has a double extension (`.tar.gz`) and when it was uploaded without one (then it comes from the file's type, e.g. a PDF gets `.pdf`). Same in "Download all".

## 0.25.2 — 2026-11-08
- **The app's own windows instead of the browser's**: renaming a document, new workspace, new kind or category, adding a link (address and label in one window), confirmations before deleting, tokens and passwords to copy now open in a window in the app's style instead of the browser's grey boxes. Enter confirms, Esc or Cancel closes; deletions have a red button with what it does ("Move to the trash", "Delete for good"…); a token comes with a Copy button.

## 0.25.1 — 2026-11-08
- **A quieter interface**: section titles, entry kinds, document kinds, menus and categories are written normally instead of in spaced capitals; fewer bold texts and one scale of text sizes; spacing and rounded corners made regular. The kind of an entry (Todo, Mail, Note) is a coloured word without a background, and "new" next to What's new is plain text.
- Light theme: the green is a little darker, so white text on it reads well.
- What's new has a newspaper icon instead of the sparkle; the update bar an arrow.
- The radial menu on the phone opens without bouncing.
- The version field in an item's documents bar was not translated.

## 0.25.0 — 2026-11-08
- **Web pages as documents**: a link document that is not a PDF now shows the page itself, drawn as on a computer and shrunk like a PDF page, with notes on its points (click, drag the pin, → todo, as in PDFs). The first time it opens the server saves a copy of the page, so notes stay in place even if the site changes and the page survives if it disappears; **Update** in the toolbar downloads it again. The copy has no scripts: pages built by JavaScript may come out incomplete, and sites that refuse automatic downloads say so, with the original link at hand.
- **Page preview of an item's link**: the globe next to the link opens a small browser over the app; its links open inside it (← to go back, ⌘/Ctrl+click in the browser). **Save as document** turns the page into a document of the item, ready for notes.
- `REMOTE_ALLOW_LAN=1` lets the server load links on the local network too (an internal wiki), for PDF and page previews. Off by default.
- The reason of an error from a remote site (not answering, too large, refusing automatic downloads) now reaches the app instead of a generic "internal server error".
- Data schema v24.

## 0.24.0 — 2026-11-06
- **English and Italian**: the app, the server's messages and notifications, the guided tour, the CLI and the Thunderbird extension speak English, with Italian as a second language. In the app: Settings → App and help → Language (per device; by default the browser's language). Notifications arrive in the language each person last used. The CLI follows `ORG_LANG=it` or an Italian `LANG`; the extension follows Thunderbird's language. The quick bar understands the date words of both (`!tomorrow`, `!domani`, `!fri`, `!ven`, `!3d`, `!3g`…).
- **Open source** under the AGPL-3.0 license; the bundled libraries and their licenses are listed in `THIRD-PARTY.md`.
- Documentation in English: README, `docs/GUIDE.md` (was `GUIDA.md`), `docs/API.md`, `docs/DEPLOY.md`, `cli/README.md`.
- CLI: the built-in document kinds also have English names (`schematic`, `manual`, `photo`, `other`); `org chat channels` (the old `canali` still works).
- Makefile: `make reset-password NAME=…` and `make make-admin NAME=…` (was `UTENTE=`); destructive commands ask for "yes".
- **Thunderbird extension 1.8**: in English and Italian. Download it again from Settings → Mail and Thunderbird and reinstall it (token and settings stay).
- Account schema v10.

## 0.23.0 — 2026-11-05
- **Inventory trees**: a third view in the Inventory draws what makes up what as a graph. Each item that contains others has its components on the right, linked by lines, all the way down; the number on the card collapses or reopens a branch; an item used in several places shows up under each one. The filter keeps the trees containing the items found (highlighted); "Show the tree" on an item's page shows only its own.
- **Moving and copying documents** between items: the icon next to the name (on the item's page and in the viewer) opens the item search with "Move to…" (the document with its notes) and "Copy to…" (a new file, without notes). A firmware with a version also updates the destination item. CLI: `org doc mv ID… CODE` and `org doc cp ID… CODE`.
- **PDF zoom with pinch and ctrl/⌘ + wheel**, around the point under the pointer (images and DXF too). Pages grow right away while zooming and are redrawn sharp when you stop.
- **Mail and workspaces**: in the Thunderbird extension's options choose, for each mail account, which workspace its new conversations go to (no choice: the default one). A topic already in Organizer moves to another workspace from its ⋯ menu, with its conversations and the mails written here; links to things of the previous workspace are lost, the automatic ones are redone with the inventory over there.
- **Open in Thunderbird** under each message opens it in Thunderbird, in a tab.
- The last two need the **Thunderbird extension 1.7**.
- **Send on the first click**: before, with the mail's text being edited, the first click only closed the field (which moved the button as it was redrawn).
- The quick bar stays attached to the header while the page scrolls: no more gap where the content showed through.

## 0.22.0 — 2026-11-02
- **Preview of received attachments**: PDFs, images, DXF drawings, 3D models, texts and CSV tables attached to a mail open with "preview" (or by clicking the name) without saving them: the file arrives from Thunderbird in a few seconds. From the preview "→ inventory" saves it in an item right away; back (or Esc) returns to the mail. Needs the **Thunderbird extension 1.6**.
- **Fewer false "offline"**: an interrupted request (Safari loses some when the Mac wakes up or the network changes) no longer puts the app offline if the server answers; it simply retries. While the server restarts for an update the bar says "the server does not answer" instead of "you are offline", and as soon as it is back the app reopens real-time updates by itself.

## 0.21.3 — 2026-11-02
- **New mail from the topic page**: under the list of conversations, a button opens a new conversation in the same topic with the draft ready on the right.
- A mail written here gives its conversation its subject (or title), as long as the conversation has no other messages, even when changed later.

## 0.21.2 — 2026-11-01
- **Markdown outside the inventory too**: details of todos and journal notes, notes of projects and contacts and notes on documents read formatted, like item notes. The text of mails stays plain, because it goes out as it is.

## 0.21.1 — 2026-11-01
- CSV tables with many columns scroll sideways instead of squeezing into the window: each column is as wide as its content, up to about 420 px, and long texts wrap between words. Header and row numbers stay fixed on the edge.

## 0.21 — 2026-11-01
- **Download all**: in an item's Documents section, with several files, a button downloads them all in a `.zip` (`CODE-documents.zip`) with the names given in the app.
- **Table viewer** for `.csv`, `.tsv` and `.scsv` files: columns in a table, zebra rows, fixed header and row numbers; separator recognised by itself, quotes handled, Excel CSVs (Windows-1252) with the right accents. ⌘F searches the cells too. On the Documents page the hover preview shows the first rows.

## 0.20.5 — 2026-11-01
- **New item status "being evaluated"** (blue dot), besides active, outdated and discarded: chosen on the item's page, shown in the lists, with its own filter. CLI: `org item set CODE -s evaluation`. On the phone the statuses sit on their own row, so the item's code stays readable.
- **Item notes in Markdown**: headings, bold, italic, strikethrough, code, bulleted and numbered lists (nested too), checkboxes, quotes, code blocks, rules and links. `#CODES`, addresses and `[[…]]` links stay clickable.
- Removed the "Documents" button in the inventory and "Inventory" in the documents: the sidebar and, on the phone, the bottom bar lead there.

## 0.20.4 — 2026-10-30
- In the suggestions (and the command bar) the kind label is as wide as the longest in the list, so the names always start from the same column.

## 0.20.3 — 2026-10-30
- **PDF search (⌘F) works again in Safari and in the app installed from the Dock**: the text was read with a construct Safari does not support, so no page was readable.

## 0.20.2 — 2026-10-30
- **PDF search fixed** for PDFs with Asian fonts, frequent in datasheets: PDF.js's character tables (cMaps) and colour tables (ICC) are now bundled. If reading fails anyway, the bar says why.
- **More informative suggestions** (`[[`, `#`, `@`, `>` and the command bar): a second line with the context (item, version, open notes, projects, due date, topic, category, location…).
- **Suggestions menu as wide as needed** (up to 960 px), growing to the left when the field is narrow or on the right; full width on the phone.
- Search in documents is more forgiving: case, accents, spaces (the PDFs' non-breaking ones too) and typographic dashes do not count. A PDF without text (a scan) says so instead of "no results".

## 0.20.1 — 2026-10-30
- The suggestions menu scrolls along with the selection when using the arrows, and it is wider (up to 720 px).

## 0.20 — 2026-10-30
- **Notes on a piece of text in PDFs**: dragging over the text (or double/triple click) attaches the note to that text, which stays highlighted in the document and quoted in the note. Clicking the highlighted text opens its note. On the phone: hold to select, then **Note on the text**. The quote also shows in `org doc notes` and in the todo created from the note.
- **Quoting a note on a document with `[[`**: notes on files show up in the `[[` suggestions and in the command bar as "note on file"; `[[nota:ID]]` opens the document on the note, and the selected note shows the entries that quote it. A note not shared with you shows as "not enough permissions". It also works in data export and import.
- Data schema v23.

## 0.19 — 2026-10-30
- **Export and import your data** (Settings → Your data, for everyone, not only admins): a `.zip` with the whole inventory and documents (with the files) and what you created, mail included; nothing private of other people. Importing it into another workspace, or on another server, adds the data without overwriting: items already there stay as they are and only get the documents they lack, projects with the same tag and contacts with the same email are merged, `[[…]]` links are updated. The areas you cannot write to are skipped.

## 0.18.1 — 2026-10-30
- Fix: the logo at the top left (sidebar and sign-in page) uses the chosen app icon and changes right away.

## 0.18 — 2026-10-30
- **Choosable app icon** (Settings → Appearance): one per theme and some minimal ones, independent from the theme; "Automatic" follows the theme. Per device: the browser tab's icon changes right away, and so does the one the system takes when you install the app. The server draws the icons, in SVG and PNG at the sizes needed.

## 0.17.6 — 2026-10-30
- **2-character codes**: a letter and a digit (`Q5`, `R1`) link themselves in mails, as a word of their own. Letters-only or digits-only names stay excluded.
- At startup the server rechecks the automatic links of the active conversations with the version's rules.

## 0.17.5 — 2026-10-30
- **Links that no longer apply**: if an item's code changes or an alternative code is removed, the active mail conversations that no longer mention it lose the automatic link. Manual ones stay.

## 0.17.4 — 2026-10-30
- **Mail links always up to date**: when an item is born, its code changes or it gets an alternative code, the active mail conversations that mention it (even written loosely) link to it by themselves. Archived ones are rechecked when they become active again. Links removed by hand do not come back.

## 0.17.3 — 2026-10-30
- Mail: the topic cards no longer have the dot to change colour (it is changed by opening the topic); the card shows the colour in its top border.

## 0.17.2 — 2026-10-30
- **Codes written loosely**: in mails an inventory code with digits also links when written without dashes, dots or slashes and without leading zeros: `sch44`, `SCH.044` and `sch-44` find SCH-44. Main and alternative codes alike.
- Fix: in the command bar the people of a conversation show up only once.

## 0.17.1 — 2026-10-30
- **New themes**: Monokai Pro, Ayu Mirage, Night Owl, Material Palenight among the dark ones; Rosé Pine Dawn and Ayu Light among the light ones.
- **Funky themes**, in a section of their own: Synthwave '84, Vaporwave, Matrix, Amber terminal, Cobalt2, Shades of Purple, Halloween, Bubblegum, Sorbet and Lemonade, some with gradient backgrounds, glowing accents, rounder corners or the terminal font.

## 0.17 — 2026-10-30
- **Phone bottom bar redone**: Projects, Agenda, Inventory, Mail, Settings. Holding a button opens a radial menu around the finger with the group's other pages; sliding onto one opens it and it takes the button's place.
- **Command bar** (⌘K or ⌘P, on the phone tapping "Search"): opens pages, entries, mail conversations (searching their text too), items, documents, projects and contacts on the fly; "Search everywhere" leads to the Search page.
- **Sidebar reordered**: Projects, Agenda (Journal), Inventory (Documents), Mail (Contacts), Chat; Trash and Settings at the bottom, with What's new and Feedback.
- **Contacts to save**: rules to ignore in one go all the addresses or names containing a piece (`noreply`, `@amazon.com`…). Rules and ignored addresses belong to the account and apply on all devices.
- **Collapsible cards on the phone** in Inventory, Documents and Mail.
- **Chat on the phone**: the bar for writing stays at the bottom, right above the menu bar.
- Fixes: "Reply" and "Reply all" open the draft right away; with many notifications the bell's rows no longer squash together.
- Account schema v9.

## 0.16.1 — 2026-10-29
- Fix: on a topic page, on screens that are not very wide, the mail tree ended up on top of the links column.

## 0.16 — 2026-10-29
- **Mail redone as topics and conversations.** Starting from scratch: Organizer keeps only the mails written here, Thunderbird loads the rest again.
  - **First connection**: the extension loads the last month from all folders (except spam, trash and drafts), with the older messages they quote.
  - **Conversations as trees**: each reply under the mail it replies to. Without references (Outlook and the like) a mail goes into the conversation with the same subject and a person in common.
  - **Topics** gather one or more conversations; drag a conversation onto another topic to merge them. Star and colour for topics and conversations; unread counters on each.
  - **Archiving** applies to the single conversation; the topic is archived when all of them are.
  - **Topic page**: tree on the left, the chosen mail in the middle (Reply, Reply all, drafts), links, people and attachments on the right. The whole topic can be linked to a project, an item, a document…
  - **Automatic links** from inventory codes (alternative ones too) and projects in subjects and texts; removed with the × and they do not come back.
- **Search with `[[`**: several words, each in any field (title, people, text, kind, codes, versions). Received **mail conversations** can be quoted too, searching their full text.
- **Attachments and inventory**: "From the inventory…" opens a document search dialog; each received attachment has "→ inventory".
- **Thunderbird extension 1.5**. Data schema v22, account schema v8.

## 0.15 — 2026-10-29
- **Threaded mail**: the Mail page shows the conversations as cards on several columns, **Active** and **Archived**, with filters (unread, to send, awaiting reply), attachments and project. Opening a thread reads it; archiving it is a button; a new message makes it active again. Links to items, projects, documents, contacts and entries; an inventory code written in a received mail links itself. Earlier mails Organizer does not have are passed by the extension, so the thread is complete. Rename and delete (to the trash, with the Organizer mails).
- **Bring the thread into Organizer**: in Thunderbird, right click on a mail (even old, in any folder) brings the whole conversation, the messages before and the replies after.
- **Thunderbird extension 1.4**.
- **DXF drawings** in the document viewer, with zoom up to 12× and notes on points.
- **Organizer tour**: at the first entry the app offers a guided tour, on the real app, in a test workspace with fake content; at the end it is deleted with one click.
- **Grouped sidebar** and **more forgiving suggestions** (`#sch42` finds SCH-042).
- Fix: removing a person from a workspace while they had the app open could stop the server.
- Data schema v20, account schema v7.

## 0.14 — 2026-10-29
- **Notifications**: the bell at the top gathers the latest ones, with the unread count. They arrive for mentions (+person in entries, updates, notes on documents, chat), assigned or shared entries, incoming mail and replies, and every message of your channels (in **muted** channels only mentions).
- **System notifications** on each device (Mac, iPhone with the app on the Home Screen, Android, browsers), even with the app closed, with "Send a test".
- Opening an entry or reading a channel marks its notifications as read.
- Data schema v18, account schema v6.

## 0.13.1 — 2026-10-29
- **Pop-up menus** for Kind, Due date, Assigned and Visible to, like the document kinds menu.
- **Inaccessible quotes**: a link to something not shared with you shows "not enough permissions"; archived entries show their title, deleted ones "entry deleted".
- Fix: in a note on a document `+person` suggests the people.

## 0.13 — 2026-10-29
- **Everything is private to whoever creates it**, except inventory and documents: todos, journal, mails, projects, contacts and notes on documents are seen only by their creator (and the assignee). Admins included.
- **Sharing**: `+marco`, `++marco` (and assign), `+all`; and "Visible to" on every entry, project, contact and note.
- **Chat with channels**: the old chat becomes #general; new channels with chosen people, each reading or also writing; the new **Manage chat channels** permission.
- **Feedback** with text and screenshots, reviewed on the Feedback page or exported with `make feedback`.
- **Settings redone** as categories on the left and boxes on the right; a list on the phone.
- **Offline**: new todos and notes can be created without a network; they go out when it comes back, without duplicates.
- **Invites as links**, **permissions as a table**.
- Data schema v17, account schema v5.

## 0.12.2 — 2026-10-28
- Fix: behind Cloudflare the app could use the previous version's code for up to 4 hours. The app now always rechecks its files with the server.

## 0.12.1 — 2026-10-28
- **New version notice**: if Organizer is updated while the app is open, "Organizer X is available" shows up with **Reload**.

## 0.12 — 2026-10-28
- **Organizer extension for Thunderbird**: with Thunderbird open, **Send** opens the mail there with its attachments, even from the phone. Thunderbird stays the only one that knows the mail passwords.
- **Automatic status**: a mail sent from Thunderbird becomes "sent" and "awaiting reply" by itself; the reply closes the wait.
- **Conversations** in the mail, **Reply** and **Reply all**, **Inbox** with the mails received in Thunderbird (personal), **attachments into the inventory**.
- **Mail is personal**: only its writer and assignee see an Organizer mail, only its recipient sees incoming mail. Not even admins see other people's mail.
- **Mail in two columns**, **Contacts → To save**.
- Data schema v15, account schema v4.

## 0.11 — 2026-10-28
- **Access from outside with Cloudflare Tunnel**: `make tunnel` connects your domain to the app with HTTPS and no open ports; step-by-step guide in `docs/DEPLOY.md`.
- The app listens only on the host (`127.0.0.1`); `APP_BIND=0.0.0.0` opens it on the LAN.
- Behind the tunnel the login attempts limit uses the real client address; HSTS over HTTPS.
- **3D model preview** (STL, 3MF, STEP via OpenCascade in the browser) with **notes on points of the model**.
- Data schema v14.

## 0.10 — 2026-10-28
- **Permissions**: an admin chooses, for each person, the level of each area (no access, read, write); linked areas adjust by themselves. Without access an area disappears; read-only shows everything with the controls off. The server checks every request, for the CLI and bots too.
- Account schema v3.

## 0.9.2 — 2026-10-28
- **Alternative codes** for items, besides the main code. CLI: `org item alias`.
- The document kind menu has coloured entries and works with the keyboard.
- Fix: `.json` files could not be uploaded as documents or attachments.
- Data schema v13.

## 0.9.1 — 2026-10-28
- Note pins on PDFs and images can be dragged to another point, even to another page.

## 0.9 — 2026-10-28
- **Themes** inspired by Neovim and VS Code (Tokyo Night, Catppuccin, Gruvbox, Nord, Dracula, One Dark, Rosé Pine, Kanagawa, Everforest, GitHub, Solarized), per device.
- **More uniform interface**: same height for fields, menus, buttons and chips; the same filter chips on every page; a dedicated side-by-side review picker; a hover card with a small preview for documents.

## 0.8.3 — 2026-10-28
- **What's new** page with this changelog, one card per version, the one in use marked.

## 0.8.2 — 2026-10-28
- Documents page: the panels button shows the inventory by category with the items and their documents.
- Column views laid out as "masonry": each block goes into the shortest column.

## 0.8.1 — 2026-10-28
- Mail: a single button moves it forward (to send → awaiting reply → archived); the ↑ arrow brings a sent mail back among those to send.
- Each contact has a colour; contacts can be coloured by company, time slot or role.
- Data schema v12.

## 0.8 — 2026-10-28
- **Mail awaiting reply**: a sent mail ends up in **Awaiting reply**, with how many days it has been waiting; "Reply received" closes the thread. CLI: `org mail replied ID`.
- Documents page by inventory category; **new document kinds** besides the built-in ones (CLI: `org doc kinds`).
- The project colour is chosen from the dot next to its name.
- Data schema v11.

## 0.7.4 — 2026-10-27
- Item descriptions, project and contact notes, entry details and mail text read like the chat: `#CODE`, `[[…]]` links and URLs coloured and clickable; a click opens the field for writing.

## 0.7.3 — 2026-10-27
- All pages use the full width of the window; column views with 3 columns on large screens, 2 on medium, 1 on phones.

## 0.7.2 — 2026-10-27
- **Search in the document** (⌘F) in PDFs and text files, with highlighted results.
- CLI: `org doc notes ID` shows the notes written on a document.

## 0.7.1 — 2026-10-27
- **Links everywhere**: `[[` works in every text field and links entries, documents, items, projects and contacts, shown as links with their current name.
- **Backlinks**: every linked element shows who links it, with the mails split into **to send** and **sent**.
- In sent mails links become the name of what they link. Fix: an empty Cc made the `.eml` lose its subject.
- `GET /api/backlinks/:kind/:id`. Data schema v10.

## 0.7 — 2026-10-27
- **Workspace chat** in real time, with links to the app's things, unread badge, editing and deleting one's own messages.
- **`org`, the CLI** (`cli/`, `make cli`): entries, projects, inventory, documents, mail with attachments, chat, trash, `--json` for scripts.
- **API tokens** for the CLI, bots and scripts; the API is documented in `docs/API.md`.
- Data schema v9, account schema v2.

## 0.6.2 — 2026-10-27
- New document kind **footprint** (PCB footprints).

## 0.6.1 — 2026-10-27
- Documents can be renamed from the app; when downloaded the file takes that name.

## 0.6 — 2026-10-27
- **Workspaces**: separate sets of data, each with its members and roles, invites per workspace. The existing installation becomes the "Main" workspace.
- Contacts with time slot and grouping; hand-picked colours for projects and categories; PDFs from external links; outdated and discarded items.
- Data schema v6–v8.

## 0.5 — 2026-10-27
- **Documents** page with filters and a side-by-side review of up to 3 documents with their notes.
- Editable document kind and version; entries in several projects; links on items; drag and drop of items between categories.
- Data schema v5.

## 0.4 — 2026-10-27
- **Notes on documents**: PDF viewer (bundled PDF.js), images and text; notes on a point of the page or general, resolvable, turned into todos.
- Data schema v4.

## 0.3 — 2026-10-27
- **Subprojects** on several levels, reorganised by drag and drop.
- Items linked to projects by hand; the top bar creates items and projects; inventory by category with colours, filters, columns and a hover card.
- Restore a backup from the Settings. Data schema v3.

## 0.2 — 2026-10-27
- **Autocomplete** for `@project`, `#CODE`, `!date`, `+user`, `>recipient`.
- **Trash** with "Undo" and automatic cleanup after 30 days.
- **Mail** with recipients, subject, text and attachments, opened in Thunderbird with the helper, or as `.eml`.
- **Contacts**: a shared address book.
- Data schema v2.

## 0.1 — 2026-10-27
- First version: todos, mails, journal and inventory (codes, firmware, documents) synced in real time; quick bar with tokens; several users with invites; installable PWA; Docker with optional HTTPS; Makefile and demo data.
