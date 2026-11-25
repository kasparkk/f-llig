// Edge Function "faellig-google": holt die geheime iCal-Adresse des
// Google-Kalenders ab und gibt der App die Termine der naechsten Wochen als
// JSON zurueck. Noetig, weil der Browser Google nicht direkt fragen darf (CORS),
// und damit Wiederholungen nicht in der App aufgeloest werden muessen.
//
// Aufruf: POST /functions/v1/faellig-google  { url, tage? }
//   mit Authorization: Bearer <Zugang des angemeldeten Kontos>
// Die Adresse wird nicht gespeichert und nicht geloggt.

import ICAL from "npm:ical.js@2.2.1";
import { termineAus } from "./termine.js";

const KOPF = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BYTES = 5 * 1024 * 1024;
const TAG = 86_400_000;

function antwort(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...KOPF, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Nur Googles iCal-Adressen, sonst waere das ein offener Proxy.
export function adresseOk(s: unknown): URL | null {
  if (typeof s !== "string" || s.length > 2000) return null;
  let u: URL;
  try { u = new URL(s.trim()); } catch { return null; }
  if (u.protocol !== "https:" || u.hostname !== "calendar.google.com" || u.port) return null;
  if (!/^\/calendar\/ical\/[^/]+\/[^/]+\/basic\.ics$/.test(u.pathname)) return null;
  return u;
}

async function angemeldet(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") || "";
  const apikey = req.headers.get("apikey") || "";
  if (!/^Bearer .+/.test(auth) || !apikey) return false;
  const r = await fetch(Deno.env.get("SUPABASE_URL") + "/auth/v1/user", {
    headers: { Authorization: auth, apikey },
  });
  if (!r.ok) return false;
  const j = await r.json().catch(() => null);
  return !!(j && j.id);
}

async function textHolen(u: URL): Promise<{ status: number; text?: string }> {
  const ab = new AbortController();
  const uhr = setTimeout(() => ab.abort(), 15_000);
  try {
    const r = await fetch(u, { signal: ab.signal, headers: { Accept: "text/calendar" } });
    if (!r.ok || !r.body) return { status: r.status };
    const leser = r.body.getReader();
    const teile: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await leser.read();
      if (done) break;
      n += value.length;
      if (n > MAX_BYTES) { ab.abort(); return { status: 413 }; }
      teile.push(value);
    }
    const alles = new Uint8Array(n);
    let o = 0;
    for (const t of teile) { alles.set(t, o); o += t.length; }
    return { status: 200, text: new TextDecoder().decode(alles) };
  } finally {
    clearTimeout(uhr);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: KOPF });
  if (req.method !== "POST") return antwort(405, { error: "Nur POST." });

  if (!(await angemeldet(req))) return antwort(401, { error: "Nicht angemeldet." });

  const body = await req.json().catch(() => null);
  const u = adresseOk(body && body.url);
  if (!u) return antwort(400, { error: "Das ist keine geheime iCal-Adresse von Google Kalender." });
  const tage = Math.min(Math.max(Number(body.tage) || 31, 1), 92);

  let geholt;
  try { geholt = await textHolen(u); } catch {
    return antwort(502, { error: "Google hat nicht geantwortet." });
  }
  if (geholt.status === 404 || geholt.status === 403 || geholt.status === 401) {
    return antwort(404, { error: "Google kennt diese Adresse nicht (mehr). Wurde sie zurückgesetzt?" });
  }
  if (geholt.status === 413) return antwort(502, { error: "Der Kalender ist zu groß." });
  if (geholt.status !== 200 || !geholt.text) return antwort(502, { error: "Google antwortete mit Fehler " + geholt.status + "." });
  if (!/BEGIN:VCALENDAR/.test(geholt.text.slice(0, 2000))) return antwort(502, { error: "Google lieferte keinen Kalender." });

  const jetzt = Date.now();
  try {
    const termine = termineAus(ICAL, geholt.text, jetzt - TAG, jetzt + tage * TAG);
    return antwort(200, { termine, am: jetzt });
  } catch {
    return antwort(502, { error: "Der Kalender ließ sich nicht lesen." });
  }
});
