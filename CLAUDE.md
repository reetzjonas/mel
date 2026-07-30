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

Tests: 23 Vitest + 22 Playwright (Desktop+Mobile; zustandsändernde Specs desktop-only,
siehe `testIgnore` in playwright.config.ts). Fastmail-Interop Mail vom User bestätigt.

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

1. **Kalender Week-/Day-Grid** (Drag-Create/Move), Multi-Kalender-Farben/Toggles
2. **Einladungen/RSVP** (Teilnehmer im EventDialog; Stalwart macht iTIP/iMIP
   serverseitig; `CalendarEventNotification`-Anzeige; Kalender-Alerts lokal)
3. **recurrenceOverrides** (einzelne Instanzen bearbeiten — Stalwart-Format siehe
   tests/src/jmap/calendar/event.rs im Stalwart-Repo)
4. **vCard-Import/Export**, Kontaktgruppen-UI
5. Inline-Bilder im Compose (cid:), Threading-Ansicht der Mail-Liste
6. **Sieve-Editor zuletzt** (explizit vom User zurückgestellt)

Offen außerdem: Push-Test auf echtem Gerät (User), Fastmail-Interop Kontakte (User),
Event-Sync-Fensterung für große Kalender, Woche-1-Perf mit 50k Mails.

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

## Architektur-Regeln

- `src/domain/` provider-agnostisch, importiert nie aus `providers/`.
- Alle Rows tragen Inhalte im `plain`/`enc`-Umschlag (`storage/envelope.ts`);
  Index-Spalten nur IDs/Timestamps/Flags (Verschlüsselung!).
- Mutationen: lokal optimistisch + `sync/outbox.ts`-Action (Ausnahme: Creates
  mit Navigations-Ziel sind server-first mit Offline-Fallback, s. contacts.ts).
- Commits auf Deutsch zusammengefasste Phasen, englische Messages, mit
  Co-Authored-By-Trailer; nur committen wenn der User es will (bisher: ja, pro
  abgeschlossenem Block).
