#!/usr/bin/env bash
# Provisions the local Stalwart dev server end to end. Idempotent — safe to re-run.
#
# Stalwart v0.16 has no REST admin API anymore; everything is driven through its
# JMAP management API (capability urn:stalwart:jmap, objects x:Bootstrap,
# x:Http, x:Account, ...). Flow:
#   1. fresh volume → server boots in bootstrap mode; STALWART_RECOVERY_ADMIN
#      pins temporary credentials (admin:meladmin)
#   2. x:Bootstrap/set configures storage/domain/hostname and returns the
#      PERMANENT admin credentials (admin@localhost + generated password,
#      saved to .admin-pass)
#   3. x:Http/set enables permissive CORS (needs restart to take effect)
#   4. x:Account/set creates alice/bob (credential map keys must be numeric,
#      passwords must pass zxcvbn strength check)
#   5. test mail via SMTP port 25 (EHLO name must contain a dot!)
set -euo pipefail
cd "$(dirname "$0")"

BASE=http://localhost:8080
JMAP=$BASE/jmap/
PASS_FILE=.admin-pass
BOOT_AUTH='admin:meladmin'
ALICE_PASS='korrekt-pferd-batterie-alice'
BOB_PASS='korrekt-pferd-batterie-bob'
MGMT_USING='"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"]'

# The container runs as uid 2000 and must be able to write config.json here.
mkdir -p etc && chmod 777 etc

docker compose up -d

wait_http() {
  for i in $(seq 1 60); do
    curl -fso /dev/null "$BASE/healthz/live" && return 0
    sleep 1
  done
  echo "Stalwart did not come up"; exit 1
}
wait_http

jmap() { # auth-user:pass json-methodCalls
  curl -fsS -u "$1" "$JMAP" -H 'Content-Type: application/json' -d "{$MGMT_USING,\"methodCalls\":$2}"
}

if [ ! -f etc/config.json ]; then
  echo "Bootstrapping (unattended setup)..."
  RESP=$(jmap "$BOOT_AUTH" '[["x:Bootstrap/set",{"update":{"singleton":{
    "serverHostname":"localhost","defaultDomain":"localhost",
    "dataStore":{"@type":"RocksDb","path":"/var/lib/stalwart"},
    "searchStore":{"@type":"Default"},
    "directory":{"@type":"Internal"},
    "generateDkimKeys":true,"requestTlsCertificate":false}}},"c0"]]')
  echo "$RESP" | grep -q '"updated"' || { echo "Bootstrap failed: $RESP"; exit 1; }
  echo "$RESP" | sed -E 's/.*"secret":"([^"]+)".*/\1/' > "$PASS_FILE"
  echo "Permanent admin: admin@localhost / $(cat $PASS_FILE)"

  echo "Restarting into normal mode..."
  docker compose restart stalwart > /dev/null
  wait_http

  # Settings written during bootstrap mode don't survive into the final DB —
  # configure as the permanent admin now, then restart once more to apply.
  ADMIN_AUTH="admin@localhost:$(cat $PASS_FILE)"

  echo "Configuring VAPID key for Web Push (RFC 9749)..."
  VAPID_PEM=$(openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt)
  VAPID_JSON=$(printf '%s' "$VAPID_PEM" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(d)))")
  jmap "$ADMIN_AUTH" "[[\"x:Jmap/set\",{\"update\":{\"singleton\":{
    \"webPushKey\":{\"@type\":\"Text\",\"secret\":$VAPID_JSON},
    \"webPushContact\":\"mailto:admin@localhost\"}}},\"c0\"]]" > /dev/null

  # usePermissiveCors only answers OPTIONS on some routes; actual responses
  # (and e.g. OPTIONS /jmap/session) need the static responseHeaders too.
  echo "Enabling CORS + disabling spam filter (dev)..."
  jmap "$ADMIN_AUTH" '[["x:Http/set",{"update":{"singleton":{
    "usePermissiveCors":true,
    "responseHeaders":{
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Methods":"POST, GET, PATCH, PUT, DELETE, HEAD, OPTIONS",
      "Access-Control-Allow-Headers":"Authorization, Content-Type, Accept, X-Requested-With",
      "Access-Control-Expose-Headers":"*"}}}},"c0"],
    ["x:SpamSettings/set",{"update":{"singleton":{"enable":false}}},"c1"]]' > /dev/null

  # Stalwart ships an inbound throttle of 25 messages/hour per sender-recipient
  # pair. The e2e suite sends alice->bob on every run, so a few runs exhaust it
  # and submissions come back "452 4.4.5 Rate limit exceeded" — which surfaces
  # as mail silently never arriving. Off for dev.
  echo "Disabling SMTP throttles (dev)..."
  THROTTLE_IDS=$(jmap "$ADMIN_AUTH" '[["x:MtaInboundThrottle/query",{},"c0"]]' |
    grep -oE '"ids":\[[^]]*\]' | grep -oE '"[a-z0-9]+"' | tr -d '"')
  for tid in $THROTTLE_IDS; do
    jmap "$ADMIN_AUTH" "[[\"x:MtaInboundThrottle/set\",{\"update\":{\"$tid\":{\"enable\":false}}},\"c0\"]]" > /dev/null
  done

  echo "Restarting to apply HTTP settings..."
  docker compose restart stalwart > /dev/null
  wait_http
fi

[ -f "$PASS_FILE" ] || { echo "Missing $PASS_FILE — wipe the volume (docker compose down -v; rm etc/config.json) and re-run"; exit 1; }
ADMIN_AUTH="admin@localhost:$(cat $PASS_FILE)"

account_exists() { # user:pass
  curl -fso /dev/null -u "$1" "$JMAP"session && return 0 || return 1
}

if ! account_exists "alice@localhost:$ALICE_PASS"; then
  echo "Creating accounts alice/bob..."
  DOMAIN_ID=$(jmap "$ADMIN_AUTH" '[["x:Domain/query",{},"c0"]]' | sed -E 's/.*"ids":\["([^"]+)".*/\1/')
  RESP=$(jmap "$ADMIN_AUTH" "[[\"x:Account/set\",{\"create\":{
    \"a\":{\"@type\":\"User\",\"name\":\"alice\",\"domainId\":\"$DOMAIN_ID\",\"description\":\"Alice (dev)\",
          \"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":\"$ALICE_PASS\"}}},
    \"b\":{\"@type\":\"User\",\"name\":\"bob\",\"domainId\":\"$DOMAIN_ID\",\"description\":\"Bob (dev)\",
          \"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":\"$BOB_PASS\"}}}}},\"c0\"]]")
  echo "$RESP" | grep -q '"created"' || { echo "Account creation failed: $RESP"; exit 1; }
else
  echo "Accounts exist"
fi

# Seed mail only once (check alice's mailbox via JMAP)
ALICE_AUTH="alice@localhost:$ALICE_PASS"
ACC=$(curl -fsS -u "$ALICE_AUTH" "$JMAP"session |
  node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const s=JSON.parse(d);console.log(s.primaryAccounts['urn:ietf:params:jmap:mail'])})")
TOTAL=$(curl -fsS -u "$ALICE_AUTH" "$JMAP" -H 'Content-Type: application/json' \
  -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:ietf:params:jmap:mail\"],\"methodCalls\":[[\"Email/query\",{\"accountId\":\"$ACC\",\"calculateTotal\":true},\"c0\"]]}" |
  sed -E 's/.*"total":([0-9]+).*/\1/')

send_mail() { # from to subject body [extra-headers]
  printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%s@seed.local>\r\n%b\r\n%b\r\n' \
    "$1" "$2" "$3" "$(date -R)" "$RANDOM$RANDOM" "${5:-}" "$4" |
    curl -sS "smtp://localhost:1025/seed.mel.dev" --mail-from "$1" --mail-rcpt "$2" -T -
}

if [ "${TOTAL:-0}" -lt 4 ]; then
  echo "Seeding test mail..."
  send_mail bob@localhost alice@localhost "Willkommen bei mel" "Hallo Alice,\r\n\r\ndies ist die erste Testmail.\r\n\r\nGruss, Bob"
  send_mail bob@localhost alice@localhost "Projektstand" "Kurzes Update: Phase 0 laeuft."
  send_mail alice@localhost bob@localhost "Re: Projektstand" "Danke fuer das Update!"
  # Newsletter fixture: carries the headers the unsubscribe bar reads (RFC
  # 2369 plus the RFC 8058 one-click promise). The https target is example.com
  # on purpose — no test may actually reach it.
  send_mail news@example.com alice@localhost "Newsletter-Test" \
    "Monatliche Neuigkeiten." \
    'List-Unsubscribe: <https://example.com/unsub?id=42>, <mailto:unsub@example.com?subject=stop>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n'
  send_mail bob@localhost alice@localhost "HTML-Test" \
    '<html><body><h1>Hallo</h1><p>Dies ist <b>HTML</b>-Mail mit <a href="https://example.com">Link</a> und Umlauten: &auml;&ouml;&uuml;.</p></body></html>' \
    'MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n'

  # Multipart mail with attachments (1x1 PNG + CSV)
  PNG_B64="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  {
    printf 'From: bob@localhost\r\nTo: alice@localhost\r\nSubject: Mit Anhang\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="melbound"\r\n\r\n' "$(date -R)"
    printf -- '--melbound\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSiehe Anhang.\r\n'
    printf -- '--melbound\r\nContent-Type: image/png; name="pixel.png"\r\nContent-Disposition: attachment; filename="pixel.png"\r\nContent-Transfer-Encoding: base64\r\n\r\n%s\r\n' "$PNG_B64"
    printf -- '--melbound\r\nContent-Type: text/csv; name="daten.csv"\r\nContent-Disposition: attachment; filename="daten.csv"\r\n\r\na,b\r\n1,2\r\n'
    printf -- '--melbound--\r\n'
  } | curl -sS "smtp://localhost:1025/seed.mel.dev" --mail-from bob@localhost --mail-rcpt alice@localhost -T -
else
  echo "Mailbox already seeded ($TOTAL mails)"
fi

echo "Verifying CORS preflight from app origin..."
curl -fsS -o /dev/null -w 'Preflight: %{http_code}\n' -X OPTIONS "$JMAP" \
  -H 'Origin: http://localhost:5173' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'

echo
echo "Done."
echo "  JMAP session:  $BASE/jmap/session  (autodiscovery: $BASE/.well-known/jmap)"
echo "  Accounts:      alice@localhost / $ALICE_PASS"
echo "                 bob@localhost   / $BOB_PASS"
echo "  Web-Admin:     $BASE/admin  (admin@localhost / $(cat $PASS_FILE))"
