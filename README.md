# Fällig

Fristen im Blick behalten und die passende Nachricht dazu schreiben.

Statische PWA ohne Build-Schritt: `index.html`, `sw.js`, `manifest.webmanifest`, Icons. Live: https://faellig.netlify.app/

Stand 25.11.2026 aus dem live Netlify-Deploy übernommen.

## Tests

`tests/sync.test.mjs` laedt die echte `index.html` headless (jsdom) als zwei Geraete gegen einen nachgebauten Supabase-Server und prueft den Sync: Anlegen/Bearbeiten/Loeschen, Konflikte, falsch gehende Uhr, Token-Ablauf, Abmeldung, offline, Abbruch mitten im Sync, grosse Mengen, Sicherung uebertragen (Dazunehmen/Alles ersetzen mit Sync), Aufraeumen alter Grabsteine, Kalender-Abo, Google-Termine, Erinnerungen (Plan, Ein-/Ausschalten, Test).

`tests/google.test.mjs` prueft den iCal-Leser der Edge Function (Zeitzonen, Serien mit Ausnahmen und EXDATE, ganztaegige und abgesagte Termine).

`tests/push.test.mjs` prueft die Web-Push-Verschluesselung der Edge Function `faellig-push` gegen die Referenz `http_ece` und den VAPID-Ausweis.

```
cd tests && npm install && npm test
```

Laeuft per GitHub Action bei jedem Push. Erst wenn der Test auf einem Branch gruen ist, nach `main` mergen (Netlify deployt von `main`).

## Datenbank

SQL-Aenderungen an Supabase (Projekt `xrrcuapiugwgqxxatkiq`) liegen in `supabase/migrations/`. Die App kommt ohne die neueste Migration aus (dann wird im Konto nur nicht aufgeraeumt), sie sollte aber vor oder mit dem Merge eingespielt werden.

## Edge Function `faellig-google`

Zeigt Google-Termine in der Fristenliste (nur lesen). Die App schickt die geheime iCal-Adresse des Google-Kalenders (liegt in den Einstellungen, kommt per Sync auf alle Geraete) an `supabase/functions/faellig-google`. Die Function prueft die Anmeldung, holt nur Adressen von `calendar.google.com/calendar/ical/...`, loest Wiederholungen mit ical.js auf und gibt die Termine der naechsten 31 Tage als JSON zurueck. Gespeichert wird dort nichts. Die App merkt sich das Ergebnis je Geraet (offline sichtbar) und holt hoechstens alle 15 Minuten neu.

Deployen (falls geaendert): Supabase-Dashboard oder `supabase functions deploy faellig-google --no-verify-jwt` (die Function prueft den Zugang selbst).

## Erinnerungen aufs Handy (Edge Function `faellig-push`)

Einmal am Tag zur eingestellten Uhrzeit (Zeitzone des Geraets) eine Meldung mit Ueberfaelligem und heute, wahlweise auch morgen und den Google-Terminen des Tages. Kuendigungsfristen 30 und 7 Tage vorher als eigene Meldung. Steht nichts an, kommt nichts.

- Die App rechnet nach jedem Sync den Plan fuer die naechsten 60 Tage aus und legt ihn per `faellig_push_plan_setzen` in `faellig_push_plan`. Der Server rechnet nichts selbst.
- Jedes Geraet mit Schalter an hat ein Web-Push-Abo in `faellig_push_abo` (per `faellig_push_anmelden`, mit Zeitzone).
- pg_cron ruft alle 15 Minuten `faellig-push` mit `{ "aktion": "senden" }`; die Function holt per `faellig_push_faellig()` alles, was jetzt dran ist (hoechstens 3 Stunden nach der Uhrzeit), verschickt es (VAPID, aes128gcm, ohne Bibliothek: `webpush.js`) und merkt sich den Tag je Geraet.
- `{ "aktion": "test", endpoint }` mit Anmeldung schickt eine Probemeldung (Knopf "Test schicken").
- Schluessel liegen im Supabase-Vault: `faellig_push_vapid_privat`, `faellig_push_vapid_public`, `faellig_push_cron`. Der oeffentliche VAPID-Schluessel steht zusaetzlich in `index.html` (`ERI_VAPID`).

Deployen: Migration `20261126150000_faellig_push.sql` einspielen, Vault-Eintraege anlegen, dann `supabase functions deploy faellig-push --no-verify-jwt` (die Function prueft selbst).
