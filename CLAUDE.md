# mel — Kontext für die nächste Session

Backend-loser JMAP-Webmailer als PWA (Mail + Kontakte + Kalender), alle Daten in
IndexedDB, optional per Passphrase verschlüsselt. React 19 + TS strict + Vite 8,
Tailwind 4, TanStack Router, Dexie 4 (liveQuery = Read-Model), Zustand für UI-State.
UI-Sprache: **Englisch default + Deutsch** via `src/lib/i18n.ts` — nie Strings
hardcoden (User-Vorgabe). Genehmigter Gesamtplan:
`/home/joreetz/.claude/plans/ich-will-eine-pwa-hidden-ripple.md`.

## Stand (alle 6 Phasen fertig, committet, main)

Voll funktionsfähig und e2e-getestet: Login (eine Maske, Autodiscovery — s. u.),
Delta-Sync (`Foo/changes` + Fallback), Outbox mit optimistischen Writes/Undo/Backoff,
SSE-Push + Polling, Compose (Tiptap, Reply/Forward mit Threading, Anhänge
offline-staged, Undo-Send 10 s, Draft-Autosave), Suche (Fastmail-Syntax → JMAP-Filter,
Snippets mit <mark>), Shortcuts (?-Overlay), Ordner-Verwaltung, Quick Actions +
Swipe + Pull-to-Refresh, Kontakte (RFC 9610, Autocomplete im Compose), Kalender
(Monat/Agenda, DST-sichere Recurrence via rrule+Temporal), Verschlüsselung
(Argon2id→KEK→DEK, sync AES-GCM via @noble/ciphers als Dexie-Middleware, AAD-Bindung,
UnlockGate), Web Push ohne Backend (RFC 9749, kompletter PushVerification-Handshake),
PWA (Update-Toast, storage.persist).

Einladungen/RSVP sind fertig: Teilnehmer-Editor im EventDialog (mit Kontakt-
Autocomplete), Stalwart verschickt iMIP-Einladungen, die Gegenseite bekommt den
Termin plus Einladungsansicht mit Zusagen/Vielleicht/Absagen, und die Antwort
landet als Status beim Organisator. Voller Round-Trip e2e getestet
(`e2e/calendar.spec.ts`, alice lädt bob ein und bob sagt zu).

Kalender kann außerdem: Week-/Day-Zeitraster (Klick-to-create, Überlappungs-Spalten,
Now-Linie), Multi-Kalender-Farben + Sichtbarkeits-Toggles (Sidebar, localStorage),
Kalenderauswahl im EventDialog. Mail-Nacharbeiten erledigt: Anhänge öffnen (war ein
echter Bug, s. u.), Quick Actions in der Mail-Liste, Ordner-Verwaltung (anlegen/
umbenennen/löschen), Draft-Autosave, Search-Snippets mit `<mark>`, Pull-to-Refresh.
Kontakte sortieren jetzt korrekt alphabetisch nach Anzeigename.

Tests: 74 Vitest + 36 Playwright (Desktop+Mobile; zustandsändernde Specs desktop-only,
siehe `testIgnore` in playwright.config.ts). Fastmail-Interop Mail vom User bestätigt.

## Login/Setup und Abmelden

Eine einzige Maske für alle Server: **E-Mail + Passwort**, keine Provider-Presets
mehr (Fastmail und der explizite Stalwart-Eintrag sind raus). Aus der Adresse
rät `discoveryCandidates()` die Session-URL — `mail.<domain>` zuerst, dann Apex,
`jmap.`, `imap.`; für `@localhost` das Dev-Stalwart auf `http://localhost:8080`.
Erst **wenn alle Kandidaten scheitern**, klappt in der Maske ein Bereich auf mit
(a) Button „Per DNS suchen" (`srvCandidates()`, DoH gegen Cloudflare, löst
`_jmap._tcp.<domain>` SRV auf) und (b) manueller Serveradresse + Auth-Methode.
**Der DoH-Weg läuft nie automatisch** — er verrät die Mail-Domain an einen
Dritten, also nur auf ausdrücklichen Klick (Vorgabe des Users).

Warum überhaupt raten statt SRV: RFC 8620 sieht den SRV-Record vor, aber
**Browser haben keine DNS-API** und die App hat kein Backend. Realfall
`reetz.me`: SRV (`0 1 443 mail.reetz.me`) und CORS sind korrekt, aber die Apex
hat **gar keinen A-Record** — der naive Well-Known-Versuch auf `reetz.me` läuft
also ins Leere, `mail.reetz.me` trifft sofort.

`signOut()` in `services/accounts.ts` ist der einzige Abmelde-Weg (Button in der
Desktop-Kopfzeile + Settings). Zwei Fallen, beide gefixt:
- `removeAccount` hatte `addressBooks`/`contacts`/`calendars`/`events`/`keyring`
  **nicht** in seiner Tabellenliste — nach dem „Abmelden" lagen Kontakte und
  Termine des Vorgängers weiter in IndexedDB. Unit-Test in `accounts.test.ts`
  hält die Liste jetzt vollständig; **neue Per-Account-Tabelle ⇒ dort eintragen**.
- `connectionFor` **cacht** die Verbindung, ein laufender Sync schreibt also
  munter weiter. Deshalb die Reihenfolge in `signOut`: Konto-Row löschen (dann
  kann niemand mehr neu verbinden) → `dropConnection` → `syncSettled` abwarten →
  erst dann alles purgen. Lokal ist der Sync zu schnell, um das im e2e-Test
  zuverlässig zu provozieren — nicht als „ungenutzt" wegoptimieren.

## Design-System (seit dem UI-Redesign)

Tokens in `src/index.css`: **OKLCH**-Farben mit Elevation-Leiter (`canvas → surface →
raised → overlay`), Akzent = tiefes Violett, `honey` als semantischer Zweitton
(Flags/Ungelesen). Flächen und Abstand tragen das Layout — **Borders sind Akzent, nicht
Haupttrenner**. Panels schweben (`panel`-Utility), Chrome ist `glass`. Schrift: Inter
Variable, self-hosted (kein CDN-Request!), Tabellenziffern global. Geteilte
Control-Klassen in `src/ui/styles.ts` (`inputClass`, `primaryButtonClass`,
`secondaryButtonClass`, `overlayPanelClass`) — **nicht wieder pro Datei duplizieren**.
Motion via `animate-rise`/`animate-fade` + `prefers-reduced-motion`-Fallback.
Bausteine: `ui/Skeleton.tsx` (statt Lade-Text), `ui/EmptyState.tsx` (statt nacktem Text).
**Scrollbalken sind global gesetzt** (`scrollbar-width: thin` + `--mel-scrollbar`,
`::-webkit-scrollbar` nur per `@supports not` für Safari): ohne das bekommt ein
verschachtelter Scroller (Ordnerliste) den dicken Browser-Default, während die
Seite selbst den schmalen Overlay-Balken hat — dieselbe Liste sah je nachdem,
welches Element gerade scrollte, unterschiedlich aus. **Das reicht noch nicht:**
nach dem Öffnen einer Mail wird der Balken der Ordnerliste weiterhin breiter
(siehe Backlog A) — nicht als erledigt abhaken.
HTML-Mail rendert bewusst auf Weiß (Absender kodieren dunkle Schrift hart);
**Klartext-Mail** folgt dem App-Theme (`textFrameDoc` bekommt die Farben übergeben).

## Deployment (seit M)

Statisches Image, kein Backend: `Dockerfile` baut das Bundle und serviert es mit
**nginx-unprivileged** (uid 101, Port 8080) — damit passt es ohne Kunstgriffe in
einen harten k8s-`securityContext` (`runAsNonRoot`, `readOnlyRootFilesystem`).
Beispiele im Repo: `compose.yaml` (Port 8081, weil 8080 das Dev-Stalwart hat)
und `deploy/k8s/` (Deployment + Service + Ingress).

Zwei Fallen, beide verifiziert:
- **nginx vererbt `add_header` nicht**: sobald ein `location` einen eigenen
  Header setzt, verliert er *alle* geerbten. Die Security-Header liegen deshalb
  in `docker/nginx-headers.conf` und werden pro Block `include`d. Ohne das
  fehlten sie ausgerechnet auf `/` (das intern auf `/index.html` fällt).
- **`sw.js` darf nicht gecacht werden**, sonst hängen Nutzer beliebig lange auf
  einem alten Build fest. Nur `/assets/*` (gehasht) ist `immutable`.

Wichtig fürs Deployment: die App spricht den JMAP-Server **direkt aus dem
Browser** an. Der Mailserver muss also CORS für die App-Origin erlauben — sonst
scheitert alles als opakes `TypeError`, und zwar unbehebbar von unserer Seite.

CI (`.github/workflows/ci.yml`): `check` (lint, build=typecheck, Vitest) und
`e2e` laufen parallel, `publish` hängt an beiden und pusht nur bei `push` nach
ghcr. Der e2e-Job testet **das Image**, nicht den Dev-Server — dafür liest
`playwright.config.ts` jetzt `MEL_E2E_BASE_URL` und lässt `webServer` dann weg.
Nur so werden nginx-Auslieferung und der in PROD registrierte Service Worker
überhaupt abgedeckt.

## Dev-Workflow

```sh
npm run stalwart:seed   # provisioniert Stalwart 0.16 in Docker von Null (idempotent)
npm run dev             # localhost:5173
npm test                # Vitest
npm run test:e2e        # Playwright (erwartet laufenden, geseedeten Stalwart)
npm run build           # vite build + tsc (Reihenfolge wichtig: routeTree.gen)
```

Accounts: `alice@localhost` / `korrekt-pferd-batterie-alice` (bob analog),
Admin-Passwort in `docker/stalwart/.admin-pass`. Kompletter Reset: siehe README.

## Nächste Schritte (Reihenfolge vom User bestätigt)

1. ~~Kalender Week-/Day-Grid, Multi-Kalender-Farben/Toggles~~ **erledigt.**
   Drag-Move/Resize von Events fehlt noch (aktuell: Klick-to-create + Dialog-Edit,
   kein Drag) — bei Bedarf nachreichen.
2. ~~Einladungen/RSVP~~ **erledigt** (s. o.). Offen als Nachtrag:
   `CalendarEventNotification/get` wird noch nicht gelesen — der Server führt die
   Liste (Typ `updated`/`created`, mit `changedBy` und `eventPatch`), damit ließe
   sich „Bob hat zugesagt" als Benachrichtigung zeigen statt nur als Status im
   Dialog. Ebenso fehlen lokale Kalender-Alerts.
3. **recurrenceOverrides** (einzelne Instanzen bearbeiten — Stalwart-Format siehe
   tests/src/jmap/calendar/event.rs im Stalwart-Repo)
4. **vCard-Import/Export**, Kontaktgruppen-UI
5. Inline-Bilder im Compose (cid:), Threading-Ansicht der Mail-Liste
6. **Sieve-Editor zuletzt** (explizit vom User zurückgestellt)

Offen außerdem: Push-Test auf echtem Gerät (User), Fastmail-Interop Kontakte (User),
Event-Sync-Fensterung für große Kalender, Woche-1-Perf mit 50k Mails.

### Neu angemeldet (Reihenfolge noch NICHT mit dem User abgestimmt)

Priorisierung steht aus, also vor dem Loslegen kurz nachfragen, was zuerst soll.
**B, C und E sind erledigt**, der Rest ist offen. A ist kein Bug (s. dort).

**A. Bug: Scrollbalken der Ordnerliste wird breiter, sobald eine Mail geöffnet
wird.** Der globale `scrollbar-width: thin`-Fix (s. o.) hat nur die
Ausgangs-Inkonsistenz beseitigt, nicht diesen Wechsel. Noch nicht untersucht.
Verdächtige, in dieser Reihenfolge: (1) beim Wechsel auf
`/mail/$mailboxId/$emailId` scrollt womöglich ein anderes Element als vorher —
erst per DevTools feststellen, *welcher* Container den Balken hat, bevor an CSS
gedreht wird; (2) `@view-transition { navigation: auto }` in `index.css`;
(3) das ReadingPane-iframe. Reproduzieren nur mit überlaufender Ordnerliste,
also schmales/niedriges Fenster. Headless Chromium zeigt Overlay-Scrollbars
(Breite 0) — der Bug ist dort **nicht** sichtbar, ein e2e-Test darauf wäre
wertlos; am echten Browser messen.

**B. ~~Sync-Status unten in der Ordner-Sidebar~~ erledigt.**
`features/mail/SyncStatus.tsx` zeigt den *tatsächlichen* Live-Modus (Push via
SSE / „Abruf alle 30 s" / Verbinde / Offline), wann zuletzt erfolgreich
synchronisiert wurde, und wie viele Outbox-Einträge noch warten. Der Scheduler
führt dafür einen kleinen beobachtbaren Store (`getSyncStatus` /
`subscribeSyncStatus`, angezapft per `useSyncExternalStore`) — Snapshots werden
**ersetzt, nie mutiert**, sonst merkt React die Änderung nicht.
Zwei Details, die beim Nachbauen leicht schiefgehen: das `nav` war selbst der
Scroll-Container, der Footer wäre also mitgescrollt — jetzt `nav` = Spalte,
innerer `div` = Scrollbereich; und der Web-Push-Hinweis hängt an
`isSubscribed()`, nicht an `capabilities.webPush`, sonst behauptet die Leiste
„Push-Benachrichtigungen an", obwohl gar kein Abo existiert.
Die Leiste rendert **immer zwei Zeilen** (zweite ggf. leer, feste Höhe) — sie
ist unten angepinnt, eine erscheinende Zeile würde die Ordnerliste schieben.
Der letzte Sync steht im `title`, nicht im Text: bei Push stünde dort dauerhaft
„gerade eben" (User-Vorgabe).

**C. ~~Feature-Caps und ihre Gates sichtbar machen~~ erledigt.**
Settings-Sektion „Server-Funktionen" (`features/settings/`): jede Capability mit
Zustand **und der Auswirkung im UI** — die Flag-Liste allein erklärt nichts, ein
ausgeblendetes Feature ist ja per Definition unsichtbar. Erreichbar über die
Sync-Leiste unten in der Sidebar (dorthin schaut man, wenn etwas komisch ist)
und über die Sperrbildschirme von Kalender/Kontakte. Die sagten vorher
„coming in a later phase" — falsch, die Features sind fertig, der *Server* kann
sie nicht; jetzt „Dieser Server bietet keinen Kalender an" + Link.
`capabilityRows()` ist rein und getestet; ein Test hält Zeilen und
`AccountCapabilities` deckungsgleich, **neue Capability ⇒ dort eintragen**,
sonst schlägt er fehl.

**D. Kalender anlegen** (und vermutlich umbenennen/löschen). Serverseitig
vorhanden: `Calendar/set`, und die Account-Capability meldet
`"mayCreateCalendar": true` (beim RSVP-Probing gesehen). Es fehlt der
Provider-Teil (`CalendarProvider` in `providers/types.ts` kennt nur
`syncCalendars`) plus UI in der Kalender-Sidebar — analog zur schon
existierenden Ordner-Verwaltung in `MailboxSidebar.tsx`.

**E. ~~Massenbearbeitung~~ erledigt.** Auswahl per Checkbox (der Avatar wird bei
Hover dazu — kostet keine Spalte), Toolbar ersetzt bei aktiver Auswahl die
Suchzeile: gelesen/ungelesen, Flag, In Ordner verschieben, Archivieren,
Löschen — mit Undo. Auswahl-State liegt in `app/store.ts`, **nicht** in den
Zeilen: Virtuoso unmountet weggescrollte Rows samt ihrem State. Beim
Ordnerwechsel wird die Auswahl verworfen.
Drei Dinge, die daran hängen:
- `services/mailActions.ts` hat Bulk-Varianten, die **eine** Outbox-Action mit
  allen Ids einreihen (nicht n Stück). `bulkDelete` teilt auf: was schon im
  Papierkorb liegt, wird endgültig zerstört, der Rest wandert dorthin — nur der
  zweite Teil ist per Undo umkehrbar.
- `setEmails()` im JMAP-Provider **chunkt jetzt gegen `maxObjectsInSet`** (500
  bei Stalwart). Ohne das sprengt „ganzer Ordner" das eine `Email/set`.
- „Alles im Ordner" nimmt **nicht** die lokal geladenen Ids, sondern fragt
  `queryMailboxIds()` serverseitig ab (Deckel: 5000).

**F. Spam gesondert behandeln:** keine externen Inhalte automatisch laden, dazu
ein „Kein Spam"-Button (Move in den Posteingang; ob Stalwart zusätzlich
Lernen/Sieve anstößt, ist zu prüfen — der Spamfilter ist im Dev-Seed
abgeschaltet, s. `seed.sh`). Die Junk-Rolle kennt die Mailbox-Liste bereits.

**G. Option „Bilder nicht automatisch laden"** (global, mit Freigabe pro Mail).
Das ist der Mechanismus, auf dem F aufsetzt — F ist im Grunde G plus „in Junk
immer an". Betrifft `lib/htmlSanitize.ts` und das Mail-iframe im ReadingPane;
Remote-Referenzen müssen dort blockiert und nach Freigabe nachgeladen werden.

**H. Bug: `capabilities.submission` gated nichts.** Beim Bauen von C
aufgefallen: Das Flag wird in `capabilitiesFor()` berechnet, aber nirgends
abgefragt. Auf einem Server ohne `urn:ietf:params:jmap:submission` bietet die
App also „Neue Nachricht" an, und der Versand scheitert erst still in der
Outbox. Verwandt: der App-Switcher zeigt Mail **immer**
(`a.cap === 'mail' || …`), auch wenn `capabilities.mail` false ist — dann ist
`conn.mail` null und die Ansicht bleibt leer. Beides steht so (ehrlich) schon in
der neuen Settings-Sektion; die Gates fehlen aber noch. Vom User als eigener
Punkt gewünscht.

**I. Capabilities beim Login eingefroren.** `capabilitiesFor()` läuft nur in
`addAccount()`; `open()` hat die frische Session zwar in der Hand, schreibt den
gespeicherten Stand aber nie fort. Ändert der Server etwas, merkt die App es
**nie** — der User hatte deshalb plötzlich keinen Kalender mehr und musste sich
neu anmelden, um ihn zurückzubekommen. `open()` sollte die Account-Row
aktualisieren. Dazu (Wunsch des Users) ein **Knopf „neu laden"** in der neuen
Settings-Sektion `features/settings/ServerCapabilities.tsx`.

**J. „Alles im Ordner" schneidet bei 5000 Ids stumm ab.**
`SELECT_ALL_LIMIT` in `features/mail/SelectionToolbar.tsx`. Für eine ehrliche
Anzeige („12.480 Mails, die ersten 5000 ausgewählt") braucht es die Gesamtzahl
aus `Email/query` mit `calculateTotal: true`.

**K. Panels in der Breite ziehbar** — Ordner / Mailliste / Detailansicht.
Die Breiten stehen heute fest in `app/routes/mail.tsx` (`lg:w-56`) und
`mail.$mailboxId.tsx` (`lg:w-96`). Gewählte Breiten pro Gerät in localStorage,
analog zu den Kalender-Sichtbarkeits-Toggles.

**L. Theme- und Abmelden-Knopf oben rechts haben keinen Zeiger-Cursor.**
`app/AppShell.tsx`; Einzeiler (`cursor-pointer`), aber Buttons ohne
`cursor: pointer` fühlen sich tot an. Beim Prüfen gleich die übrigen
Icon-Buttons mitnehmen.

**M. ~~GitHub CI~~ erledigt** — s. Abschnitt „Deployment" oben. Offen bleibt,
dass noch nie ein Lauf auf GitHub selbst stattgefunden hat: lokal ist alles
verifiziert (Image gebaut, Container getestet, `kubectl --dry-run` sauber), der
erste echte Workflow-Lauf steht aber aus.

**N. Theme-Editor**, mit dem sich die UI-Farben anpassen lassen, gespeichert im
Browser (localStorage). Die Tokens sind bereits zentral als OKLCH-Variablen in
`src/index.css` definiert und werden über `@theme` auf Tailwind gemappt — ein
Editor müsste also nur die `--mel-*`-Variablen auf `:root` überschreiben.

**O. Settings serverseitig ablegen**, damit dieselben Einstellungen in mehreren
Browsern gelten — **ohne eigenes Backend**. Zwei Kandidaten, beide vom User
genannt: als Mail in einem eigenen Ordner, oder über den JMAP-FileNode-Storage.
Wichtig: Stalwart meldet in der Session bereits
`urn:ietf:params:jmap:filenode` (beim Capability-Probing gesehen), das wäre
also der naheliegendere Weg — aber **nicht standardisiert**, also hinter einer
Capability-Prüfung und mit Fallback auf rein lokale Settings.

**P. Ordner verschieben** (Wunsch des User). Serverseitig trivial:
`Mailbox/set` `update: {id: {parentId}}` — `MailboxEdit.update` kennt `parentId`
bereits, `renameMailbox` nutzt denselben Weg. Es fehlt nur die UI. Naheliegend:
Eintrag „Verschieben nach…" im „…"-Menü der Ordnerzeile (analog zum
Verschieben-Menü in `features/mail/SelectionToolbar.tsx`), Drag & Drop wäre die
Kür. Achtung: Zyklen verhindern (ein Ordner darf nicht unter einen seiner
eigenen Nachfahren) — `descendantsOf()` aus `features/mail/mailboxTree.ts`
liefert die Ausschlussliste.

### e2e-Stabilität (die früheren „Flakes" waren echte Ursachen)
Die Suite galt lange als sporadisch flaky (~40 % rote Voll-Läufe) und das war als
CPU-Last abgetan. Das war **falsch** — es waren drei reale Ursachen, alle gefixt:

0. **Angesammelter Posteingang.** `global-setup` räumte Drafts/Sent/Ordner auf,
   ließ den **Inbox** aber unangetastet. Mit dem RSVP-Test kommen pro Lauf echte
   iMIP-Mails an („Accepted: …" bei alice, „Invitation: …" bei bob) — nach ein
   paar Läufen standen die vor den Seed-Mails, und die virtualisierte Liste
   rendert `Willkommen bei mel`/`HTML-Test` dann gar nicht mehr. Symptom: mehrere
   Mail-Specs finden „ihre" Mail nicht. Bob hatte so **70** Altmails angesammelt.
   `global-setup` trimmt den Inbox jetzt auf die Seed-Betreffs (`SEEDED_INBOX`).

0b. **Knöpfe, die still nichts tun.** „Neuer Termin" hatte `if
   (!defaultCalendarId) return` — solange die Kalender noch nicht gesynct
   waren, passierte beim Klick nichts, und der Test lief in den Timeout. Unter
   Last (2 Worker) traf er dieses Fenster etwa jeden dritten Lauf. Der Knopf
   ist jetzt `disabled`, womit Playwright von selbst wartet. **Regel: ein
   Handler, der früh `return`t, gehört als `disabled` sichtbar gemacht** —
   sonst ist es für Nutzer wie Tests ein toter Knopf.

1. **Angesammelte Testdaten.** Jeder Lauf ließ Entwürfe/Sent-Mails/Kontakte/Events
   zurück (der Draft-Autosave-Test *muss* einen Entwurf hinterlassen; fehlgeschlagene
   Tests überspringen ihr Cleanup). Nach ~50 Mails wurde der Erst-Sync so langsam,
   dass 15-s-Waits rissen. → `e2e/global-setup.ts` setzt beide Konten vor jedem Lauf
   auf den Seed-Zustand zurück. Per-Test-Cleanup allein reicht prinzipiell nicht.
2. **Echter App-Bug** (siehe `mail.tsx`): der Inbox-Auto-Redirect prüfte nicht, ob man
   noch auf `/mail` ist. Klick auf Kalender/Kontakte während des Erst-Syncs riss einen
   zurück. Regression: `e2e/navigation.spec.ts`.
3. **Stalwart-Ratenlimit**: 25 Mails/Stunde pro Absender-Empfänger-Paar. Der Send-Test
   schickt alice→bob bei jedem Lauf; nach ~25 Läufen kam `452 4.4.5 Rate limit
   exceeded` — sichtbar nur als „Mail kommt nie an". In `seed.sh` für Dev abgeschaltet
   (`x:MtaInboundThrottle`, `enable:false`).

Außerdem: `workers: 2` und `mobile` hängt via `dependencies` hinter `desktop` — alle
Specs fahren dasselbe Konto, parallele Dateien haben sich gegenseitig Mails
wegarchiviert. Seither 6/6 grüne Voll-Läufe. **Wenn wieder etwas flackert: erst diese
drei Klassen prüfen (Kontostand, geteilter Zustand, Serverlimits), nicht Systemlast
annehmen.**

## Stolpersteine (hart erarbeitet — nicht neu entdecken)

- **Stalwart ≥0.16 hat KEINE REST-Admin-API.** Alles über JMAP-Management
  (`urn:stalwart:jmap`, Objekte `x:Bootstrap`, `x:Http`, `x:Account`, `x:Jmap`,
  `x:Task`…). Schema: `GET /api/schema` (gzip). Details in `docker/stalwart/seed.sh`
  und in der Memory-Datei `stalwart-jmap-management-api.md`. Kernpunkte: Settings im
  Bootstrap-Modus überleben nicht (erst Restart, dann als permanenter Admin
  konfigurieren, nochmal Restart); Credentials-Maps brauchen numerische Keys;
  zxcvbn-Passwortzwang; EHLO ohne Punkt → 550; `STALWART_PUBLIC_URL` nötig;
  `usePermissiveCors` reicht nicht (statische `responseHeaders` nötig);
  FTS braucht `searchStore` + ggf. `reindex`-Task; VAPID = `webPushKey`
  (`{"@type":"Text","secret":"<PKCS#8 PEM>"}`).
- **Ein Browser kann CORS nicht von DNS-Fehler/Refused/TLS unterscheiden** —
  `fetch()` wirft für alles dasselbe opake `TypeError: Failed to fetch`. Also
  nie „CORS-Fehler" behaupten; `lib/netError.ts` klassifiziert nur grob
  (`unreachable`/`auth`/`other`) und die Texte nennen die Kandidaten plus den
  Hinweis auf die Browser-Konsole, wo der echte Grund steht.
  Zwei Stellen, an denen der Fehler früher komplett verschwand:
  1. `startSse()` holte die Session **außerhalb** seines `try` — schlug das per
     CORS fehl, lief die Rejection ins Leere, es gab keinen Poll-Fallback und
     die Statusleiste stand für immer auf „Verbinde…".
  2. `tick()` verschluckte jeden Fehler (`catch {}`), ein abgelehnter Server sah
     also aus wie ein leeres Postfach. `SyncStatus.error` trägt das jetzt.
  Beim Login unterscheidet `NoServerFound.lastError` jetzt „nichts gefunden" von
  „nicht erreichbar" — sonst schickt „Kein Mailserver gefunden" den User auf
  Tippfehlersuche, obwohl sein Server läuft und nur die CORS-Header fehlen.
- **e2e: `page.route('**/jmap/**')` blockt auch die eigenen App-Module**, die
  Vite im Dev unter `src/providers/jmap/…` ausliefert → weiße Seite, Test misst
  nichts. Für Verbindungsabbrüche die Server-Origin routen
  (`http://localhost:8080/**`).
- **Paging: Cursor immer um die *angeforderte* Seitengröße weiterschieben.**
  In `listAllEmailHeaders` stand `limit: QUERY_PAGE` (200), der Cursor lief aber
  um `BULK_QUERY_PAGE` (1000) weiter → **80 % aller Mails wurden nie geholt**,
  und weil `fullEmailSync` lokale Zeilen löscht, die der Server angeblich nicht
  mehr hat, wurden sie zusätzlich **aktiv gelöscht**. Symptom: Ordner sieht leer
  aus, Server meldet aber Mails. Regression in `providers/jmap/mail.test.ts`
  (Seiten müssen lückenlos `[0, 200, 400, 600]` sein). Entstanden durch ein
  globales Suchen-und-Ersetzen — bei `position +=` genau hinsehen.
- **Ein Delta-Sync repariert keine Lücken.** Fehlende Zeilen hat der Server nie
  „geändert", der Cursor überspringt sie also für immer. Dafür gibt es
  `resyncAccount()` (Settings → Konto → „Alles neu abrufen"): wirft die
  Sync-Cursor weg, erzwingt einen Vollsync, füllt auf und räumt auf.
- **Ordner löschen hat zwei getrennte Ablehnungen** (am Server verifiziert):
  `mailboxHasChild` („Mailbox has at least one children.") → Kinder müssen
  zuerst weg; `mailboxHasEmail` („Mailbox is not empty.") → braucht
  `onDestroyRemoveEmails: true`. Letzteres löscht Mails **nicht** pauschal: jede
  Mail verliert nur diese Mailbox, endgültig weg ist sie nur, wenn sie sonst
  nirgends lag. Der Bestätigungsdialog sagt das so.
  **Die Ordnerliste dafür kommt vom Server** (`serverMailboxes()`), nicht aus
  Dexie: der Fall tritt ja gerade auf, wenn der lokale Spiegel unvollständig ist
  — sonst findet die App keine Kinder und scheitert im Kreis. Gelöscht wird
  tiefstes Kind zuerst.
- **Die Ordner-Sidebar war eine flache, global sortierte Liste** mit pauschal
  2 rem Einzug für alles mit Parent. Unterordner standen dadurch alphabetisch
  zwischen fremden Ordnern und ein Elternordner sah kinderlos aus.
  `features/mail/mailboxTree.ts` ordnet jetzt als echten Baum (Einzug pro Ebene);
  Ordner mit unbekanntem Parent werden als Wurzel gezeigt statt verschluckt.
- **`new URL()` zerstört `{platzhalter}`** der JMAP-URL-Templates (percent-encoding)
  — Fix in `client/session.ts` `abs()`; nicht entfernen.
- **JMAP `properties: []` heißt „nur id"** — für alle Properties `undefined` schicken
  (Bug hatte Mailbox-Namen lokal gewischt).
- **Dexie-Crypto-Middleware muss synchron sein** (async WebCrypto → IndexedDB-Txn
  auto-commit), daher @noble/ciphers. **Keine Cursor-Reads** (`.filter().first()`,
  `.each()`) auf Tabellen mit payload — nur get/bulkGet/toArray/query, sonst
  umgeht man die Entschlüsselung (openEnvelope wirft dann).
- Stalwart-Kalender: `recurrenceRule` **Singular** (nicht `recurrenceRules`);
  ContactCards sind **flache** JSContact-Objekte (kein `card`-Wrapper).
- **Scheduling/iTIP hat drei Fallen, alle stumm** (mühsam erprobt, s.
  `providers/jmap/calendars.ts`):
  1. `CalendarEvent/set` braucht das Argument **`sendSchedulingMessages: true`**.
     Ohne das wird der Termin samt Teilnehmern gespeichert, aber **keine
     Einladung verschickt** — kein Fehler, keine Warnung.
  2. Teilnehmer heißen bei Stalwart **`calendarAddress: "mailto:…"`** (neuer
     JSCalendar-Entwurf), *nicht* `sendTo`/`email`/`replyTo` wie in RFC 8984.
     Schickt man die RFC-8984-Form, landet sie als opaker `JSPROP`-Fallback im
     iCalendar, es entstehen **keine ATTENDEE-Zeilen**, `/get` liefert
     `participants` gar nicht zurück — und wieder: kein Fehler.
  3. `roles: {owner: true}` allein reicht nicht: **ohne
     `organizerCalendarAddress` schreibt Stalwart keinen ORGANIZER** und
     verschickt nichts. Preis dafür: der Server spiegelt den Organisator als
     zweiten, rollenlosen Teilnehmer-Eintrag zurück — `toParticipants` faltet
     das über die Adresse wieder zusammen und behält den Eintrag *mit* Rollen
     (nur dessen Key funktioniert für RSVP-Patches).
  Rollen sind `owner`/`chair`/`required`/`optional`. RSVP = Patch auf
  `participants/<id>/participationStatus` (ein Patch, der einen *ganzen* neuen
  Teilnehmer anlegen will, scheitert mit `invalidPatch`).
  Debug-Trick: den rohen iCalendar über CalDAV lesen
  (`PROPFIND`/`GET` auf `/dav/cal/<user>/default/…`) — dort sieht man sofort, ob
  ATTENDEE/ORGANIZER wirklich geschrieben wurden oder nur `JSPROP`-Zeilen.
- Server-Settings dafür: `x:CalendarScheduling` (`enable`, `autoAddInvitations`,
  HTTP-RSVP) — im Dev-Stalwart ist `enable` schon an, nichts zu tun.
- Kalender geht nur gegen Stalwart (Fastmail hat keinen Standard-JMAP-Kalender);
  Capability-gating in AppShell vorhanden.
- e2e: Desktop+Mobile teilen einen Server-Account → zustandsändernde Specs nur
  desktop (`testIgnore`); Tests müssen ihre Server-Artefakte aufräumen oder
  zufällige Namen/Tage nutzen (Kalender-Zellen cappen bei 3 Chips).
- **`new Date()` als Anchor/Grid-Datum trägt die aktuelle Uhrzeit mit** — direkt als
  Sync-Fenstergrenze benutzt (`grid[0]`/`grid[last]`) verschiebt das Fenster nach
  Mittag auf "jetzt bis morgen-jetzt" statt Mitternacht-Mitternacht, wodurch frühere
  Events rausfallen. Immer auf Mitternacht normalisieren, bevor Datumsobjekte als
  Fenstergrenzen verwendet werden (siehe `byDay` in `calendar.tsx`).
- **`e2e/contacts.spec.ts` hat früher nie aufgeräumt** → bei jedem Lauf ein weiterer
  "Erika Testling…"-Kontakt, bis `suggestRecipients` (Cap bei 8 Treffern) den neusten
  irgendwann verdrängt und der Test flackert. Gefixt (löscht sich jetzt selbst) —
  falls wieder Kontakt-Autocomplete-Flakes auftreten, zuerst `ContactCard/get` auf
  dem Account prüfen, ob sich wieder Test-Leichen angesammelt haben.
- **Hover-Swaps müssen höhenneutral sein.** In der Ordnerliste wird der
  Ungelesen-Zähler bei Hover gegen den „…"-Menü-Button getauscht; der war höher
  als das Badge, wodurch jede Zeile darunter um 3 px sprang. Beide sitzen jetzt
  in einer festen 20-px-Box, die Zeile hat `min-h-[34px]` + `leading-5`.
  Regression: `e2e/navigation.spec.ts` misst jede Zeile mit und ohne Hover.
- **JMAP-`preview` enthält oft CSS.** Baut der Server die Vorschau aus dem
  HTML-Teil, rutscht der Inhalt eines inline-`<style>` mit hinein und die Liste
  zeigt „html, body, * { -webkit-text-size-adjust: none; …". Da die Vorschau
  abgeschnitten wird, ist der Block meist **unbalanciert** — `lib/preview.ts`
  entfernt darum auch die angefangene letzte Regel. Nur Blöcke mit
  `prop: value` fliegen raus, damit „Hi {name}" heil bleibt.
- Playwright `getByRole({name: 'X'})` matcht **case-insensitive als Substring**
  (nicht exact) — "Week" matchte z. B. Reste mit "…weekly" im Titel. Bei kurzen/
  generischen Labels (View-Switcher, Aktions-Buttons) `exact: true` setzen.

## Architektur-Regeln

- `src/domain/` provider-agnostisch, importiert nie aus `providers/`.
- Alle Rows tragen Inhalte im `plain`/`enc`-Umschlag (`storage/envelope.ts`);
  Index-Spalten nur IDs/Timestamps/Flags (Verschlüsselung!).
- Mutationen: lokal optimistisch + `sync/outbox.ts`-Action (Ausnahme: Creates
  mit Navigations-Ziel sind server-first mit Offline-Fallback, s. contacts.ts).
- Commits auf Deutsch zusammengefasste Phasen, englische Messages, mit
  Co-Authored-By-Trailer. **Nach einem fertigen Feature erst beim User
  nachfragen, ob alles passt — dann erst committen** (ausdrückliche Vorgabe).
  Er prüft im echten Browser und findet dort regelmäßig, was Tests nicht sehen.
