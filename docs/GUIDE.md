# Organizer — full guide

Everything Organizer can do, page by page. For the presentation with pictures: [README](../README.md).

Todos, mails to send, journal and inventory (part numbers, boards, firmware, documents), synced in real time between phone, Mac, Linux and your friends.

A single installable web app (PWA): no stores, no native builds. Node.js + SQLite backend, **zero npm dependencies**.

The interface speaks **English and Italian**: Settings → App and help → Language (per device; by default the browser's language). The quick bar understands the date words of both languages.

## Getting started

```bash
make up
```

Open <http://localhost:8080>: at the first access you create the administrator user.

To try it right away with sample data (it deletes the existing data):

```bash
make demo
```

and sign in with `demo` / `demo1234` (there is also `marco` / `demo1234` to see collaboration).

`make` alone lists all the commands:

| Command | What it does |
|---|---|
| `make up` / `down` / `restart` / `logs` | container management |
| `make https` | also starts Caddy with HTTPS |
| `make reset` | deletes all the data and starts from scratch (asks for confirmation) |
| `make demo` | reset + demo data |
| `make seed` | loads the demo data without deleting (`FORCE=1` if there is data already) |
| `make backup` / `make restore FILE=...` | full backup in `backups/` and restore |
| `make users` / `invite` / `reset-password NAME=x` / `make-admin NAME=x` | users |
| `make info` | local and LAN addresses |
| `make tunnel` / `tunnel-off` / `tunnel-status` | access from outside with your domain via Cloudflare Tunnel, without open ports (see docs/DEPLOY.md) |
| `make mail-helper` / `mail-helper-uninstall` | helper that opens mails in Thunderbird with the attachments |
| `make dev` / `dev-demo` / `test` | local development without Docker (data in `./data`) |

The commands that delete ask you to type "yes"; for scripts: `CONFIRM=1`.

Without Docker and without make (needs Node ≥ 22.13): `npm start` (data in `./data`), or `npm run dev` with automatic restart.

## How to use it: the quick bar

Type a few words and press Enter. The tokens do the rest:

| Token | Meaning |
|---|---|
| `t:` `m:` `n:` | kind: todo (default), mail, journal note |
| `!today` `!tomorrow` `!fri` `!3d` `!2w` `!1m` `!eom` `!25/11` `!2026-12-01` `!none` | due date (for notes: when it happened); the Italian words work too (`!oggi`, `!domani`, `!ven`, `!3g`, `!2s`, `!fm`, `!no`) |
| `@rover` | project, created on the fly if it does not exist; several `@` = several projects (the first one is the main one) |
| `#SCH-042` | inventory item: it stays in the text as a link, created if it does not exist |
| `+marco` `++marco` `+all` | shares with Marco; shares and assigns the entry to Marco; shares with everyone (without: only you) |
| `>purchasing@company.example` | the mail's recipient |
| `^Mirko` → `^17` | the entry **waits for** another one (pick it from the menu that opens after `^`) |

```
flash new fw #SCH-042 @rover !fri
m: quote for 50 boards >purchasing@company.example !tomorrow
n: rev B of SCH-042 needs bootloader >= 2.3 #SCH-042
```

**Updating as you go**: open an entry and write an update ("the JTAG cable is missing, postponed !mon"). A history with dates stays, and the due date moves, leaving a trace of how much it slipped. The same tokens work when editing the title. Subtasks are born when you find out that one thing contains others.

**Entries that wait for others**: some things can only be done after something else, whose date you do not know ("try the PS5 with Mirko" after "Mirko lands"). Write `^` and part of the other entry's title (`try the PS5 with Mirko ^mirko`): the menu offers the open todos and mails, the choice becomes `^17`. Or open the entry and add it under **Waits for**; under **Then** you write directly what comes after. Until what it waits for is done, the entry is not in Overdue, Today or the other dates of the Agenda: it sits **under** that entry, indented, in a chain (what waits for it under it, and so on). When the first one is done, the next one goes back to its date (if it had one, possibly already overdue) and whoever has it is told they can go on. An entry may wait for several; it shows under the first one still open. If what it waits for is not in the Agenda (another kind filtered out, or "only mine"), it ends up in **Waiting**, with "after …" next to it. Two entries cannot wait for each other, not even through others; notes cannot wait (they are never done).

**Autocomplete**: as soon as you type `@`, `#`, `!`, `+`, `>` or `^` a menu shows projects, items (with firmware), dates already computed ("fri 30 Oct · in 3d"), users, recently used recipients and the open entries to wait for. `↑↓` to choose, `Tab` or `Enter` to complete, `Esc` to close; on a phone just tap. It also works in an entry's title, in subtasks and in updates.

In the lists each entry has a label and a coloured border by kind (green todo, blue mail, purple note), and each project has its own fixed colour, so in the Agenda you see at a glance what you are looking at. The Everything / Todo / Mail filters at the top of the Agenda also show the counts.

The bar at the top changes with the page: in **Inventory** it adds items (`SCH-060 relay board /board @rover`: code, description, `/category`, `@project` to link it to; if the code already exists Enter opens its page), in **Projects** it creates projects (`Motor firmware @rover` creates it as a subproject of @rover).

`Esc` leaves the field; outside the fields it closes the open entries and then goes back to the list (from a project to Projects, from an item to Inventory).

On the other pages the quick bar takes into account where you are: in a project the entries end up there, on an item's page they are linked to its code, in Mail and Journal the default kind changes.

Keyboard shortcuts: `n` or `/` to write, `Ctrl/⌘ K` to search.

## Themes

Settings → Appearance: Organizer (automatic, light, dark), themes inspired by the most used ones in Neovim and VS Code (Tokyo Night, Catppuccin, Gruvbox, Nord, Dracula, One Dark, Monokai Pro, Ayu, Night Owl, Palenight, Rosé Pine, Kanagawa, Everforest, GitHub, Solarized) and some funky themes (Synthwave '84, Vaporwave, Matrix, Amber terminal, Cobalt2, Shades of Purple, Halloween, Bubblegum, Sorbet, Lemonade), with gradient backgrounds, glowing accents or the terminal font. The theme is per device.

On the same page you choose the **app icon**: a theme's (even one different from the one in use), a minimal one, or "Automatic", which follows the theme. The browser tab's icon changes right away; an app already installed must be removed and added again to the Home Screen or the Dock, because the system keeps the icon it had when you installed it.

## Moving around the app

- **Sidebar** (computer): Projects, Agenda (with Journal), Inventory (with Documents), Mail (with Contacts), Chat; at the bottom Trash, Settings, What's new and Feedback.
- **Bottom bar** (phone): Projects, Agenda, Inventory, Mail, Settings. A tap opens the page; **holding it** opens a menu around the finger with the group's other pages (Agenda and Journal; Inventory and Documents; Mail, Contacts and Chat; Settings, Trash, What's new, Feedback): slide onto the button you want and let go. The chosen page takes the button's place in the bar. Buttons with more pages behind them have a dash under the icon.
- **Command bar**: ⌘K or ⌘P (Ctrl+K on Windows/Linux; on a phone tapping "Search"). Type a few words and open on the fly a page, an entry, a mail conversation, an item, a document, a project or a contact, with the same search as `[[` (see below). ↑↓ and Enter; at the bottom "Search everywhere" leads to the Search page.
- **Collapsible cards** (phone): in Inventory, Documents and Mail "Collapse all" leaves only the cards' headers, with their count; tapping one opens just that one.

## Links and backlinks

In any text field `[[` opens the suggestions to link an entry (todo, mail, note), a received mail conversation, a document, an item, a project or a contact; each suggestion has the label of its kind. After `[[` you can write several words, and each one can be in a different place: title, people (address-book name or address), text, kind ("mail", "todo", "document"…), codes. For example `[[marco mail 500mA` finds the mail with Marco in it and "500mA" in its text: the server searches the full text of received mails, only in your own mail. A quoted conversation (`[[mail:7]]`) is seen only by whoever receives it; the others see "not enough permissions". **Notes on documents** can be quoted too (`[[nota:9]]`, label "note on file"), searched by text, highlighted text or file name: the link opens the document on the note, and the note shows in "Mentioned in" the entries that quote it. Like the note, it is seen only by whoever can see it. In the text a token stays (`[[voce:12]]`) that the app shows as a link with the always up-to-date name; in sent mails it becomes the name in plain text.

What gets linked knows it: items, documents, projects, contacts and entries show who links them, with the mails split into **to send** and **sent** (old ones too). So you see right away whether the datasheet already went to the supplier or is in a mail still to be sent.

## Projects

An entry (todo, mail, note) can be in several projects: in the editor the projects are chips with × and a field to add more; it shows up on each one's page.

A project can be inside another (the "Inside" field on its page, or `@parent` when you create it), on several levels. The list shows them as a tree with the open entries summed up and is reorganised by **dragging**: a project dropped on another ends up inside it, dropped on the row at the top it becomes a main one again (on a phone: hold and drag; after each move there is "Undo"); on a project's page there are the subprojects and, with "include the subprojects' entries" on, their entries too. The **Project inventory** section gathers the items linked by hand (with autocomplete; a new code creates the item) and those mentioned with `#CODE` in the entries.

## Documents and notes

With several files, **Download all** in the item's Documents section downloads them in a single `.zip` (`CODE-documents.zip`, each with the name given in the app; links stay out).

Clicking a document on an item's page opens the viewer with the notes on the side. The document uses the whole width of the page; with **notes** you hide the notes bar (the preference stays), with **expand** the rest of the app disappears too and the document fills the whole window (Esc to go back).

- **PDF** (with PDF.js, bundled in `public/vendor/pdfjs`, no external connection) and **images**: click a point and leave a note there; the numbered pin stays in place at every zoom and can be dragged to move it, even to another page. Clicking a note scrolls the document to the point, and the other way round. Zoom with − and +, with a pinch on the trackpad (or with the fingers) and with ctrl/⌘ + wheel, around the point under the pointer.
  In PDFs you can also **select text** by dragging (or double-click a word, triple-click a line): it becomes a note on that text, which stays highlighted in the document and quoted in the note. Clicking the highlighted text opens its note. On a phone hold to select and then tap **Note on the text**. These pins do not move: they stay attached to the text. PDFs made only of images (scans) have no text to select.
- **DXF drawings** (with dxf-parser, bundled): the drawing becomes an image on white paper (lines, polylines, circles, arcs, ellipses, splines, texts, blocks, dimensions; hidden layers no) and works like an image: zoom up to 12×, notes on points. DWG no: the format is closed, export to DXF from the CAD program.
- **3D models** (STL, 3MF, STEP, with three.js and OpenCascade bundled): the model can be rotated, moved and zoomed; click a point of the surface and leave a note there. The pins follow the view and can be dragged on the model; clicking a note turns the view towards the point. STEP files are converted in the browser: a big model may take a few seconds.
- **Text files**: preview of the content.
- **CSV and TSV tables** (`.csv`, `.tsv`, `.scsv`): the columns in a table with zebra rows, a header that stays in view while scrolling and row numbers. The separator (comma, semicolon, tab or `|`) is recognised by itself; quoted fields may contain the separator and line breaks; CSVs saved by Excel with accented letters read correctly. The first 5000 rows are shown (up to 8 MB): beyond that, download the file.
- **Search in the document**: ⌘F (Ctrl+F on Linux) opens the search in the open PDF, text file or table; Enter and Shift+Enter move from one result to the next, Esc closes. In the side-by-side review it searches the document touched last. It works on PDFs with real text (not on scans).
- **Link to a PDF** (e.g. a datasheet on mouser.com): the server downloads it on the spot and shows it like an uploaded PDF, with the same notes. Only public internet addresses (not the local network, unless `REMOTE_ALLOW_LAN=1`), only PDFs, at most 60 MB (`REMOTE_MAX_MB`); if the site shows a page or an anti-bot protection instead of the file, the reason and the original link show up.
- **Link to a web page** (a product page, a repo, a wiki page): the page itself, drawn as on a computer screen (1280 px wide) and shrunk to the space like a PDF page, with notes on its points. The first time it is opened the server saves a **copy** of the page (date in the toolbar): the notes stay where they were put even if the site changes, and the page is still there if the site removes it. **Update** downloads it again (the notes keep their position on the page, which may have moved). The copy has no scripts (it is only to look at): pages that build themselves with JavaScript may come out empty or incomplete, and some sites refuse downloads that do not come from a browser; in both cases **Open the original link** is there. Same limits as the PDFs (public addresses, at most 6 MB of page).
- **Any other file** (firmware, archives, …): no preview, but the **general notes** on the file work for all.

On a wide screen the document page (and the review) is as tall as the window: only the document scrolls.

The **Documents** page (sidebar; on a phone from the bottom bar) gathers all the documents by item or by kind, with filters and "with open notes". Pick up to 3 documents and **Review side by side**: they open next to each other, each with its notes (they open in the panel you click). A document is **renamed** from its title in the viewer or with the pencil next to the name (item page, Documents, review): the original file does not change, but when you download it it takes the new name with its extension. A document's kind and version can be changed at any time, here, on the item's page or in the viewer; if a firmware changes, the item takes the version of the most recent firmware.

Each note can be edited, marked as resolved (it disappears, you see it again with the "resolved" filter), deleted (it goes to the trash) or turned into a todo with **→ todo**: the entry is born with the item's `#CODE` and in the updates a link that reopens the document on that note. The original file is not modified: the notes live in the app. On the item's page each document shows how many open notes it has; the search also finds the notes' text.

## Mail

An entry of kind mail is a real mail: recipients (To, Cc) with suggestions from the address book, subject (if empty it uses the title), text and attachments. Attachments can be uploaded files (by dragging them too) or documents already in the inventory, for example the firmware to send to the customer. In the text `#` suggests the inventory items and inserts the code without `#` (e.g. `#sch051` → `SCH-051`).

Each mail has a single button that moves it forward: one click marks it sent and puts it **Awaiting reply** (with the hourglass), another click when the reply arrived sends it to the archive. So the threads still open do not get lost. If a mail does not need a reply, "No reply" right after marking it sent. The ↑ arrow at the end of a sent mail's row brings it back among those to send (for a reminder). Each contact has a colour, changed from the dot on its page: its name in the mails is coloured that way. In Settings → Appearance you can colour by company, time slot or role instead.

### With Thunderbird (extension)

The **Organizer for Thunderbird** extension connects the app to your Thunderbird (`thunderbird/` folder, downloaded ready from Settings → Mail and Thunderbird). It speaks English and Italian, following Thunderbird's language.

1. **Download the extension**: the `.xpi` file is already set up for the address you open the app from.
2. In Thunderbird: menu ≡ → Add-ons and Themes → gear → "Install Add-on From File…".
3. **Create token for Thunderbird** in the same section and paste it into the extension's options → "Save and connect".

Then, with Thunderbird open:
- **Send** opens the mail in Thunderbird with recipients, subject, text and attachments, even if you press it on your phone (it opens on the computer). Replies written in Organizer open as a reply to the original message.
- When you send it, it becomes **sent** and **awaiting reply** by itself.
- **First connection** (of each person): the extension loads the last month from all folders except spam, trash and drafts, plus the older messages they quote. All the recent conversations show up, those started earlier too, to be archived.
- **Conversations**: each mail goes into the conversation of the mail it replies to (In-Reply-To and References); if those are missing, as many clients do, into the one with the same subject (without Re:, R:, Fwd:) and at least one person in common, within 60 days. A conversation is a tree: each reply under the one it replies to, even if it goes to different recipients.
- **Topics**: the Mail page shows the topics as cards on several columns, each with its conversations. By default each conversation is a topic of its own; dragging it onto another topic merges them (and dragging it onto the zone that appears at the bottom makes it its own again). **Active** and **Archived**, with filters for starred, unread, to send, awaiting reply, attachments and project. Topics and conversations have a **star** and a **colour** (automatic until you pick one).
- **Archiving** applies to the conversation (the button on the left): a topic is archived when all its conversations are. A new mail brings the conversation and its topic back to life.
- **Topic page**: on the left the tree (conversations and mails, like a forum), in the middle the chosen mail (opening it reads it), with **Reply** and **Reply all**: the draft is born in the tree, written there and sent from Thunderbird. **New mail**, under the tree, opens a new conversation in the same topic with an empty draft; until messages go out, the conversation takes the draft's subject. On the right the links of the whole topic (e.g. its project, valid for all conversations) and, for the chosen conversation: archive, new mail, **links**, people, received attachments.
- **Links**: inventory codes (alternative ones too, and even written loosely: `sch44` for SCH-44) and projects written in subjects and texts link themselves, like what you mention in the mails written here; items, projects, documents and contacts show the conversations in "Mail conversations". A wrong link is removed with the ×, and it does not come back.
- **Bring the thread into Organizer** (right click on a mail in Thunderbird, in any folder): the whole conversation arrives, the messages before and the replies after (searched by subject, up to 200), among the active ones.
- From the ⋯ menu a conversation can be renamed, moved to another topic or deleted (it goes to the trash with its mails written here); a topic can be renamed, deleted with all its conversations or **moved to another workspace** (with the mails written here; links to things of this workspace are lost, the automatic ones are redone with the inventory over there).
- **Workspace of each account**: in the extension's options (1.7) pick for each Thunderbird mail account the workspace its new conversations go to; without a choice, the default workspace. Replies always go into the conversation they reply to, wherever it is.
- **Open in Thunderbird** (under a message, extension 1.7) opens that message in Thunderbird, in a tab.
- In Contacts, **To save** lists the addresses of mails that are not in the address book. "Ignore" stops suggesting one; "Ignore all those containing…" removes in one go addresses and names with a piece in common (`noreply`, `@amazon.com`, `newsletter`). The rules belong to your account (they apply on all devices) and are removed from the same panel.
- **Attachment preview**: PDFs, images, DXF, 3D models, texts and CSVs attached to a received mail open with "preview" (or by clicking the name), without saving them: Organizer asks Thunderbird for the file (needs extension 1.6) and shows it in the document viewer, without notes. From there "→ inventory" saves it in an item and back (or Esc) returns to the mail.
- **Attachments into the inventory**: on each attachment of a received mail, "→ inventory" opens a dialog where you search the item (code, alternative too, name, category) and pick the kind: Thunderbird uploads the file and it shows up among the item's documents. To attach an inventory file to a mail, "From the inventory…" opens the document search as on the Documents page.

Mail is **only for whoever receives it**: nobody else in the workspace sees it, not even admins. Thunderbird stays the only one that knows the mail passwords. With "Pass all incoming mail to Organizer" (extension options, on by default) received mails are copied into Organizer's database (in your default workspace, visible only to you). Off, the extension sends Organizer only the replies to your conversations, recognised by comparing the messages' identifiers (Message-ID). With several computers you can install it on each one: the mail opens on just one.

### Without the extension

A `mailto:` link cannot carry attachments, so as an alternative there is a small local helper to install once per computer:

```bash
make mail-helper
```

Then in Settings → Mail and Thunderbird → Without the extension tick "Helper installed on this computer". The first time the browser asks whether to open "Organizer Mail": allow it and remember the choice. How it works: the button opens an `organizer-mail://` link with a token valid for 15 minutes; the helper downloads text and attachments from the server and launches `thunderbird -compose`. On macOS it is a small app in `~/Applications/Organizer Mail.app`, on Linux a `.desktop` file. Removal: `make mail-helper-uninstall`. Log: `~/.cache/organizer-mail/helper.log`. With self-signed HTTPS (internal Caddy) set `ORGANIZER_INSECURE=1`.

Without the helper (for example from the phone) **Send** and **Mail app** open the default mail app without attachments; **.eml** downloads the mail complete with attachments.

## Contacts

A shared address book with name, email, phone, company, role, **time slot** (free text: "morning", "14-18", "Shenzhen (UTC+8)"…) and notes, all editable; company, role and time slot suggest the values already used. **Group** by company, time slot or role: each value becomes a tab with its count. Contacts are suggested in the To/Cc fields and after `>` in the quick bar; `>luca` becomes the email of the contact "Luca …". A contact's page has their mails and "New mail"; recipients used but not in the address book are added with one click.

## Trash

Deleting moves to the trash: entries (with their subtasks), projects, items, documents, contacts and mail threads (with their mails written in Organizer). After each deletion "Undo" shows up. From the Trash you restore or delete for good; after 30 days (`TRASH_DAYS` variable) the elements disappear by themselves, files included. Writing the `@tag` or `#CODE` of something that is in the trash restores it.

## Inventory

Each item has its **code** (the one it is known by) and can have **alternative codes** (the supplier's, the manufacturer's, old names), added on its page under the code. An `#ALTERNATIVE` written in an entry leads to the same item, and filters, search and suggestions find them; suggestions always insert the main code. Each code belongs to one item only. Writing an alternative as the item's new code, it becomes the main one and the previous one stays among the alternatives.

Each item has a **status**: active, **being evaluated** (it is being tried), **outdated** (superseded) or **discarded** (evaluated and dropped), chosen on its page. In the lists and columns it shows as a dot (blue / orange / red) and at the top there are the status filters and "hide discarded".

Each item can have an optional **link** (product page, repo, wiki). The globe next to it opens the **page preview**: a small browser over the app, where the page's links open one after the other (back with ←, ⌘/Ctrl+click to open one in the browser). **Save as document** adds the page you are looking at to the item's documents, where you can leave notes on it (see Documents). In the view by category an item moves to another category by **dragging it** into the column (or into "New category").

**Colours**: projects and categories have an automatic colour, which can be changed (project page → Colour; category → click on the coloured dot in the view by category or on the item's page; "A" goes back to automatic).

An item's colour depends on its category, wherever it shows (lists, `#CODE` in the text, suggestions); without a category it is grey. You can filter by category or switch to the view **by category**, in columns on wide screens. In the composition and in the links to projects the code autocompletes; if it does not exist it is created.

Each item has code, description, category, firmware version, location, quantity and notes (pinout, flashing procedure…). Notes are written in **Markdown**: `# heading`, `**bold**`, `*italic*`, `- list`, `- [ ] to do`, `> warning`, `` `code` `` and blocks between ```` ``` ````; `#CODES` and `[[…]]` stay links. Markdown also works for the details of todos and journal, the notes of projects and contacts and the notes on documents; not for the text of mails, which goes out as it is. You upload documents to it (firmware, datasheets, schematics, footprints, manuals, photos) or external links. A firmware file with a version updates the Firmware field by itself, and for each file the sha256 is shown. "Composition" links products and boards; in the Inventory the **Trees** view (third button at the top right) draws them as a graph: each item that contains others with its components on the right, all the way down, and the number on the card collapses or reopens a branch. "Show the tree" on the item's page shows only that item's trees. A document is **moved** (with its notes) or **copied** (new file, without notes) to another item with the icon next to the name, from the viewer too; from the CLI `org doc mv` and `org doc cp`. At the bottom you find all the entries that mention that `#CODE`. If you rename a code, the references in the entries' text are updated.

## Workspaces and several people

A **workspace** is a separate set of data (projects, entries, inventory, contacts, documents) with its members. The same account can be in several workspaces with different roles: admin in one, member in another. You switch from the selector at the top of the sidebar (on a phone: Settings → Workspace and people); anyone can create a new one and becomes its admin.

- **Invites**: Settings → Workspace and people → **Create invite** (admins only) and you send the link. Whoever has no account signs up; whoever has one signs in with their credentials (or, if already signed in, presses "Join the workspace"). The link is valid 7 days, for one person.
- **Workspace admin**: invites, removes people, appoints other admins, renames or deletes the workspace, does backups and restores. A workspace always has at least one admin.
- **Private by default**: inside a workspace inventory and documents belong to everyone; todos, journal, mails, projects, contacts and notes on documents are seen only by their creator (and whoever has an entry assigned), until they share them with `+person`, `++person` (and assign it) or `+all`, or from "Visible to". This applies to admins too. Changes arrive in real time only to those in the same workspace.

**Permissions**: in Settings → Permissions an admin chooses for each person (not admin) what they see and what they can change in each area: todos and journal, mail, projects, inventory, documents, contacts, chat. For each area: no access (the area disappears from the app), read or write. Linked areas adjust by themselves: giving write access to mail makes contacts, documents, inventory and projects at least readable. The server checks every request, so the permissions apply to the CLI and bots too. Permissions decide what can be done in the areas, they do not show what others do not share; incoming mail from Thunderbird always belongs only to whoever receives it. On top there is **Manage chat channels** (yes/no, no by default).

On the server: `accounts.db` holds accounts, sessions, workspaces and invites; each workspace has its own file (`organizer.db` the first one, `ws-<id>.db` the others). Updating from a version without workspaces, the existing installation becomes the "Main" workspace (name changeable with `WORKSPACE_NAME`) with the same users and roles.

## Chat

Each workspace has a chat with **channels** (Chat in the sidebar; on a phone the icon at the top). #general belongs to everyone; the other channels have their own people, each one who reads or also writes. Admins and whoever has the "Manage chat channels" permission create and manage them. In messages you link the app's things: `@project`, `#CODE`, `+person` and, typing `[[`, a document, an entry (todo, mail, note) or a contact, chosen from the suggestions. In the message they become links with the always up-to-date name. The number on the badge is the unread messages of all channels; from the terminal `org chat -f` follows it live (`-c channel` for one channel, `org chat channels` for the list).

## Notifications

The bell at the top gathers the notifications: mentions (+person in entries, updates, notes on documents and chat), entries assigned or shared, mails received (with the Thunderbird extension) and the channels' messages (in muted channels only the mentions). In Settings → Notifications they can also be turned on as **system notifications** on each device: they arrive with the app closed. On iPhone/iPad they need the app installed on the Home Screen and iOS 16.4 or later; on Mac they work from Safari, from the app in the Dock and from Chrome. Notifications arrive in the language the person last used in the app. The notification keys (VAPID) are created by themselves in `/data/vapid.json` and end up in the backups; `PUSH_SUBJECT` (e.g. `mailto:you@example.com`) is optional.

## Offline

Without a network the app shows the last synced data read-only. You can create todos (Agenda) and notes (Journal): they stay queued ("queued offline") and until they go out they can be changed, marked done or deleted. When the network comes back they go out by themselves; each one has an identifier, so an interrupted and repeated send creates no duplicates. The rest (mail, projects, inventory, changes to existing entries) waits for the network: this way there are no conflicts with other people's changes.

## Feedback

"Feedback" next to What's new (on a phone in Settings → App and help) sends a bug or an idea with text and screenshots. Whoever runs the instance (the admins of the first workspace) reviews them on the Feedback page; from the terminal `make feedback` exports them to `feedback/` (one folder per feedback with `feedback.md` and the images; `ALL=1` also the resolved ones). The images are in `/data/feedback` and end up in the backups.

## Organizer tour

At the first entry the app asks whether to take the tour (it can be taken again from Settings → App and help). The tour opens a **test workspace** of your own, with fake content (projects, inventory, a PDF and a 3D model with notes, mails, chat; Anna and Luca exist only there and receive nothing), in your language, and shows the parts of the app one at a time on the real app: you can write in it and try things. At the end it is deleted with one click and you go back to your own workspace, or you keep it (in the workspace menu it is marked "test") and delete it later from the same Settings section.

## Terminal (CLI) and API

`org` is the CLI: a separate executable (`cli/` folder, needs Node 22) to do from the terminal almost everything done in the app: write and reorganise entries, projects and inventory, upload and download documents, prepare mails with attachments. It speaks English, or Italian with `ORG_LANG=it`.

```bash
make cli                          # installs the org command
org login http://localhost:8080   # user and password, once
org add 'flash fw #SCH-042 @rover !fri'
org ls -p rover
org doc up SCH-042 fw_2.4.0.bin -V 2.4.0
```

Full guide in [cli/README.md](../cli/README.md). The CLI uses the public API, the same one for bots and scripts: they authenticate with a **token** created in Settings → *CLI and tokens* (or by `org login`). Endpoints and examples in [docs/API.md](API.md).

## Phone and other computers

The app listens only on the computer that hosts it (`http://localhost:8080`): no open ports, not even on the local network. From any other device, at home or outside, you reach it with your own domain through **Cloudflare Tunnel** (free): valid HTTPS, installation as an app on the phone and offline mode.

```bash
make tunnel        # after putting TUNNEL_TOKEN in the .env file
make tunnel-status
make tunnel-off
```

The step-by-step setup (domain on Cloudflare, tunnel, phone, security, moving to a Raspberry Pi) is in [docs/DEPLOY.md](DEPLOY.md). To open the app on the local network again without the tunnel: `APP_BIND=0.0.0.0` in `.env`.

Installation: iPhone → Safari → Share → "Add to Home Screen". Android → Chrome → "Install app". Mac → Safari "Add to Dock" or Chrome. Linux → Chrome/Chromium.

## Hosting on a server

On a VPS with a domain pointing to the server:
```bash
SITE_ADDRESS=todo.example.com CADDY_TLS="tls you@example.com" docker compose --profile https up -d
```
Caddy gets the Let's Encrypt certificate by itself. The app's port stays bound to `127.0.0.1` (`APP_BIND`), so only Caddy reaches it.

## Exporting and importing your own data

Anyone, not only admins: Settings → *Your data* (*Backup and data* for admins).

- **Export my data** downloads a `.zip`: inside `organizer-export.json` (readable) and in `files/` the actual files. It contains all the workspace's inventory and documents (they belong to everyone) and what you created: todos, journal, written mails, projects, contacts, notes on documents, your mail. Other people's private things and the chat no. Only the areas you can read.
- **Import data…** adds an export to the workspace you are in, even on another server, **without overwriting anything**: an item with the same code (or alternative) stays as it is and only gets the documents it lacks; a project with the same tag and a contact with the same email are merged with the existing ones. Everything that arrives becomes yours. The areas where you cannot write are skipped (the summary says so). The `[[…]]` links in the texts point to the new things; those to things not exported become their name in plain text.

## Backup

- Database only: Settings → Backup and data (admin) → **Download backup** (`.db` file). It contains the whole workspace, the members' private things too: to move only your own things there is the export above.
- Restore from the browser: same panel → **Restore from backup…** with a `.db` file, even from an earlier version of the app (it gets updated). Before overwriting, the server saves a copy of the current database (`pre-restore-*.db` in the volume, it keeps the last 3); afterwards, everyone signs in again with the backup's credentials. Uploaded files are not in the `.db`: if they are missing, the restore says so.
- Everything (database + uploaded files): `make backup` creates `backups/organizer-YYYYMMDD-HHMMSS.tgz`
  (it stops the app for a few seconds so the SQLite copy is consistent).
- Restore: `make restore FILE=backups/organizer-....tgz`.

## Maintenance

```bash
make users
make workspaces
make reset-password NAME=marco
make make-admin NAME=marco WS=2
make invite WS=2
```

Variables: `APP_PORT` (published port, default 8080), `APP_BIND` (default `127.0.0.1`), `MAX_UPLOAD_MB` (default 200), `TRASH_DAYS` (default 30), `ORG_LANG` (language of the server's own command-line messages), `REMOTE_ALLOW_LAN=1` (the server also loads links to the local network for the previews of PDFs and web pages: only if everyone who uses the instance may reach those machines).

## Structure

```
server/       HTTP, REST API, authentication, SSE (Node, standard modules only)
  db.js       SQLite schema and migrations (PRAGMA user_version)
  i18n.js     server-side translations (locales/it.js)
  demo.js     demo data (make demo / make seed)
  mail.js     attachments, .eml and package for the Thunderbird helper
  thunderbird.js  bridge with the Thunderbird extension (queue, sent, replies, conversations)
  contacts.js address book
  trash.js    trash and automatic cleanup
  backup.js   restore of a .db backup from the browser
  tokens.js   API tokens for the CLI and external programs
  chat.js     workspace chat
public/       PWA without a build: HTML, CSS, ES modules
  js/i18n.js  interface language; js/locales/it/ the Italian texts
  js/parse.js quick bar parser, shared with the server
cli/          the `org` CLI (standalone executable, uses only the public API)
docs/API.md   API for CLI, bots and scripts
CHANGELOG.md  what's new in each version
test/         node --test
tools/        icon generator, Thunderbird helper (organizer-mail.sh) and its installer
thunderbird/  Organizer extension for Thunderbird (downloaded from Settings), _locales en/it
public/vendor/pdfjs  PDF.js 6.4.299 (Apache-2.0), only the files the viewer needs
public/vendor/three  three.js 0.186.1 (MIT) and its addons for STL, 3MF and view rotation
public/vendor/occt   occt-import-js 0.0.23 (LGPL-2.1, OpenCascade) to read STEP files, in a worker
public/vendor/dxf-parser  dxf-parser 1.1.2 (MIT) to read DXF files
```

Data: `/data/organizer.db` (SQLite, WAL) and `/data/uploads/` in the `organizer-data` volume.

Security: passwords with scrypt, sessions in HttpOnly cookies (tokens stored as hashes), CSRF protection through a required header, login attempts limit, downloaded files served with `nosniff` and a sandbox CSP.

## Translating

The code and its texts are in English; each other language is a catalog that maps the English text to the translation: `public/js/locales/<lang>/` (app), `server/locales/<lang>.js` (server errors, notifications, tour), `cli/lib/locales/<lang>.js` (CLI), `thunderbird/_locales/<lang>/messages.json` (extension). Texts with placeholders keep them as they are (`{name}`); a text that means different things in different places carries a context after `||` (`'Open||project status'`), shown only in the catalog.
