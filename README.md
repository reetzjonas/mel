# mel

Backend-loser JMAP-Webmailer als PWA — Mail, Kalender und Kontakte, alle Daten lokal im
Browser (IndexedDB, optional verschlüsselt). React 19 + TypeScript + Vite.

## Entwicklung

```sh
npm install
npm run stalwart:seed   # startet + provisioniert den lokalen Stalwart (Docker)
npm run dev             # App auf http://localhost:5173
```

Dev-Zugänge (lokaler Stalwart, `http://localhost:8080`):

| Wer | Login |
| --- | --- |
| alice | `alice@localhost` / `korrekt-pferd-batterie-alice` |
| bob | `bob@localhost` / `korrekt-pferd-batterie-bob` |
| Admin-UI | `admin@localhost` / siehe `docker/stalwart/.admin-pass` |

Testmail einspeisen: `curl "smtp://localhost:1025/seed.mel.dev" --mail-from bob@localhost --mail-rcpt alice@localhost -T mail.eml` (der EHLO-Name im URL-Pfad muss einen Punkt enthalten, sonst 550).

## Tests

```sh
npm test                # Vitest (Unit)
npm run test:e2e        # Playwright (Desktop- + Mobile-Viewport, erwartet laufenden Stalwart)
npm run build           # vite build + tsc Typecheck
```

## Stalwart zurücksetzen

```sh
npm run stalwart:down
docker volume rm stalwart_stalwart-data
rm -rf docker/stalwart/etc docker/stalwart/.admin-pass
npm run stalwart:seed
```

Hintergrund: Stalwart ≥ 0.16 wird komplett über seine JMAP-Management-API provisioniert
(Capability `urn:stalwart:jmap`, Objekte `x:Bootstrap`, `x:Http`, `x:Account`, …) —
`docker/stalwart/seed.sh` dokumentiert die Details.

## JMAP-Server ohne CORS (Dev-Proxy)

Produktiv braucht die App einen CORS-fähigen JMAP-Server (Stalwart: „Permissive CORS";
Fastmail: API-Token). Für Dev gegen einen Server ohne CORS:

```sh
MEL_PROXY_TARGET=https://mail.example.com npm run dev
```

Requests laufen dann über `http://localhost:5173/jmap-proxy/*`.

## Architektur (Kurzfassung)

- `src/domain/` — provider-agnostische Modelle (kein JMAP-Import erlaubt)
- `src/providers/jmap/` — JMAP-Client, Mapper, Push (später: IMAP/Gmail-Provider)
- `src/sync/` — Delta-Sync (`Foo/changes`), Outbox, Scheduler
- `src/storage/` — Dexie-Schema; jede Zeile trägt ihren Inhalt in einem
  `plain`/`enc`-Umschlag (Verschlüsselungs-Naht ab Tag 1, Krypto folgt in Phase 5)
- `src/features/` — Mail/Kalender/Kontakte/Settings-UI
