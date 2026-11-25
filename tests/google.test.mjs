// Test fuer den iCal-Leser der Edge Function faellig-google (supabase/functions/faellig-google/termine.js).
// Dieselbe Datei laeuft dort unter Deno; hier mit ical.js aus npm.

import { test } from "node:test";
import assert from "node:assert/strict";
import ICAL from "ical.js";
import { termineAus } from "../supabase/functions/faellig-google/termine.js";

const TAG = 86_400_000;

// So sieht Googles "Privatadresse im iCal-Format" aus: Zeitzone mitgeliefert,
// Serien mit RRULE/EXDATE, Ausnahmen als eigene VEVENTs mit RECURRENCE-ID.
const ICS = `BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:PUBLISH
X-WR-CALNAME:k@test
X-WR-TIMEZONE:Europe/Berlin
BEGIN:VTIMEZONE
TZID:Europe/Berlin
X-LIC-LOCATION:Europe/Berlin
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=Europe/Berlin:20261201T100000
DTEND;TZID=Europe/Berlin:20261201T113000
DTSTAMP:20261125T120000Z
UID:zahnarzt@google.com
SUMMARY:Zahnarzt
LOCATION:Praxis Dr. Muster\\, Kronberg
STATUS:CONFIRMED
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Berlin:20261102T090000
DTEND;TZID=Europe/Berlin:20261102T100000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=Europe/Berlin:20261207T090000
DTSTAMP:20261125T120000Z
UID:vorlesung@google.com
SUMMARY:Vorlesung Forstökologie
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Berlin:20261214T140000
DTEND;TZID=Europe/Berlin:20261214T150000
RECURRENCE-ID;TZID=Europe/Berlin:20261214T090000
DTSTAMP:20261125T120000Z
UID:vorlesung@google.com
SUMMARY:Vorlesung Forstökologie (verlegt)
END:VEVENT
BEGIN:VEVENT
DTSTART;TZID=Europe/Berlin:20261130T090000
DTEND;TZID=Europe/Berlin:20261130T100000
RECURRENCE-ID;TZID=Europe/Berlin:20261130T090000
DTSTAMP:20261125T120000Z
UID:vorlesung@google.com
SUMMARY:Vorlesung Forstökologie
STATUS:CANCELLED
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261205
DTEND;VALUE=DATE:20261208
DTSTAMP:20261125T120000Z
UID:urlaub@google.com
SUMMARY:Wochenende Brandenburg
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261124
DTSTAMP:20261125T120000Z
UID:geburtstag@google.com
SUMMARY:Geburtstag Oma
RRULE:FREQ=YEARLY
END:VEVENT
BEGIN:VEVENT
DTSTART:20250101T080000Z
DTEND:20250101T090000Z
DTSTAMP:20261125T120000Z
UID:alt@google.com
SUMMARY:Lange her
END:VEVENT
BEGIN:VEVENT
DTSTART:20270301T080000Z
DTEND:20270301T090000Z
DTSTAMP:20261125T120000Z
UID:spaeter@google.com
SUMMARY:Zu weit weg
END:VEVENT
END:VCALENDAR
`.replace(/\n/g, "\r\n");

const VON = Date.parse("2026-11-25T00:00:00Z");
const BIS = VON + 31 * TAG;

test("Google-iCal: Einzeltermin in der richtigen Zeitzone", () => {
  const t = termineAus(ICAL, ICS, VON, BIS);
  const z = t.find((x) => x.titel === "Zahnarzt");
  assert.ok(z);
  assert.equal(z.ganztag, false);
  assert.equal(z.start, "2026-12-01T09:00:00.000Z"); // 10:00 Berlin = 09:00 UTC im Winter
  assert.equal(z.ende, "2026-12-01T10:30:00.000Z");
  assert.equal(z.ort, "Praxis Dr. Muster, Kronberg");
});

test("Google-iCal: Serie mit EXDATE, verlegtem und abgesagtem Termin", () => {
  const t = termineAus(ICAL, ICS, VON, BIS).filter((x) => x.titel.startsWith("Vorlesung"));
  const starts = t.map((x) => x.start);
  assert.deepEqual(starts, [
    // 30.11. abgesagt, 7.12. per EXDATE weg
    "2026-12-14T13:00:00.000Z", // verlegt auf 14 Uhr
    "2026-12-21T08:00:00.000Z",
  ]);
  assert.equal(t[0].titel, "Vorlesung Forstökologie (verlegt)");
  assert.equal(new Set(t.map((x) => x.id)).size, t.length, "keine doppelten Kennungen");
});

test("Google-iCal: ganztaegig, mehrtaegig und jaehrlich", () => {
  const t = termineAus(ICAL, ICS, VON, BIS);
  const u = t.find((x) => x.titel === "Wochenende Brandenburg");
  assert.deepEqual([u.ganztag, u.start, u.ende], [true, "2026-12-05", "2026-12-08"]);
  const g = t.find((x) => x.titel === "Geburtstag Oma");
  assert.deepEqual([g.start, g.ende], ["2026-11-24", "2026-11-25"], "gestern zaehlt noch (Ortszeit schneidet die App)");
});

test("Google-iCal: nichts ausserhalb des Fensters", () => {
  const t = termineAus(ICAL, ICS, VON, BIS);
  assert.equal(t.some((x) => x.titel === "Lange her" || x.titel === "Zu weit weg"), false);
  const sortiert = [...t].sort((a, b) => (a.start < b.start ? -1 : 1));
  assert.deepEqual(t, sortiert);
});

test("Google-iCal: endlose taegliche Serie seit Jahren bleibt schnell und begrenzt", () => {
  const ics = ICS.replace("END:VCALENDAR", [
    "BEGIN:VEVENT", "DTSTART:20100101T060000Z", "DTEND:20100101T061500Z",
    "RRULE:FREQ=DAILY", "UID:taeglich@google.com", "SUMMARY:Gassi", "DTSTAMP:20261125T120000Z", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n"));
  const vorher = Date.now();
  const t = termineAus(ICAL, ics, VON, BIS).filter((x) => x.titel === "Gassi");
  assert.equal(t.length, 31);
  assert.ok(Date.now() - vorher < 3000);
});

test("Google-iCal: kaputte Datei wirft, statt Unsinn zu liefern", () => {
  assert.throws(() => termineAus(ICAL, "das ist kein kalender", VON, BIS));
});
