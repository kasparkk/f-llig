// Macht aus einer iCal-Datei (Google "Privatadresse im iCal-Format") eine
// schlichte Terminliste fuer ein Zeitfenster. Wiederholungen werden hier
// aufgeloest, samt Ausnahmen (verschobene oder abgesagte Einzeltermine) und
// EXDATE. ICAL (ical.js) wird hereingereicht, damit dieselbe Datei in der
// Edge Function (Deno, npm:ical.js) und im Test (Node) laeuft.
//
// Ergebnis je Termin:
//   { id, titel, ort, ganztag, start, ende }
//   ganztag: start/ende als "JJJJ-MM-TT", ende ausschliesslich (wie in iCal)
//   sonst:   start/ende als ISO-Zeit in UTC; die App rechnet in Ortszeit um

const MAX_SCHRITTE = 20000; // je Serie, gegen endlose Regeln
const MAX_TERMINE = 1000;

function datumPlusTage(s, n) {
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}

function text(wert, max) {
  if (wert == null) return "";
  const s = String(wert).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function termineAus(ICAL, ics, vonMs, bisMs) {
  const kal = new ICAL.Component(ICAL.parse(ics));
  for (const tz of kal.getAllSubcomponents("vtimezone")) {
    try { ICAL.TimezoneService.register(tz); } catch (_) { /* kaputte Zone: dann eben UTC */ }
  }

  const vonTag = new Date(vonMs).toISOString().slice(0, 10);
  const bisTag = new Date(bisMs).toISOString().slice(0, 10);
  const raus = [];
  const gesehen = new Set();

  function abgesagt(ev) {
    const s = ev.component.getFirstPropertyValue("status");
    return s && String(s).toUpperCase() === "CANCELLED";
  }

  function nehmen(ev, start, ende, id) {
    if (gesehen.has(id)) return;
    let t;
    if (start.isDate) {
      const s = start.toString().slice(0, 10);
      let e = ende ? ende.toString().slice(0, 10) : s;
      if (e <= s) e = datumPlusTage(s, 1);
      // ganze Tage: grosszuegig vergleichen, die App schneidet nach Ortszeit zu
      if (s > bisTag) return;
      if (e <= datumPlusTage(vonTag, -1)) return;
      t = { ganztag: true, start: s, ende: e };
    } else {
      const s = start.toJSDate().getTime();
      let e = ende ? ende.toJSDate().getTime() : s;
      if (e < s) e = s;
      if (s >= bisMs) return;
      if (e <= vonMs) return;
      t = { ganztag: false, start: new Date(s).toISOString(), ende: new Date(e).toISOString() };
    }
    gesehen.add(id);
    if (abgesagt(ev)) return;
    raus.push({
      id,
      titel: text(ev.summary, 200) || "(ohne Titel)",
      ort: text(ev.location, 200),
      ...t,
    });
  }

  // Gleiche Kennung fuer einen Termin, egal ob in UTC oder Ortszeit notiert.
  function idVon(t) {
    return t.isDate ? t.toString() : t.clone().convertToZone(ICAL.Timezone.utcTimezone).toString();
  }

  const vevents = kal.getAllSubcomponents("vevent");
  const serien = new Map();
  const ausnahmen = [];
  for (const ve of vevents) {
    if (ve.hasProperty("recurrence-id")) ausnahmen.push(ve);
    else {
      const uid = ve.getFirstPropertyValue("uid") || "ohne-uid-" + serien.size;
      serien.set(uid, ve);
    }
  }

  const serienEvents = new Map();
  for (const [uid, ve] of serien) {
    const ev = new ICAL.Event(ve);
    serienEvents.set(uid, ev);
  }
  for (const ve of ausnahmen) {
    const ev = serienEvents.get(ve.getFirstPropertyValue("uid"));
    if (ev && ev.isRecurring()) ev.relateException(ve);
  }

  for (const [uid, ev] of serienEvents) {
    if (raus.length >= MAX_TERMINE) break;
    try {
      if (!ev.startDate) continue;
      if (!ev.isRecurring()) {
        nehmen(ev, ev.startDate, ev.endDate, uid);
        continue;
      }
      const it = ev.iterator();
      let n = 0;
      let next;
      while ((next = it.next()) && n++ < MAX_SCHRITTE && raus.length < MAX_TERMINE) {
        // Originaltermine laufen aufsteigend; ab hinter dem Fenster ist Schluss.
        // Hinein verschobene Ausnahmen holt die Schleife unten.
        if (next.isDate ? next.toString().slice(0, 10) > bisTag : next.toJSDate().getTime() >= bisMs) break;
        const d = ev.getOccurrenceDetails(next);
        nehmen(d.item, d.startDate, d.endDate, uid + "|" + idVon(next));
      }
    } catch (_) {
      // Eine kaputte Serie soll nicht den ganzen Kalender kosten.
    }
  }

  // Ausnahmen, deren Originaltermin ausserhalb des Fensters liegt, die aber
  // hinein verschoben wurden; und Ausnahmen ohne Serie.
  for (const ve of ausnahmen) {
    if (raus.length >= MAX_TERMINE) break;
    try {
      const ev = new ICAL.Event(ve);
      const id = (ve.getFirstPropertyValue("uid") || "ohne-uid") + "|" + idVon(ev.recurrenceId);
      nehmen(ev, ev.startDate, ev.endDate, id);
    } catch (_) { /* weglassen */ }
  }

  raus.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return raus;
}
