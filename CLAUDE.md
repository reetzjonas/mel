# mel — Kontext für die nächste Session

Backend-loser JMAP-Webmailer als PWA (Mail + Kontakte + Kalender), alle Daten in
IndexedDB, optional per Passphrase verschlüsselt. React 19 + TS strict + Vite 8,
Tailwind 4, TanStack Router, Dexie 4 (liveQuery = Read-Model), Zustand für UI-State.
UI-Sprache: **Englisch default + Deutsch** via `src/lib/i18n.ts` — nie Strings
hardcoden (User-Vorgabe). Genehmigter Gesamtplan:
`/home/joreetz/.claude/plans/ich-will-eine-pwa-hidden-ripple.md`.

## Stand (alle 6 Phasen fertig, committet, main)

Voll funktionsfähig und e2e-getestet: Login (Stalwart lokal + Fastmail-Token),
Delta-Sync (`Foo/changes` + Fallback), Outbox mit optimistischen Writes/Undo/Backoff,
SSE-Push + Polling, Compose (Tiptap, Reply/Forward mit Threading, Anhänge
offline-staged, Undo-Send 10 s, Draft-Autosave), Suche (Fastmail-Syntax → JMAP-Filter,
Snippets mit <mark>), Shortcuts (?-Overlay), Ordner-Verwaltung, Quick Actions +
Swipe + Pull-to-Refresh, Kontakte (RFC 9610, Autocomplete im Compose), Kalender
(Monat/Agenda, DST-sichere Recurrence via rrule+Temporal), Verschlüsselung
(Argon2id→KEK→DEK, sync AES-GCM via @noble/ciphers als Dexie-Middleware, AAD-Bindung,
UnlockGate), Web Push ohne Backend (RFC 9749, kompletter PushVerification-Handshake),
PWA (Update-Toast, storage.persist).

Kalender kann außerdem: Week-/Day-Zeitraster (Klick-to-create, Überlappungs-Spalten,
Now-Linie), Multi-Kalender-Farben + Sichtbarkeits-Toggles (Sidebar, localStorage),
Kalenderauswahl im EventDialog. Mail-Nacharbeiten erledigt: Anhänge öffnen (war ein
echter Bug, s. u.), Quick Actions in der Mail-Liste, Ordner-Verwaltung (anlegen/
umbenennen/löschen), Draft-Autosave, Search-Snippets mit `<mark>`, Pull-to-Refresh.
Kontakte sortieren jetzt korrekt alphabetisch nach Anzeigename.

Tests: 23 Vitest + 25 Playwright (Desktop+Mobile; zustandsändernde Specs desktop-only,
siehe `testIgnore` in playwright.config.ts). Fastmail-Interop Mail vom User bestätigt.

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
2. **Einladungen/RSVP** (Teilnehmer im EventDialog; Stalwart macht iTIP/iMIP
   serverseitig; `CalendarEventNotification`-Anzeige; Kalender-Alerts lokal)
3. **recurrenceOverrides** (einzelne Instanzen bearbeiten — Stalwart-Format siehe
   tests/src/jmap/calendar/event.rs im Stalwart-Repo)
4. **vCard-Import/Export**, Kontaktgruppen-UI
5. Inline-Bilder im Compose (cid:), Threading-Ansicht der Mail-Liste
6. **Sieve-Editor zuletzt** (explizit vom User zurückgestellt)

Offen außerdem: Push-Test auf echtem Gerät (User), Fastmail-Interop Kontakte (User),
Event-Sync-Fensterung für große Kalender, Woche-1-Perf mit 50k Mails.

### e2e-Stabilität (die früheren „Flakes" waren echte Ursachen)
Die Suite galt lange als sporadisch flaky (~40 % rote Voll-Läufe) und das war als
CPU-Last abgetan. Das war **falsch** — es waren drei reale Ursachen, alle gefixt:

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
