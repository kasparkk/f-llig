// Web Push ohne Bibliothek: Verschluesselung nach RFC 8291 (aes128gcm) und
// Absender-Ausweis nach RFC 8292 (VAPID). Nur WebCrypto, deshalb laeuft
// dieselbe Datei in der Edge Function (Deno) und im Test (Node).

const text = new TextEncoder();

export function b64urlZuBytes(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const roh = atob(b64 + "===".slice((b64.length + 3) % 4));
  const out = new Uint8Array(roh.length);
  for (let i = 0; i < roh.length; i++) out[i] = roh.charCodeAt(i);
  return out;
}

export function bytesZuB64url(b) {
  let s = "";
  const a = b instanceof Uint8Array ? b : new Uint8Array(b);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function verbinden(...teile) {
  const n = teile.reduce((s, t) => s + t.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const t of teile) { out.set(t, o); o += t.length; }
  return out;
}

// HKDF mit Extract und Expand in einem Schritt.
async function hkdf(salt, ikm, info, laenge) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, laenge * 8);
  return new Uint8Array(bits);
}

// Verschluesselt den Inhalt fuer genau dieses Abo (ein Datensatz, kein Polster).
export async function verschluesseln(inhalt, p256dh, authGeheim) {
  const uaPublic = b64urlZuBytes(p256dh);
  const auth = b64urlZuBytes(authGeheim);
  if (uaPublic.length !== 65 || auth.length !== 16) throw new Error("Abo-Schluessel ungueltig");

  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));

  const ikm = await hkdf(auth, ecdh, verbinden(text.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, text.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, text.encode("Content-Encoding: nonce\0"), 12);

  const klar = verbinden(typeof inhalt === "string" ? text.encode(inhalt) : inhalt, new Uint8Array([2]));
  const schluessel = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const geheim = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, schluessel, klar));

  const rs = 4096;
  const kopf = new Uint8Array(16 + 4 + 1 + 65);
  kopf.set(salt, 0);
  new DataView(kopf.buffer).setUint32(16, rs);
  kopf[20] = 65;
  kopf.set(asPublic, 21);
  return verbinden(kopf, geheim);
}

// Signierter Ausweis fuer den Push-Dienst (gilt 12 Stunden).
export async function vapidKopf(endpoint, vapid, jetztMs) {
  const pub = b64urlZuBytes(vapid.publicKey);
  const jwk = {
    kty: "EC", crv: "P-256", ext: true,
    x: bytesZuB64url(pub.slice(1, 33)), y: bytesZuB64url(pub.slice(33, 65)), d: vapid.privateKey,
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const kopf = bytesZuB64url(text.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const jetzt = Math.floor((jetztMs ?? Date.now()) / 1000);
  const inhalt = bytesZuB64url(text.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: jetzt + 12 * 3600, sub: vapid.subject,
  })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, text.encode(kopf + "." + inhalt));
  return "vapid t=" + kopf + "." + inhalt + "." + bytesZuB64url(sig) + ", k=" + vapid.publicKey;
}

// Nur echte Push-Dienste anschreiben, sonst waere das ein offener Proxy.
export function endpointOk(s) {
  if (typeof s !== "string" || s.length > 1000) return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  if (u.protocol !== "https:" || u.port) return false;
  return /(^|\.)(googleapis\.com|mozilla\.com|windows\.com|push\.apple\.com)$/.test(u.hostname);
}

// Schickt eine Meldung. Antwort: { status } des Push-Dienstes.
// 404/410 heisst: Abo gibt es nicht mehr.
export async function sende(abo, inhalt, vapid, holen = fetch, ttlSek = 6 * 3600) {
  if (!endpointOk(abo.endpoint)) return { status: 400 };
  const koerper = await verschluesseln(inhalt, abo.p256dh, abo.auth);
  const r = await holen(abo.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidKopf(abo.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSek),
      Urgency: "normal",
    },
    body: koerper,
  });
  try { await r.text(); } catch { /* egal */ }
  return { status: r.status };
}
