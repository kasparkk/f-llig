// Test fuer das Push-Modul der Edge Function faellig-push
// (supabase/functions/faellig-push/webpush.js). Gegenprobe mit http_ece,
// der Referenz-Umsetzung von Mozilla, und mit node:crypto fuer den VAPID-Ausweis.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import ece from "http_ece";
import { verschluesseln, vapidKopf, sende, endpointOk, b64urlZuBytes, bytesZuB64url }
  from "../supabase/functions/faellig-push/webpush.js";

function geraetSchluessel() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") };
}

function vapidPaar() {
  const k = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = k.privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, "base64url"), Buffer.from(j.y, "base64url")]);
  return { publicKey: pub.toString("base64url"), privateKey: j.d, subject: "https://faellig.netlify.app", node: k.publicKey };
}

test("Verschluesselte Meldung laesst sich mit der Referenz entschluesseln", async () => {
  const g = geraetSchluessel();
  const inhalt = JSON.stringify({ titel: "2 überfällig · 1 heute", text: "Überfällig: Miete, TÜV\nHeute: Müll 🗑" });
  const koerper = await verschluesseln(inhalt, g.p256dh, g.auth);
  const klar = ece.decrypt(Buffer.from(koerper), {
    version: "aes128gcm", privateKey: g.ecdh, authSecret: g.auth,
  });
  assert.equal(klar.toString("utf8"), inhalt);
});

test("Jede Meldung ist anders verschluesselt", async () => {
  const g = geraetSchluessel();
  const a = await verschluesseln("x", g.p256dh, g.auth);
  const b = await verschluesseln("x", g.p256dh, g.auth);
  assert.notDeepEqual(Buffer.from(a), Buffer.from(b));
});

test("Kaputte Abo-Schluessel werden abgelehnt", async () => {
  await assert.rejects(verschluesseln("x", "abc", "def"));
});

test("VAPID-Ausweis ist gueltig signiert und fuer den richtigen Dienst", async () => {
  const v = vapidPaar();
  const jetzt = Date.UTC(2026, 10, 26, 12);
  const kopf = await vapidKopf("https://fcm.googleapis.com/fcm/send/abc:def", v, jetzt);
  const m = kopf.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m, kopf);
  assert.equal(m[4], v.publicKey);
  const claims = JSON.parse(Buffer.from(m[2], "base64url").toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, "https://faellig.netlify.app");
  assert.equal(claims.exp, jetzt / 1000 + 12 * 3600);
  const ok = crypto.verify("sha256", Buffer.from(m[1] + "." + m[2]),
    { key: v.node, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url"));
  assert.ok(ok, "Signatur muss stimmen");
});

test("Senden: richtige Kopfzeilen, Inhalt kommt an, fremde Adressen nie", async () => {
  const v = vapidPaar();
  const g = geraetSchluessel();
  const abo = { endpoint: "https://fcm.googleapis.com/fcm/send/xyz", p256dh: g.p256dh, auth: g.auth };
  let anfrage = null;
  const r = await sende(abo, '{"titel":"Test"}', v, async (url, init) => {
    anfrage = { url, init };
    return { status: 201, text: async () => "" };
  });
  assert.equal(r.status, 201);
  assert.equal(anfrage.url, abo.endpoint);
  assert.equal(anfrage.init.headers["Content-Encoding"], "aes128gcm");
  assert.match(anfrage.init.headers.Authorization, /^vapid t=/);
  assert.equal(anfrage.init.headers.TTL, String(6 * 3600));
  const klar = ece.decrypt(Buffer.from(anfrage.init.body), { version: "aes128gcm", privateKey: g.ecdh, authSecret: g.auth });
  assert.equal(klar.toString(), '{"titel":"Test"}');

  let gefragt = false;
  const r2 = await sende({ ...abo, endpoint: "https://example.com/push" }, "x", v, async () => { gefragt = true; });
  assert.equal(r2.status, 400);
  assert.equal(gefragt, false);
});

test("Nur bekannte Push-Dienste", () => {
  assert.ok(endpointOk("https://fcm.googleapis.com/fcm/send/abc"));
  assert.ok(endpointOk("https://updates.push.services.mozilla.com/wpush/v2/abc"));
  assert.ok(endpointOk("https://web.push.apple.com/abc"));
  assert.ok(!endpointOk("https://googleapis.com.evil.de/x"));
  assert.ok(!endpointOk("http://fcm.googleapis.com/x"));
  assert.ok(!endpointOk("https://fcm.googleapis.com:8443/x"));
  assert.ok(!endpointOk("https://xrrcuapiugwgqxxatkiq.supabase.co/rest/v1/"));
});

test("base64url hin und zurueck", () => {
  const b = crypto.randomBytes(65);
  assert.deepEqual(Buffer.from(b64urlZuBytes(bytesZuB64url(b))), b);
});
