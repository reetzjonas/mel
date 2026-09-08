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

Tests: 59 Vitest + 32 Playwright (Desktop+Mobile; zustandsändernde Specs desktop-only,
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

Alles vom User in einem Rutsch gewünscht; Priorisierung steht aus, also vor dem
Loslegen kurz nachfragen, was zuerst soll.

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

**E. Massenbearbeitung** (verschieben, löschen, markieren) per Mehrfachauswahl
und zusätzlich „alle in diesem Ordner". Die Outbox kann das Batch-seitig schon:
`email.update` nimmt eine Map von Patches, `email.destroy` eine Id-Liste. Zwei
Fallstricke: die Liste ist virtualisiert (Virtuoso), Auswahl-State gehört also
in den Store und nicht in Row-Komponenten; und „alle im Ordner" darf nicht die
lokal geladenen Ids nehmen, sondern braucht eine serverseitige Query.

**F. Spam gesondert behandeln:** keine externen Inhalte automatisch laden, dazu
ein „Kein Spam"-Button (Move in den Posteingang; ob Stalwart zusätzlich
Lernen/Sieve anstößt, ist zu prüfen — der Spamfilter ist im Dev-Seed
abgeschaltet, s. `seed.sh`). Die Junk-Rolle kennt die Mailbox-Liste bereits.

**H. Bug: `capabilities.submission` gated nichts.** Beim Bauen von C
aufgefallen: Das Flag wird in `capabilitiesFor()` berechnet, aber nirgends
abgefragt. Auf einem Server ohne `urn:ietf:params:jmap:submission` bietet die
App also „Neue Nachricht" an, und der Versand scheitert erst still in der
Outbox. Verwandt: der App-Switcher zeigt Mail **immer**
(`a.cap === 'mail' || …`), auch wenn `capabilities.mail` false ist — dann ist
`conn.mail` null und die Ansicht bleibt leer. Beides steht so (ehrlich) schon in
der neuen Settings-Sektion; die Gates fehlen aber noch. Vom User als eigener
Punkt gewünscht.

**G. Option „Bilder nicht automatisch laden"** (global, mit Freigabe pro Mail).
Das ist der Mechanismus, auf dem F aufsetzt — F ist im Grunde G plus „in Junk
immer an". Betrifft `lib/htmlSanitize.ts` und das Mail-iframe im ReadingPane;
Remote-Referenzen müssen dort blockiert und nach Freigabe nachgeladen werden.

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
  Co-Authored-By-Trailer; nur committen wenn der User es will (bisher: ja, pro
  abgeschlossenem Block).
