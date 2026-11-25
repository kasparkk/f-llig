# Fällig

Fristen im Blick behalten und die passende Nachricht dazu schreiben.

Statische PWA ohne Build-Schritt: `index.html`, `sw.js`, `manifest.webmanifest`, Icons. Live: https://faellig.netlify.app/

Stand 25.11.2026 aus dem live Netlify-Deploy übernommen.

## Tests

`tests/sync.test.mjs` laedt die echte `index.html` headless (jsdom) als zwei Geraete gegen einen nachgebauten Supabase-Server und prueft den Sync: Anlegen/Bearbeiten/Loeschen, Konflikte, falsch gehende Uhr, Token-Ablauf, Abmeldung, offline, Abbruch mitten im Sync, grosse Mengen, Sicherung uebertragen (Dazunehmen/Alles ersetzen mit Sync), Aufraeumen alter Grabsteine.

```
cd tests && npm install && npm test
```

Laeuft per GitHub Action bei jedem Push. Erst wenn der Test auf einem Branch gruen ist, nach `main` mergen (Netlify deployt von `main`).

## Datenbank

SQL-Aenderungen an Supabase (Projekt `xrrcuapiugwgqxxatkiq`) liegen in `supabase/migrations/`. Die App kommt ohne die neueste Migration aus (dann wird im Konto nur nicht aufgeraeumt), sie sollte aber vor oder mit dem Merge eingespielt werden.
