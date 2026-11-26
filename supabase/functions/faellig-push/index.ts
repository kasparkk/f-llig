// Edge Function "faellig-push": verschickt die Erinnerungen von faellig.
//
// POST { aktion: "senden" }  mit Kopfzeile x-faellig-cron: <Geheimnis aus dem Vault>
//   kommt alle 15 Minuten von pg_cron. Schickt allen Geraeten, bei denen die
//   eingestellte Uhrzeit erreicht ist, die Meldungen aus dem Plan des Tages.
// POST { aktion: "test", endpoint }  mit Authorization: Bearer <Zugang des Kontos>
//   schickt sofort eine Probemeldung an dieses eine Geraet des Kontos.
//
// Was gemeldet wird, rechnet die App aus (Tabelle faellig_push_plan); hier
// wird nur verschickt. Schluessel liegen im Vault.

import { sende } from "./webpush.js";

const KOPF = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const BASIS = Deno.env.get("SUPABASE_URL")!;
const DIENST = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function antwort(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...KOPF, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function db(pfad: string, methode = "GET", koerper?: unknown) {
  const r = await fetch(BASIS + pfad, {
    method: methode,
    headers: { apikey: DIENST, Authorization: "Bearer " + DIENST, "Content-Type": "application/json" },
    body: koerper === undefined ? undefined : JSON.stringify(koerper),
  });
  const t = await r.text();
  if (!r.ok) throw new Error("Datenbank " + r.status + ": " + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}

let geheimCache: Record<string, string> | null = null;
async function geheimnisse() {
  if (!geheimCache) geheimCache = (await db("/rest/v1/rpc/faellig_push_geheimnisse", "POST", {})) || {};
  return geheimCache!;
}

async function vapid() {
  const g = await geheimnisse();
  if (!g.faellig_push_vapid_privat || !g.faellig_push_vapid_public) throw new Error("VAPID-Schluessel fehlen im Vault");
  return { publicKey: g.faellig_push_vapid_public, privateKey: g.faellig_push_vapid_privat,
           subject: "https://faellig.netlify.app" };
}

async function kontoVon(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || "";
  const apikey = req.headers.get("apikey") || "";
  if (!/^Bearer .+/.test(auth) || !apikey) return null;
  const r = await fetch(BASIS + "/auth/v1/user", { headers: { Authorization: auth, apikey } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && typeof j.id === "string" ? j.id : null;
}

type Zeile = { abo_id: string; endpoint: string; p256dh: string; auth: string; tag: string; meldungen: unknown[] };

async function allesSenden() {
  const v = await vapid();
  const zeilen: Zeile[] = await db("/rest/v1/rpc/faellig_push_faellig", "POST", {});
  let geschickt = 0, weg = 0, fehler = 0;
  for (const z of zeilen) {
    let ok = true, abgelaufen = false;
    for (const m of (z.meldungen || []).slice(0, 12)) {
      let r;
      try { r = await sende(z, JSON.stringify(m), v); } catch { r = { status: 0 }; }
      if (r.status === 404 || r.status === 410) { abgelaufen = true; break; }
      if (r.status < 200 || r.status >= 300) ok = false;
    }
    await db("/rest/v1/rpc/faellig_push_erledigt", "POST", { abo: z.abo_id, tag: z.tag, ok, weg: abgelaufen });
    if (abgelaufen) weg++; else if (ok) geschickt++; else fehler++;
  }
  return { geraete: zeilen.length, geschickt, weg, fehler };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: KOPF });
  if (req.method !== "POST") return antwort(405, { error: "Nur POST." });
  const body = await req.json().catch(() => null);

  try {
    if (body && body.aktion === "senden") {
      const g = await geheimnisse();
      const kommt = req.headers.get("x-faellig-cron") || "";
      if (!g.faellig_push_cron || kommt !== g.faellig_push_cron) return antwort(401, { error: "Nein." });
      return antwort(200, await allesSenden());
    }

    if (body && body.aktion === "test") {
      const uid = await kontoVon(req);
      if (!uid) return antwort(401, { error: "Nicht angemeldet." });
      if (typeof body.endpoint !== "string") return antwort(400, { error: "Geraet fehlt." });
      const abos = await db("/rest/v1/faellig_push_abo?select=id,endpoint,p256dh,auth&user_id=eq." + uid +
        "&endpoint=eq." + encodeURIComponent(body.endpoint));
      const abo = abos && abos[0];
      if (!abo) return antwort(404, { error: "Dieses Gerät ist noch nicht angemeldet. Schalte die Erinnerungen hier aus und wieder ein." });
      const r = await sende(abo, JSON.stringify({
        titel: "Fällig: Test", text: "So sehen deine Erinnerungen aus. Tippen öffnet Fällig.", tag: "faellig-test",
      }), await vapid());
      if (r.status === 404 || r.status === 410) {
        await db("/rest/v1/rpc/faellig_push_erledigt", "POST", { abo: abo.id, tag: null, ok: false, weg: true });
        return antwort(410, { error: "Das Push-Abo dieses Geräts ist abgelaufen. Schalte die Erinnerungen hier aus und wieder ein." });
      }
      if (r.status < 200 || r.status >= 300) return antwort(502, { error: "Der Push-Dienst antwortete mit Fehler " + r.status + "." });
      return antwort(200, { ok: true });
    }

    return antwort(400, { error: "Unbekannte Aktion." });
  } catch (e) {
    console.error(String(e));
    return antwort(500, { error: "Erinnerungsdienst hatte einen Fehler." });
  }
});
