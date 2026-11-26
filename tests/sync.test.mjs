// Headless-Test fuer den Geraete-Sync von faellig.
//
// Laedt die echte index.html in jsdom, zweimal (= zwei Geraete), und haengt
// beide an einen nachgebauten Supabase-Server im Speicher. Der Nachbau macht
// dasselbe wie die echte Datenbank: faellig_daten mit "neuester Stand gewinnt",
// faellig_hochladen, faellig_jetzt, Token-Erneuerung.
//
// Start: npm test

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";

const HTML = readFileSync(process.env.FAELLIG_HTML || new URL("../index.html", import.meta.url), "utf8");
const BASIS = "https://xrrcuapiugwgqxxatkiq.supabase.co";
const META_KEY = "faellig-sync-v1";
const NOTIZEN_KEY = "faellig-notizen-v1";
const AUFGABEN_KEY = "faellig-aufgaben-v1";
const VORLAGEN_KEY = "faellig-vorlagen-v1";
const ENT_KEY = "faellig-entscheidungen-v1";
const EINST_KEY = "faellig-einstellungen-v1";
const TAG = 86_400_000;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- Nachgebauter Server ---------------- */

function b64url(o) {
  return Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

class FakeSupabase {
  constructor() {
    this.zeilen = new Map(); // uid|sammlung|id -> Zeile
    this.zugaenge = new Map(); // access -> { uid, gueltig }
    this.erneuerer = new Map(); // refresh -> uid
    this.zaehler = 0;
    this.serverTick = 0;
    this.laufend = 0;
    this.haengen = null; // Pfad-Teil: Anfragen dorthin kommen nie zurueck
    this.offline = false;
    this.log = [];
    this.dateien = new Map(); // "eimer/pfad" -> { text, typ }
    this.eimer = new Set(["faellig-kalender"]);
  }

  serverAm() {
    // streng steigend, damit der Cursor der App sauber weiterlaeuft
    this.serverTick = Math.max(this.serverTick + 1, Date.now());
    return new Date(this.serverTick).toISOString();
  }

  sitzung(uid, email) {
    const n = ++this.zaehler;
    const access = `${b64url({ alg: "none" })}.${b64url({ sub: uid, email })}.sig${n}`;
    const refresh = `refresh-${uid}-${n}`;
    this.zugaenge.set(access, { uid, gueltig: true });
    this.erneuerer.set(refresh, uid);
    return { access_token: access, refresh_token: refresh, expires_in: 3600, user: { id: uid, email } };
  }

  alleZugaengeAblaufen() { for (const z of this.zugaenge.values()) z.gueltig = false; }
  alleErneuererUngueltig() { this.erneuerer.clear(); }

  daten(uid, sammlung, id) {
    return this.zeilen.get(`${uid}|${sammlung}|${id}`);
  }

  fetchFuer() {
    return async (url, init = {}) => {
      if (this.offline) throw new TypeError("Failed to fetch");
      const u = new URL(url);
      if (this.haengen && u.pathname.includes(this.haengen)) {
        return new Promise(() => {});
      }
      this.laufend++;
      try {
        await pause(2);
        const r = this.antwort(u, init);
        this.log.push(`${init.method || "GET"} ${u.pathname} ${r.status}`);
        const text = r.body === undefined ? "" : r.roh ? r.body : JSON.stringify(r.body);
        return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => text };
      } finally {
        this.laufend--;
      }
    };
  }

  uidAus(init) {
    const a = (init.headers && init.headers.Authorization) || "";
    const z = this.zugaenge.get(a.replace(/^Bearer /, ""));
    if (!z) return { status: 401 };
    if (!z.gueltig) return { status: 401 };
    return { uid: z.uid };
  }

  // Storage wie bei Supabase: /object/public/... liest jeder, Schreiben und
  // Loeschen nur im Ordner mit der eigenen Konto-ID (so die Regeln in der Migration).
  speicherAntwort(u, init, methode) {
    const offen = u.pathname.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (offen && methode === "GET") {
      const d = this.dateien.get(`${offen[1]}/${offen[2]}`);
      return d ? { status: 200, body: d.text, roh: true } : { status: 400, body: { error: "not_found" } };
    }
    const m = u.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (!m) return null;
    const wer = this.uidAus(init);
    if (!wer.uid) return { status: 401, body: { message: "JWT expired" } };
    const [, eimer, pfad] = m;
    if (!this.eimer.has(eimer)) return { status: 404, body: { statusCode: "404", error: "Bucket not found", message: "Bucket not found" } };
    if (pfad.split("/")[0] !== wer.uid) return { status: 403, body: { message: "new row violates row-level security policy" } };
    const k = `${eimer}/${pfad}`;
    if (methode === "POST") {
      if (this.dateien.has(k) && init.headers["x-upsert"] !== "true") return { status: 400, body: { error: "Duplicate" } };
      this.dateien.set(k, { text: init.body, typ: init.headers["Content-Type"] });
      return { status: 200, body: { Key: k } };
    }
    if (methode === "DELETE") {
      this.dateien.delete(k);
      return { status: 200, body: { message: "Successfully deleted" } };
    }
    return { status: 405, body: {} };
  }

  antwort(u, init) {
    const methode = init.method || "GET";
    if (u.pathname.startsWith("/storage/")) return this.speicherAntwort(u, init, methode);
    const koerper = init.body ? JSON.parse(init.body) : null;

    if (u.pathname === "/auth/v1/token" && u.searchParams.get("grant_type") === "refresh_token") {
      const uid = this.erneuerer.get(koerper.refresh_token);
      if (!uid) return { status: 400, body: { error: "invalid_grant", error_description: "Invalid Refresh Token" } };
      this.erneuerer.delete(koerper.refresh_token);
      return { status: 200, body: this.sitzung(uid, `${uid}@test`) };
    }
    if (u.pathname === "/auth/v1/logout") return { status: 204 };

    const wer = this.uidAus(init);
    if (!wer.uid) return { status: 401, body: { message: "JWT expired" } };
    const uid = wer.uid;

    if (u.pathname === "/rest/v1/rpc/faellig_jetzt" && methode === "POST") {
      return { status: 200, body: Date.now() };
    }

    if (u.pathname === "/rest/v1/rpc/faellig_hochladen" && methode === "POST") {
      const zeilen = koerper.zeilen;
      assert.ok(Array.isArray(zeilen) && zeilen.length <= 500);
      let n = 0;
      for (const z of zeilen) {
        const k = `${uid}|${z.sammlung}|${z.eintrag_id}`;
        const alt = this.zeilen.get(k);
        const neu = {
          sammlung: z.sammlung, eintrag_id: z.eintrag_id,
          daten: z.geloescht ? null : z.daten,
          geaendert_am: Number(z.geaendert_am), geloescht: !!z.geloescht,
        };
        if (!alt || alt.geaendert_am < neu.geaendert_am) {
          neu.server_am = this.serverAm();
          this.zeilen.set(k, neu);
          n++;
        }
      }
      return { status: 200, body: n };
    }

    if (u.pathname === "/rest/v1/rpc/faellig_aufraeumen" && methode === "POST") {
      // wie die echte Funktion: nur eigene Grabsteine, aelter als `tage`
      const grenze = Date.now() - Number(koerper.tage) * TAG;
      let n = 0;
      for (const [k, z] of this.zeilen) {
        if (k.startsWith(uid + "|") && z.geloescht && z.geaendert_am < grenze) { this.zeilen.delete(k); n++; }
      }
      return { status: 200, body: n };
    }

    if (u.pathname === "/rest/v1/faellig_daten" && methode === "GET") {
      let liste = [...this.zeilen.entries()]
        .filter(([k]) => k.startsWith(uid + "|"))
        .map(([, z]) => z);
      const gt = u.searchParams.get("server_am");
      if (gt) {
        const ab = Date.parse(gt.replace(/^gt\./, ""));
        liste = liste.filter((z) => Date.parse(z.server_am) > ab);
      }
      liste.sort((a, b) => a.server_am.localeCompare(b.server_am) ||
        a.sammlung.localeCompare(b.sammlung) || a.eintrag_id.localeCompare(b.eintrag_id));
      const off = Number(u.searchParams.get("offset") || 0);
      const lim = Number(u.searchParams.get("limit") || 1000);
      return { status: 200, body: liste.slice(off, off + lim).map((z) => JSON.parse(JSON.stringify(z))) };
    }

    if (u.pathname === "/functions/v1/faellig-google" && methode === "POST") {
      this.googleAbrufe = (this.googleAbrufe || 0) + 1;
      if (this.googleAntwort) return this.googleAntwort;
      if (!/^https:\/\/calendar\.google\.com\/calendar\/ical\/.+\/basic\.ics$/.test(koerper.url)) {
        return { status: 400, body: { error: "keine Google-Adresse" } };
      }
      return { status: 200, body: { termine: this.googleTermine || [], am: Date.now() } };
    }

    if (u.pathname === "/rest/v1/rpc/faellig_push_plan_setzen" && methode === "POST") {
      assert.ok(Array.isArray(koerper.plan) && koerper.plan.length <= 120);
      this.pushPlaene = this.pushPlaene || new Map();
      this.pushPlaene.set(uid, koerper.plan);
      this.pushPlanUploads = (this.pushPlanUploads || 0) + 1;
      return { status: 200, body: koerper.plan.length };
    }
    if (u.pathname === "/rest/v1/rpc/faellig_push_anmelden" && methode === "POST") {
      assert.match(koerper.adresse, /^https:\/\//);
      assert.ok(koerper.schluessel && koerper.geheim);
      this.pushAbos = this.pushAbos || new Map();
      this.pushAbos.set(koerper.adresse, { uid, zone: koerper.zone, name: koerper.name });
      return { status: 204 };
    }
    if (u.pathname === "/rest/v1/faellig_push_abo" && methode === "DELETE") {
      const ep = (u.searchParams.get("endpoint") || "").replace(/^eq\./, "");
      const a = this.pushAbos && this.pushAbos.get(ep);
      if (a && a.uid === uid) this.pushAbos.delete(ep);
      return { status: 204 };
    }
    if (u.pathname === "/functions/v1/faellig-push" && methode === "POST") {
      this.pushTests = this.pushTests || [];
      this.pushTests.push(koerper);
      const a = this.pushAbos && this.pushAbos.get(koerper.endpoint);
      if (!a || a.uid !== uid) return { status: 404, body: { error: "Dieses Gerät ist noch nicht angemeldet." } };
      return { status: 200, body: { ok: true } };
    }

    return { status: 404, body: { message: "unbekannt " + u.pathname } };
  }
}

/* ---------------- Ein Geraet ---------------- */

// Schlaegt ein Test fehl, bleiben Fenster mit laufenden Timern offen. Aufraeumen.
const offeneFenster = new Set();
afterEach(() => { for (const w of offeneFenster) w.close(); offeneFenster.clear(); });

class Geraet {
  constructor(name, server, { uhrVersatzMs = 0, push = null } = {}) {
    this.name = name;
    // push: { erlaubnis: "default" | "granted" | "denied", antwort: was requestPermission liefert }
    this.push = push;
    this.pushAbo = null; // Abo beim Browser, ueberlebt das Schliessen
    this.server = server;
    this.uhrVersatzMs = uhrVersatzMs;
    this.speicher = {}; // ueberlebt das Schliessen der App
    this.dom = null;
    this.fehler = [];
  }

  // Oeffnet die App. Mit sitzung: als waere der Anmeldelink angetippt worden.
  async oeffnen({ sitzung } = {}) {
    const vc = new VirtualConsole();
    vc.on("jsdomError", (e) => this.fehler.push(String(e && (e.stack || e.message || e))));
    const hash = sitzung
      ? "#" + new URLSearchParams({
        access_token: sitzung.access_token, refresh_token: sitzung.refresh_token,
        expires_in: String(sitzung.expires_in), token_type: "bearer", type: "magiclink",
      }).toString()
      : "";
    const geraet = this;
    this.dom = new JSDOM(HTML, {
      url: "https://faellig.netlify.app/" + hash,
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole: vc,
      beforeParse(win) {
        win.localStorage.clear();
        for (const [k, v] of Object.entries(geraet.speicher)) win.localStorage.setItem(k, v);
        win.fetch = geraet.server.fetchFuer();
        const echt = win.Date.now.bind(win.Date);
        win.Date.now = () => echt() + geraet.uhrVersatzMs;
        win.confirm = () => true;
        win.alert = () => {};
        win.scrollTo = () => {};
        win.HTMLElement.prototype.scrollIntoView = function () {};
        if (geraet.push) pushNachbauen(win, geraet);
        if (!win.matchMedia) {
          win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {},
            addEventListener() {}, removeEventListener() {} });
        }
      },
    });
    offeneFenster.add(this.dom.window);
    await this.ruhig();
    return this;
  }

  get win() { return this.dom.window; }

  // Wartet, bis kein Sync mehr laeuft und der Server eine Weile nichts mehr hoert.
  async ruhig(maxMs = 8000) {
    const ende = Date.now() + maxMs;
    let stillSeit = null;
    while (Date.now() < ende) {
      await pause(25);
      const z = this.zustand();
      const still = z !== "laeuft" && this.server.laufend === 0;
      if (!still) { stillSeit = null; continue; }
      stillSeit = stillSeit || Date.now();
      if (Date.now() - stillSeit > 1800) return; // Sync startet mit kleiner Verzoegerung
    }
    throw new Error(`${this.name}: Sync wurde nicht ruhig (Zustand ${this.zustand()})`);
  }

  zustand() { return this.win.document.getElementById("syncKopf").dataset.zustand; }
  kopfText() { return this.win.document.getElementById("syncKopfText").textContent; }

  meta() { return JSON.parse(this.win.localStorage.getItem(META_KEY) || "{}"); }

  notizen() { return JSON.parse(this.win.localStorage.getItem(NOTIZEN_KEY) || "[]"); }
  notiz(id) { return this.notizen().find((n) => n.id === id); }

  async syncen() {
    this.win.document.getElementById("syncJetzt").click();
    await this.ruhig();
  }

  // Sicherung uebertragen wie per Hand: Text einfuegen, Knopf tippen.
  async importieren(paket, art = "dazu") {
    const d = this.win.document;
    const feld = d.getElementById("impText");
    feld.value = typeof paket === "string" ? paket : JSON.stringify(paket);
    feld.dispatchEvent(new this.win.Event("input"));
    const knopf = d.getElementById(art === "dazu" ? "impMerge" : "impReplace");
    assert.equal(knopf.disabled, false, `${this.name}: Sicherung wurde nicht erkannt: ${d.getElementById("impMsg").textContent}`);
    knopf.click();
    await this.ruhig();
  }

  exportText() {
    this.win.document.getElementById("expFile"); // vorhanden
    return this.win.document.getElementById("expText").value;
  }

  // Merkzettel aendern, waehrend die App zu ist.
  metaAendern(fn) {
    const m = JSON.parse(this.speicher[META_KEY] || "{}");
    this.speicher[META_KEY] = JSON.stringify(fn(m) || m);
  }

  // App schliessen; der Speicher bleibt, wie er gerade ist.
  schliessen() {
    if (!this.dom) return;
    const ls = this.win.localStorage;
    this.speicher = {};
    for (let i = 0; i < ls.length; i++) { const k = ls.key(i); this.speicher[k] = ls.getItem(k); }
    this.dom.window.close();
    offeneFenster.delete(this.dom.window);
    this.dom = null;
    assert.deepEqual(this.fehler, [], `${this.name}: Skriptfehler`);
  }

  // Aendert die Notizen, waehrend die App zu ist (wie eine Bearbeitung beim letzten Oeffnen).
  notizenAendern(fn) {
    const liste = JSON.parse(this.speicher[NOTIZEN_KEY] || "[]");
    this.speicher[NOTIZEN_KEY] = JSON.stringify(fn(liste) || liste);
  }
}

// Push wie in Chrome auf Android: Notification, Service Worker, PushManager.
function pushNachbauen(win, geraet) {
  const p = geraet.push;
  win.Notification = function () {};
  Object.defineProperty(win.Notification, "permission", { get: () => p.erlaubnis });
  win.Notification.requestPermission = async () => { p.erlaubnis = p.antwort || "granted"; return p.erlaubnis; };
  win.PushManager = function () {};
  const pushManager = {
    getSubscription: async () => geraet.pushAbo,
    subscribe: async (opt) => {
      assert.equal(opt.userVisibleOnly, true);
      assert.equal(opt.applicationServerKey.length, 65, "oeffentlicher VAPID-Schluessel muss 65 Bytes haben");
      const ep = "https://fcm.googleapis.com/fcm/send/" + geraet.name + "-" + Math.random().toString(36).slice(2);
      geraet.pushAbo = {
        endpoint: ep,
        toJSON: () => ({ endpoint: ep, keys: { p256dh: "BPub" + geraet.name, auth: "auth" + geraet.name } }),
        unsubscribe: async () => { geraet.pushAbo = null; return true; },
      };
      return geraet.pushAbo;
    },
  };
  Object.defineProperty(win.navigator, "serviceWorker", {
    value: {
      ready: Promise.resolve({ pushManager }),
      register: async () => ({ pushManager }),
      addEventListener() {},
      controller: null,
    },
  });
}

async function zweiGeraete(opts = {}) {
  const server = new FakeSupabase();
  const a = new Geraet("Handy", server, opts.a);
  const b = new Geraet("Laptop", server, opts.b);
  await a.oeffnen({ sitzung: server.sitzung("u1", "k@test") });
  await b.oeffnen({ sitzung: server.sitzung("u1", "k@test") });
  a.schliessen();
  b.schliessen();
  return { server, a, b };
}

const notiz = (id, text) => ({ id, text, createdAt: 1_700_000_000_000 });

/* ---------------- Tests ---------------- */

test("Anmeldung per Link: angemeldet, synchron, keine Skriptfehler", async () => {
  const server = new FakeSupabase();
  const a = new Geraet("Handy", server);
  await a.oeffnen({ sitzung: server.sitzung("u1", "k@test") });
  assert.equal(a.zustand(), "ruhe");
  assert.equal(a.kopfText(), "Synchron");
  assert.equal(a.meta().konto.email, "k@test");
  assert.ok(!/access_token/.test(a.win.location.href), "Token muss aus der Adresse verschwinden");
  a.schliessen();
});

test("Anlegen, Bearbeiten, Loeschen kommt auf dem anderen Geraet an", async () => {
  const { a, b } = await zweiGeraete();

  a.notizenAendern((l) => [notiz("n1", "Reifen wechseln"), ...l]);
  await a.oeffnen();
  a.schliessen();
  await b.oeffnen();
  assert.equal(b.notiz("n1")?.text, "Reifen wechseln");
  b.schliessen();

  b.notizenAendern((l) => l.map((n) => (n.id === "n1" ? { ...n, text: "Reifen wechseln (Termin 3.12.)" } : n)));
  await b.oeffnen();
  b.schliessen();
  await a.oeffnen();
  assert.equal(a.notiz("n1")?.text, "Reifen wechseln (Termin 3.12.)");
  a.schliessen();

  a.notizenAendern((l) => l.filter((n) => n.id !== "n1"));
  await a.oeffnen();
  a.schliessen();
  await b.oeffnen();
  assert.equal(b.notiz("n1"), undefined, "geloeschte Notiz muss verschwinden");
  await b.syncen();
  b.schliessen();
  await a.oeffnen();
  assert.equal(a.notiz("n1"), undefined, "geloeschte Notiz darf nicht zurueckkommen");
  a.schliessen();
});

test("Konflikt: die spaetere Aenderung gewinnt, beide Geraete gleich", async () => {
  const { a, b } = await zweiGeraete();
  a.notizenAendern((l) => [notiz("n2", "Start"), ...l]);
  await a.oeffnen(); a.schliessen();
  await b.oeffnen(); b.schliessen();

  // beide offline bearbeitet, B spaeter
  a.notizenAendern((l) => l.map((n) => (n.id === "n2" ? { ...n, text: "von A" } : n)));
  await a.oeffnen(); a.schliessen();
  await pause(20);
  b.notizenAendern((l) => l.map((n) => (n.id === "n2" ? { ...n, text: "von B" } : n)));
  await b.oeffnen(); b.schliessen();

  await a.oeffnen();
  assert.equal(a.notiz("n2")?.text, "von B");
  a.schliessen();
  await b.oeffnen();
  assert.equal(b.notiz("n2")?.text, "von B");
  b.schliessen();
});

test("Falsch gehende Uhr: die wirklich spaetere Aenderung gewinnt trotzdem", async () => {
  // Laptop geht 10 Minuten nach
  const { a, b } = await zweiGeraete({ b: { uhrVersatzMs: -10 * 60_000 } });
  a.notizenAendern((l) => [notiz("n3", "Start"), ...l]);
  await a.oeffnen(); a.schliessen();
  await b.oeffnen(); b.schliessen();

  a.notizenAendern((l) => l.map((n) => (n.id === "n3" ? { ...n, text: "zuerst (Handy)" } : n)));
  await a.oeffnen(); a.schliessen();
  await pause(20);
  b.notizenAendern((l) => l.map((n) => (n.id === "n3" ? { ...n, text: "danach (Laptop)" } : n)));
  await b.oeffnen();
  assert.equal(b.notiz("n3")?.text, "danach (Laptop)", "Laptop darf seine neuere Fassung nicht verlieren");
  b.schliessen();

  await a.oeffnen();
  assert.equal(a.notiz("n3")?.text, "danach (Laptop)");
  a.schliessen();
});

test("Abgelaufenes Token wird still erneuert", async () => {
  const { server, a } = await zweiGeraete();
  server.alleZugaengeAblaufen();
  a.notizenAendern((l) => [notiz("n4", "nach Ablauf"), ...l]);
  await a.oeffnen();
  assert.equal(a.zustand(), "ruhe");
  assert.equal(a.kopfText(), "Synchron");
  assert.equal(server.daten("u1", "notizen", "n4")?.daten.text, "nach Ablauf");
  a.schliessen();
});

test("Anmeldung endgueltig weg: sichtbar abgemeldet, Daten bleiben", async () => {
  const { server, a } = await zweiGeraete();
  server.alleZugaengeAblaufen();
  server.alleErneuererUngueltig();
  a.notizenAendern((l) => [notiz("n5", "bleibt da"), ...l]);
  await a.oeffnen();
  assert.equal(a.kopfText(), "Abgemeldet");
  assert.equal(a.win.document.getElementById("syncKopf").hidden, false, "Abmeldung muss sichtbar sein");
  assert.equal(a.notiz("n5")?.text, "bleibt da");
  a.schliessen();
});

test("Offline: Aenderungen warten und gehen spaeter raus", async () => {
  const { server, a, b } = await zweiGeraete();
  server.offline = true;
  a.notizenAendern((l) => [notiz("n6", "im Funkloch"), ...l]);
  await a.oeffnen();
  assert.equal(a.zustand(), "offline");
  assert.match(a.kopfText(), /wartet/);
  server.offline = false;
  await a.syncen();
  assert.equal(a.kopfText(), "Synchron");
  a.schliessen();
  await b.oeffnen();
  assert.equal(b.notiz("n6")?.text, "im Funkloch");
  b.schliessen();
});

test("App wird mitten im Sync beendet: neuere Fassung aus dem Konto geht nicht verloren", async () => {
  const { server, a, b } = await zweiGeraete();
  a.notizenAendern((l) => [notiz("n7", "alt"), ...l]);
  await a.oeffnen(); a.schliessen();
  await b.oeffnen(); b.schliessen();

  a.notizenAendern((l) => l.map((n) => (n.id === "n7" ? { ...n, text: "neu vom Handy" } : n)));
  await a.oeffnen(); a.schliessen();

  // Laptop: hat noch etwas anderes offen, damit nach dem Laden hochgeladen wird,
  // und das Hochladen haengt. Dann wird die App weggewischt.
  b.notizenAendern((l) => [notiz("n8", "anderes"), ...l]);
  server.haengen = "faellig_hochladen";
  await b.oeffnen().catch(() => {});
  const ende = Date.now() + 5000;
  while (b.zustand() !== "laeuft" && Date.now() < ende) await pause(20);
  await pause(300);
  b.fehler = [];
  assert.equal(server.daten("u1", "notizen", "n7")?.daten.text, "neu vom Handy");
  b.schliessen(); // = weggewischt, waehrend das Hochladen noch haengt
  server.haengen = null;

  await b.oeffnen();
  assert.equal(b.notiz("n7")?.text, "neu vom Handy", "Laptop darf die alte Fassung nicht wieder hochschieben");
  b.schliessen();
  assert.equal(server.daten("u1", "notizen", "n7")?.daten.text, "neu vom Handy");
});

test("Viele Eintraege werden in Paketen hochgeladen (Server nimmt hoechstens 500)", async () => {
  const { server, a, b } = await zweiGeraete();
  a.notizenAendern((l) => [...Array.from({ length: 950 }, (_, i) => notiz("m" + i, "Notiz " + i)), ...l]);
  await a.oeffnen();
  assert.equal(a.kopfText(), "Synchron");
  a.schliessen();
  const anzahl = [...server.zeilen.keys()].filter((k) => k.startsWith("u1|notizen|m")).length;
  assert.equal(anzahl, 950);
  await b.oeffnen();
  assert.equal(b.notizen().filter((n) => n.id.startsWith("m")).length, 950);
  b.schliessen();
});

/* ---------------- Sicherung uebertragen ---------------- */

const sicherung = (teile) => ({ app: "faellig", version: 1, exportedAt: "2026-11-01T10:00:00.000Z",
  items: [], notes: [], vorlagen: [], entscheidungen: [], settings: {}, ...teile });

test("Sichern enthaelt alle Sammlungen, Alles ersetzen stellt sie auf einem anderen Geraet wieder her", async () => {
  const server = new FakeSupabase();
  const a = new Geraet("Handy", server);
  a.speicher[AUFGABEN_KEY] = JSON.stringify([{ id: "t1", text: "Steuer", dueKey: "2026-12-01", done: false, createdAt: 1 }]);
  a.speicher[NOTIZEN_KEY] = JSON.stringify([notiz("n1", "Notiz eins")]);
  a.speicher[VORLAGEN_KEY] = JSON.stringify([{ id: "v1", title: "Mahnung", betreff: "", text: "Bitte zahlen", createdAt: 1 }]);
  a.speicher[ENT_KEY] = JSON.stringify([{ id: "e1", frage: "Bangor oder nicht?", createdAt: 1 }]);
  a.speicher[EINST_KEY] = JSON.stringify({ ich: "K", icsAlarm: "2tage", icsAbos: true, icsFolge: 7 });
  await a.oeffnen();
  const text = a.exportText();
  const p = JSON.parse(text);
  assert.equal(p.app, "faellig");
  assert.deepEqual(p.items.map((x) => x.id), ["t1"]);
  assert.deepEqual(p.notes.map((x) => x.id), ["n1"]);
  assert.deepEqual(p.vorlagen.map((x) => x.id), ["v1"]);
  assert.deepEqual(p.entscheidungen.map((x) => x.id), ["e1"]);
  assert.equal(p.settings.ich, "K");
  a.schliessen();

  const b = new Geraet("Neues Handy", server);
  b.speicher[NOTIZEN_KEY] = JSON.stringify([notiz("x", "fliegt raus")]);
  await b.oeffnen();
  await b.importieren(text, "ersetzen");
  const ls = (k) => JSON.parse(b.win.localStorage.getItem(k));
  assert.deepEqual(ls(AUFGABEN_KEY).map((x) => x.text), ["Steuer"]);
  assert.deepEqual(ls(NOTIZEN_KEY).map((x) => x.id), ["n1"]);
  assert.deepEqual(ls(VORLAGEN_KEY).map((x) => x.title), ["Mahnung"]);
  assert.deepEqual(ls(ENT_KEY).map((x) => x.frage), ["Bangor oder nicht?"]);
  const einst = ls(EINST_KEY);
  assert.equal(einst.ich, "K");
  assert.equal(einst.icsAlarm, "2tage");
  assert.equal(einst.icsAbos, true);
  assert.equal(einst.icsFolge, 7);
  b.schliessen();
});

test("Dazunehmen: Uebertragenes geht als neue Aenderung ins Konto und zum anderen Geraet", async () => {
  const { server, a, b } = await zweiGeraete();
  await a.oeffnen();
  await a.importieren(sicherung({
    notes: [notiz("i1", "aus der Sicherung")],
    items: [{ id: "it1", text: "Reisepass verlaengern", dueKey: "2027-01-10", createdAt: 1 }],
  }));
  assert.equal(a.kopfText(), "Synchron");
  assert.equal(server.daten("u1", "notizen", "i1")?.daten.text, "aus der Sicherung");
  assert.equal(server.daten("u1", "aufgaben", "it1")?.daten.text, "Reisepass verlaengern");
  assert.deepEqual(a.meta().importiert, {}, "nach dem Hochladen ist nichts mehr als importiert markiert");
  a.schliessen();
  await b.oeffnen();
  assert.equal(b.notiz("i1")?.text, "aus der Sicherung");
  b.schliessen();
});

test("Dazunehmen auf neuem Geraet ueberschreibt keine neuere Fassung im Konto", async () => {
  const { server, a } = await zweiGeraete();
  a.notizenAendern((l) => [notiz("n20", "alt"), ...l]);
  await a.oeffnen(); a.schliessen();
  const alteSicherung = sicherung({ notes: [notiz("n20", "alt"), notiz("n21", "nur in der Sicherung")] });
  a.notizenAendern((l) => l.map((n) => (n.id === "n20" ? { ...n, text: "neu" } : n)));
  await a.oeffnen(); a.schliessen();

  // Neues Geraet: erst Sicherung dazunehmen, dann anmelden.
  const c = new Geraet("Tablet", server);
  await c.oeffnen();
  await c.importieren(alteSicherung);
  assert.equal(c.notiz("n20")?.text, "alt");
  c.schliessen();
  await c.oeffnen({ sitzung: server.sitzung("u1", "k@test") });
  assert.equal(c.notiz("n20")?.text, "neu", "Fassung im Konto muss gewinnen");
  assert.equal(c.notiz("n21")?.text, "nur in der Sicherung");
  c.schliessen();
  assert.equal(server.daten("u1", "notizen", "n20")?.daten.text, "neu");
  assert.equal(server.daten("u1", "notizen", "n21")?.daten.text, "nur in der Sicherung");
});

test("Dazunehmen stellt im Konto Geloeschtes wieder her, auf allen Geraeten", async () => {
  const { server, a, b } = await zweiGeraete();
  a.notizenAendern((l) => [notiz("n22", "wichtig"), ...l]);
  await a.oeffnen(); a.schliessen();
  await b.oeffnen(); b.schliessen();
  b.notizenAendern((l) => l.filter((n) => n.id !== "n22"));
  await b.oeffnen(); b.schliessen();
  assert.equal(server.daten("u1", "notizen", "n22")?.geloescht, true);

  await a.oeffnen();
  assert.equal(a.notiz("n22"), undefined);
  await a.importieren(sicherung({ notes: [notiz("n22", "wichtig")] }));
  assert.equal(a.notiz("n22")?.text, "wichtig", "darf nicht gleich wieder verschwinden");
  a.schliessen();
  assert.equal(server.daten("u1", "notizen", "n22")?.geloescht, false);
  await b.oeffnen();
  assert.equal(b.notiz("n22")?.text, "wichtig");
  b.schliessen();
});

test("Alles ersetzen gilt auch fuer Eintraege, die dieses Geraet noch nicht kannte", async () => {
  const { server, a, b } = await zweiGeraete();
  a.notizenAendern((l) => [notiz("n30", "bleibt, geaendert"), notiz("n31", "fliegt"), ...l]);
  await a.oeffnen(); a.schliessen();
  await b.oeffnen(); b.schliessen();
  a.notizenAendern((l) => [notiz("n32", "kennt B noch nicht"), ...l]);
  await a.oeffnen(); a.schliessen();

  server.offline = true;
  await b.oeffnen();
  await b.importieren(sicherung({ notes: [notiz("n30", "aus der Sicherung"), notiz("n33", "neu")] }), "ersetzen");
  server.offline = false;
  await b.syncen();
  assert.deepEqual(b.notizen().map((n) => n.id).sort(), ["n30", "n33"]);
  assert.equal(b.meta().ersetzen, undefined, "nach vollem Abgleich erledigt");
  b.schliessen();

  for (const id of ["n31", "n32"]) assert.equal(server.daten("u1", "notizen", id)?.geloescht, true, id);
  assert.equal(server.daten("u1", "notizen", "n30")?.daten.text, "aus der Sicherung");
  await a.oeffnen();
  assert.deepEqual(a.notizen().map((n) => n.id).sort(), ["n30", "n33"]);
  a.schliessen();
});

/* ---------------- Grabsteine aufraeumen ---------------- */

test("Grabsteine aelter als 90 Tage verschwinden lokal und im Konto, frische bleiben", async () => {
  const { server, a } = await zweiGeraete();
  a.notizenAendern((l) => [notiz("g1", "alt geloescht"), notiz("g2", "frisch geloescht"), ...l]);
  await a.oeffnen(); a.schliessen();
  a.notizenAendern((l) => l.filter((n) => n.id !== "g1" && n.id !== "g2"));
  await a.oeffnen(); a.schliessen();

  // g1 so tun, als waere es vor 100 Tagen geloescht worden. Dazu ein alter
  // Grabstein, der noch nie hochgeladen wurde.
  const vor100 = Date.now() - 100 * TAG;
  server.zeilen.get("u1|notizen|g1").geaendert_am = vor100;
  a.metaAendern((m) => {
    m.tote["notizen|g1"] = vor100;
    m.tote["notizen|g3"] = vor100;
    m.offen["notizen|g3"] = true;
    delete m.aufgeraeumt;
  });

  server.offline = true;
  await a.oeffnen();
  assert.ok(!("notizen|g1" in a.meta().tote), "hochgeladener alter Grabstein lokal weg");
  assert.ok("notizen|g3" in a.meta().tote, "noch nicht hochgeladener Grabstein muss bleiben");
  assert.ok("notizen|g2" in a.meta().tote, "frischer Grabstein bleibt");
  server.offline = false;
  await a.syncen();
  const m = a.meta();
  assert.ok(!("notizen|g3" in m.tote), "nach dem Hochladen auch weg");
  assert.ok("notizen|g2" in m.tote);
  assert.ok(m.aufgeraeumt > 0);
  a.schliessen();

  assert.equal(server.daten("u1", "notizen", "g1"), undefined, "im Konto aufgeraeumt");
  assert.equal(server.daten("u1", "notizen", "g3"), undefined, "im Konto aufgeraeumt");
  assert.equal(server.daten("u1", "notizen", "g2")?.geloescht, true, "frischer Grabstein bleibt im Konto");

  // hoechstens einmal am Tag
  const vorher = server.log.filter((z) => z.includes("faellig_aufraeumen")).length;
  await a.oeffnen(); await a.syncen(); a.schliessen();
  assert.equal(server.log.filter((z) => z.includes("faellig_aufraeumen")).length, vorher);
});

test("Lange nicht abgeglichen: im Konto aufgeraeumtes Loeschen kommt nicht zurueck", async () => {
  const { server, a, b } = await zweiGeraete();
  a.notizenAendern((l) => [notiz("w1", "anderswo geloescht"), notiz("w2", "lebt noch"), ...l]);
  await a.oeffnen(); a.schliessen();
  await b.oeffnen(); b.schliessen();
  a.notizenAendern((l) => l.filter((n) => n.id !== "w1"));
  await a.oeffnen(); a.schliessen();

  // B lag 100 Tage in der Schublade; inzwischen ist der Grabstein im Konto aufgeraeumt.
  server.zeilen.delete("u1|notizen|w1");
  const vor100 = Date.now() - 100 * TAG;
  b.metaAendern((m) => {
    m.zuletzt = vor100;
    for (const k of Object.keys(m.stand)) m.stand[k].t = Math.min(m.stand[k].t, vor100);
  });
  b.notizenAendern((l) => [notiz("w3", "neu auf B"), ...l]);
  await b.oeffnen();
  assert.equal(b.notiz("w1"), undefined, "verwaister Eintrag muss weg");
  assert.equal(b.notiz("w2")?.text, "lebt noch");
  assert.equal(b.notiz("w3")?.text, "neu auf B");
  b.schliessen();
  assert.equal(server.daten("u1", "notizen", "w1"), undefined, "darf nicht wieder hochgeladen werden");
  assert.equal(server.daten("u1", "notizen", "w3")?.daten.text, "neu auf B");
});

/* ---------------- Kalender-Abo ---------------- */

const frist = (id, text, dueKey) => ({
  id, text, subject: null, dueKey, isFixed: true, repeat: null, amountCents: null, kuend: null,
  bereich: null, done: false, createdAt: 1_700_000_000_000,
});

function aufgabenAendern(g, fn) {
  const liste = JSON.parse(g.speicher[AUFGABEN_KEY] || "[]");
  g.speicher[AUFGABEN_KEY] = JSON.stringify(fn(liste) || liste);
}

function aboUrl(g) { return g.win.document.getElementById("kalAboUrl").value; }

async function aboAbrufen(server, url) {
  const r = await server.fetchFuer()(url, {});
  return { status: r.status, text: await r.text() };
}

const uploads = (server) => server.log.filter((l) => /^POST \/storage\//.test(l)).length;

test("Kalender-Abo: Link erstellen, Datei liegt oeffentlich, anderes Geraet zeigt denselben Link", async () => {
  const { server, a, b } = await zweiGeraete();
  aufgabenAendern(a, (l) => [frist("f1", "Steuererklaerung abgeben", "2027-07-31"), ...l]);
  await a.oeffnen();
  const d = a.win.document;
  assert.equal(d.getElementById("kalAboStart").hidden, false, "Knopf muss angemeldet sichtbar sein");
  d.getElementById("kalAboAn").click();
  await a.ruhig();

  const url = aboUrl(a);
  assert.match(url, /^https:\/\/xrrcuapiugwgqxxatkiq\.supabase\.co\/storage\/v1\/object\/public\/faellig-kalender\/u1\/[0-9a-f]{32}\.ics$/);
  const r = await aboAbrufen(server, url);
  assert.equal(r.status, 200);
  assert.match(r.text, /BEGIN:VCALENDAR/);
  assert.match(r.text, /SUMMARY:Steuererklaerung abgeben/);
  assert.match(r.text, /DTSTART;VALUE=DATE:20270731/);
  assert.match(r.text, /REFRESH-INTERVAL;VALUE=DURATION:PT1H/);
  assert.match(server.dateien.get(url.split("/public/")[1]).typ, /^text\/calendar/);
  assert.match(d.getElementById("kalAboGoogle").href, /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal%3A%2F%2F/);
  assert.match(d.getElementById("kalAboMsg").textContent, /Aktuell/);
  a.schliessen();

  await b.oeffnen();
  assert.equal(aboUrl(b), url, "beide Geraete muessen denselben Link haben");
  b.schliessen();
});

test("Kalender-Abo: Aenderung auf dem anderen Geraet landet in der Datei, ohne Aenderung kein Hochladen", async () => {
  const { server, a, b } = await zweiGeraete();
  aufgabenAendern(a, (l) => [frist("f1", "TUeV", "2027-03-01"), ...l]);
  await a.oeffnen();
  a.win.document.getElementById("kalAboAn").click();
  await a.ruhig();
  const url = aboUrl(a);
  a.schliessen();

  aufgabenAendern(b, (l) => [frist("f2", "Kfz-Steuer", "2027-04-15"), ...l]);
  await b.oeffnen();
  b.schliessen();
  let r = await aboAbrufen(server, url);
  assert.match(r.text, /SUMMARY:TUeV/);
  assert.match(r.text, /SUMMARY:Kfz-Steuer/);

  const vorher = uploads(server);
  await b.oeffnen();
  await b.syncen();
  b.schliessen();
  assert.equal(uploads(server), vorher, "gleicher Inhalt darf nicht erneut hochgeladen werden");

  aufgabenAendern(a, (l) => l.map((i) => (i.id === "f1" ? { ...i, done: true } : i)));
  await a.oeffnen();
  a.schliessen();
  r = await aboAbrufen(server, url);
  assert.doesNotMatch(r.text, /SUMMARY:TUeV/, "Erledigtes muss aus dem Abo verschwinden");
});

test("Kalender-Abo: neuer Link loescht den alten, Abo beenden loescht die Datei auf allen Geraeten", async () => {
  const { server, a, b } = await zweiGeraete();
  aufgabenAendern(a, (l) => [frist("f1", "Miete", "2027-01-01"), ...l]);
  await a.oeffnen();
  a.win.document.getElementById("kalAboAn").click();
  await a.ruhig();
  const alt = aboUrl(a);
  a.win.document.getElementById("kalAboNeu").click();
  await a.ruhig();
  const neu = aboUrl(a);
  assert.notEqual(neu, alt);
  assert.equal((await aboAbrufen(server, alt)).status, 400, "alter Link muss tot sein");
  assert.equal((await aboAbrufen(server, neu)).status, 200);
  a.schliessen();

  await b.oeffnen();
  assert.equal(aboUrl(b), neu);
  b.win.document.getElementById("kalAboEnde").click();
  await b.ruhig();
  assert.equal(b.win.document.getElementById("kalAboDa").hidden, true);
  assert.equal((await aboAbrufen(server, neu)).status, 400, "beendetes Abo muss offline sein");
  b.schliessen();

  await a.oeffnen();
  assert.equal(a.win.document.getElementById("kalAboDa").hidden, true, "auch das andere Geraet zeigt kein Abo mehr");
  assert.equal(a.win.document.getElementById("kalAboStart").hidden, false);
  a.schliessen();
  assert.equal(server.dateien.size, 0);
});

test("Kalender-Abo: fehlt der Speicherordner, gibt es eine sichtbare Meldung und der Sync bleibt heil", async () => {
  const { server, a } = await zweiGeraete();
  server.eimer.clear();
  await a.oeffnen();
  a.win.document.getElementById("kalAboAn").click();
  await a.ruhig();
  assert.equal(a.kopfText(), "Synchron");
  const msg = a.win.document.getElementById("kalAboMsg");
  assert.match(msg.textContent, /konnte nicht aktualisiert werden/);
  assert.equal(msg.getAttribute("data-ok"), "false");

  server.eimer.add("faellig-kalender");
  await a.syncen();
  assert.equal((await aboAbrufen(server, aboUrl(a))).status, 200, "beim naechsten Sync klappt es");
  assert.match(msg.textContent, /Aktuell/);
  a.schliessen();
});

test("Kalender-Abo: abgemeldet kein Knopf, kein Hochladen", async () => {
  const server = new FakeSupabase();
  const a = new Geraet("Handy", server);
  await a.oeffnen();
  const d = a.win.document;
  assert.equal(d.getElementById("kalAboStart").hidden, true);
  assert.equal(d.getElementById("kalAboDa").hidden, true);
  assert.equal(uploads(server), 0);
  a.schliessen();
});


/* ---------------- Google-Termine ---------------- */

const G_URL = "https://calendar.google.com/calendar/ical/k%40test/private-0123456789abcdef/basic.ics";

function lokal(tagePlus, std, min = 0) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + tagePlus, std, min);
}
function tagKey(tagePlus) {
  const d = new Date();
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + tagePlus);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
function zeitTermin(id, titel, tagePlus, std, dauerMin = 60, ort = "") {
  const s = lokal(tagePlus, std);
  return { id, titel, ort, ganztag: false, start: s.toISOString(), ende: new Date(+s + dauerMin * 60000).toISOString() };
}

function googleZeilen(g) {
  return [...g.win.document.querySelectorAll("#list .task--google")].map((el) => ({
    titel: el.querySelector(".task__text").textContent,
    meta: el.querySelector(".task__meta").textContent,
    gruppe: el.closest(".group").querySelector(".group__head").firstChild.textContent.trim(),
  }));
}

async function googleVerbinden(g, url = G_URL) {
  const d = g.win.document;
  d.getElementById("gTerminUrl").value = url;
  d.getElementById("gTerminAn").click();
  await g.ruhig();
}

test("Google-Termine: verbinden, anzeigen, nicht mitzaehlen, kommt aufs andere Geraet", async () => {
  const { server, a, b } = await zweiGeraete();
  server.googleTermine = [
    zeitTermin("g-vorbei", "Schon vorbei", -1, 9),
    zeitTermin("g-morgen", "Zahnarzt", 1, 10, 90, "Praxis Muster"),
    zeitTermin("g-woche", "Vorlesung", 4, 9),
    { id: "g-urlaub", titel: "Wochenende Brandenburg", ort: "", ganztag: true, start: tagKey(-1), ende: tagKey(2) },
    zeitTermin("g-weit", "Zu weit weg", 20, 9),
  ];
  aufgabenAendern(a, (l) => [frist("f1", "Miete", tagKey(1)), ...l]);

  await a.oeffnen();
  const d = a.win.document;
  assert.equal(d.getElementById("gTerminStart").hidden, false);

  await googleVerbinden(a, "https://example.com/kalender.ics");
  assert.match(d.getElementById("gTerminMsg").textContent, /nicht die Privatadresse/);
  assert.equal(server.googleAbrufe || 0, 0, "falsche Adresse geht gar nicht erst raus");

  await googleVerbinden(a);
  const z = googleZeilen(a);
  assert.deepEqual(z.map((x) => x.titel), ["Wochenende Brandenburg", "Zahnarzt", "Vorlesung"]);
  assert.equal(z[0].gruppe, "Heute", "laufender Mehrtagestermin steht unter heute");
  assert.match(z[0].meta, /ganztägig bis/);
  assert.equal(z[1].gruppe, "Morgen");
  assert.match(z[1].meta, /10:00–11:30/);
  assert.match(z[1].meta, /Praxis Muster/);
  // Kalendertermine zuerst, dann die Frist am selben Tag
  const morgen = [...d.querySelectorAll("#list .group")].find((g) => /Morgen/.test(g.textContent));
  assert.equal(morgen.querySelector(".group__count").textContent, "1", "nur die Frist zaehlt");
  assert.ok(morgen.querySelector(".task--google").compareDocumentPosition(morgen.querySelector(".task[data-id='f1']")) &
    a.win.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(d.getElementById("countNum").textContent, "1", "Kopfzahl nur aus Fristen");
  assert.match(d.getElementById("gTerminMsg").textContent, /3 Termine/);
  assert.equal(d.getElementById("gTerminDa").hidden, false);
  a.schliessen();

  await b.oeffnen();
  assert.deepEqual(googleZeilen(b).map((x) => x.titel), ["Wochenende Brandenburg", "Zahnarzt", "Vorlesung"]);
  b.schliessen();
});

test("Google-Termine: offline bleiben die alten stehen, Fehler wird gemeldet, nicht dauernd neu geholt", async () => {
  const { server, a } = await zweiGeraete();
  server.googleTermine = [zeitTermin("g1", "Zahnarzt", 2, 10)];
  await a.oeffnen();
  await googleVerbinden(a);
  const abrufe = server.googleAbrufe;
  await a.syncen();
  assert.equal(server.googleAbrufe, abrufe, "innerhalb von 15 Minuten nicht nochmal");
  a.schliessen();

  server.offline = true;
  await a.oeffnen();
  assert.deepEqual(googleZeilen(a).map((x) => x.titel), ["Zahnarzt"]);
  a.schliessen();
  server.offline = false;

  server.googleAntwort = { status: 404, body: { error: "Google kennt diese Adresse nicht (mehr)." } };
  await a.oeffnen();
  a.win.document.getElementById("gTerminJetzt").click();
  await a.ruhig();
  const msg = a.win.document.getElementById("gTerminMsg");
  assert.match(msg.textContent, /kennt diese Adresse nicht/);
  assert.equal(msg.getAttribute("data-ok"), "false");
  assert.deepEqual(googleZeilen(a).map((x) => x.titel), ["Zahnarzt"], "alte Termine bleiben sichtbar");
  assert.equal(a.kopfText(), "Synchron", "Sync selbst bleibt heil");
  a.schliessen();
});

test("Google-Termine: Trennen entfernt sie auf allen Geraeten", async () => {
  const { server, a, b } = await zweiGeraete();
  server.googleTermine = [zeitTermin("g1", "Zahnarzt", 2, 10)];
  await a.oeffnen();
  await googleVerbinden(a);
  a.schliessen();
  await b.oeffnen();
  assert.equal(googleZeilen(b).length, 1);
  b.win.document.getElementById("gTerminTrennen").click();
  await b.ruhig();
  assert.equal(googleZeilen(b).length, 0);
  b.schliessen();
  await a.oeffnen();
  assert.equal(googleZeilen(a).length, 0);
  assert.equal(a.win.document.getElementById("gTerminStart").hidden, false);
  a.schliessen();
});

test("Google-Termine: abgemeldet kein Abruf", async () => {
  const server = new FakeSupabase();
  const a = new Geraet("Handy", server);
  await a.oeffnen();
  assert.equal(a.win.document.getElementById("gTerminStart").hidden, true);
  assert.equal(server.googleAbrufe || 0, 0);
  a.schliessen();
});


/* ---------------- Erinnerungen aufs Handy ---------------- */

const ERI_MERK_KEY = "faellig-erinnerung-v1";

function einstAendern(g, fn) {
  const e = JSON.parse(g.speicher[EINST_KEY] || "{}");
  g.speicher[EINST_KEY] = JSON.stringify(fn(e) || e);
}

function plan(server, uid = "u1") { return (server.pushPlaene && server.pushPlaene.get(uid)) || null; }
function planTag(server, tagePlus) { return (plan(server) || []).find((p) => p.tag === tagKey(tagePlus)); }

async function schalten(g, an) {
  const el = g.win.document.getElementById("eriAn");
  el.checked = an;
  el.dispatchEvent(new g.win.Event("change"));
  await g.ruhig();
}

function eriStatus(g) { return g.win.document.getElementById("eriStatus").textContent; }

test("Erinnerungen: Plan mit Ueberfaelligem, heute, morgen, Wiederholung und Kuendigungsfrist", async () => {
  const { server, a } = await zweiGeraete();
  aufgabenAendern(a, () => [
    frist("f-alt", "Steuer", tagKey(-3)),
    frist("f-heute", "Miete", tagKey(0)),
    frist("f-morgen", "TÜV", tagKey(1)),
    { ...frist("f-muell", "Müll raus", tagKey(0)), isFixed: false, repeat: { unit: "week", n: 1 } },
    { ...frist("f-weg", "Erledigt", tagKey(0)), done: true },
    { ...frist("abo-fit", "Fitness", tagKey(5)), amountCents: 3000, repeat: { unit: "month", n: 1 },
      kuend: { n: 14, unit: "day", endeKey: tagKey(44) } },
  ]);
  einstAendern(a, (e) => ({ ...e, erinnerung: { uhrzeit: "06:45", heute: true, morgen: true, termine: false, kuend: true } }));
  await a.oeffnen();

  const heute = planTag(server, 0);
  assert.ok(heute, "heute muss im Plan stehen");
  assert.equal(heute.uhrzeit, "06:45");
  const tag = heute.meldungen[0];
  assert.equal(tag.titel, "Fällig: 1 überfällig · 2 heute");
  assert.equal(tag.text, "Überfällig: Steuer\nHeute: Miete, Müll raus\nMorgen: TÜV");
  assert.equal(tag.tag, "faellig-tag-" + tagKey(0));
  // Kuendigungsfrist: letzter Tag in 30 Tagen -> eigene Meldung heute
  const kuend = heute.meldungen[1];
  assert.equal(kuend.titel, "Kündigen: Fitness");
  assert.match(kuend.text, /^Noch 30 Tage: bis .+ muss die Kündigung raus\. Vertrag läuft bis /);

  // In einer Woche: Muell ist wieder "heute", Steuer weiter ueberfaellig
  const woche = planTag(server, 7);
  assert.match(woche.meldungen[0].text, /Überfällig: Steuer, Miete, TÜV\nHeute: Müll raus/);
  // 7 Tage vor der Kuendigungsfrist und am letzten Tag
  assert.ok(planTag(server, 23).meldungen.some((m) => /^Noch 7 Tage/.test(m.text)));
  assert.match(planTag(server, 30).meldungen[0].text, /Heute: .*Fitness kündigen \(letzter Tag\)/);
  assert.match(planTag(server, 29).meldungen[0].text, /Morgen: Fitness kündigen \(letzter Tag\)/);
  assert.equal(plan(server).length, 60, "jeden Tag steht etwas an (Steuer bleibt ueberfaellig)");

  // Ohne Aenderung kein neues Hochladen
  const n = server.pushPlanUploads;
  await a.syncen();
  assert.equal(server.pushPlanUploads, n);

  // Steuer erledigt -> neuer Plan
  a.win.document.querySelector("[data-act='done'][data-id='f-alt']").click();
  await a.ruhig();
  assert.ok(server.pushPlanUploads > n);
  assert.doesNotMatch(planTag(server, 0).meldungen[0].text, /Steuer/);
  a.schliessen();
});

test("Erinnerungen: leere Tage fehlen, Haekchen wirken, Termine nur wenn gewollt", async () => {
  const { server, a } = await zweiGeraete();
  server.googleTermine = [zeitTermin("g1", "Zahnarzt", 2, 10)];
  aufgabenAendern(a, () => [frist("f1", "Miete", tagKey(3))]);
  einstAendern(a, (e) => ({ ...e, googleIcal: G_URL, erinnerung: { uhrzeit: "07:30", heute: true, morgen: false, termine: true, kuend: true } }));
  await a.oeffnen();
  await a.ruhig();
  assert.deepEqual(plan(server).slice(0, 2).map((p) => p.tag), [tagKey(2), tagKey(3)], "heute und morgen: nichts, also fehlen sie");
  assert.equal(planTag(server, 4).meldungen[0].text, "Überfällig: Miete", "bleibt bis zum Abhaken ueberfaellig");
  assert.equal(planTag(server, 2).meldungen[0].titel, "Fällig: 1 Termin");
  assert.equal(planTag(server, 2).meldungen[0].text, "Termine: 10:00 Zahnarzt");
  assert.equal(planTag(server, 3).meldungen[0].text, "Heute: Miete");

  const d = a.win.document;
  d.getElementById("eriTermine").checked = false;
  d.getElementById("eriTermine").dispatchEvent(new a.win.Event("change"));
  d.getElementById("eriMorgen").checked = true;
  d.getElementById("eriMorgen").dispatchEvent(new a.win.Event("change"));
  await a.ruhig();
  assert.equal(plan(server)[0].tag, tagKey(2));
  assert.equal(planTag(server, 2).meldungen[0].text, "Morgen: Miete");
  assert.equal(planTag(server, 2).meldungen[0].titel, "Fällig: 1 morgen");
  a.schliessen();
});

test("Erinnerungen: ohne Einschalten keine Anfragen ans Konto", async () => {
  const { server, a } = await zweiGeraete();
  aufgabenAendern(a, () => [frist("f1", "Miete", tagKey(0))]);
  await a.oeffnen();
  assert.ok(!server.log.some((l) => /push/.test(l)), server.log.join("\n"));
  a.schliessen();
});

test("Erinnerungen: einschalten, Test schicken, Einstellung kommt aufs andere Geraet, ausschalten", async () => {
  const server = new FakeSupabase();
  const a = new Geraet("Handy", server, { push: { erlaubnis: "default", antwort: "granted" } });
  const b = new Geraet("Laptop", server);
  await a.oeffnen({ sitzung: server.sitzung("u1", "k@test") });
  await b.oeffnen({ sitzung: server.sitzung("u1", "k@test") });
  b.schliessen();

  await schalten(a, true);
  assert.equal(a.win.document.getElementById("eriAn").checked, true);
  const abos = [...server.pushAbos.entries()];
  assert.equal(abos.length, 1);
  assert.equal(abos[0][1].uid, "u1");
  assert.ok(abos[0][1].zone, "Zeitzone des Geraets geht mit");
  assert.ok(plan(server), "Plan wird gleich hochgeladen");
  assert.match(eriStatus(a), /steht nichts an|Nächste Erinnerung/);

  a.win.document.getElementById("eriTest").click();
  await a.ruhig();
  assert.equal(server.pushTests.length, 1);
  assert.equal(server.pushTests[0].endpoint, abos[0][0]);
  assert.match(eriStatus(a), /Geschickt/);
  a.schliessen();

  // Laptop: hat keinen Schalter an, rechnet aber den Plan mit, wenn dort etwas dazukommt
  aufgabenAendern(b, (l) => [frist("f-laptop", "Rechnung", tagKey(1)), ...l]);
  await b.oeffnen();
  assert.equal(b.win.document.getElementById("eriAn").checked, false);
  assert.equal(planTag(server, 1).meldungen[0].text, "Heute: Rechnung");
  const z = b.win.document.getElementById("eriZeit");
  z.value = "08:15";
  z.dispatchEvent(new b.win.Event("change"));
  await b.ruhig();
  assert.equal(plan(server)[0].uhrzeit, "08:15");
  b.schliessen();

  await a.oeffnen();
  assert.equal(a.win.document.getElementById("eriZeit").value, "08:15", "Uhrzeit gilt fuers Konto");
  assert.equal(a.win.document.getElementById("eriAn").checked, true, "Schalter bleibt je Geraet");
  await schalten(a, false);
  assert.equal(server.pushAbos.size, 0);
  assert.equal(a.pushAbo, null);
  assert.match(eriStatus(a), /aus/);
  a.schliessen();
});

test("Erinnerungen: Benachrichtigungen verboten -> klare Meldung, bleibt aus", async () => {
  const server = new FakeSupabase();
  const a = new Geraet("Handy", server, { push: { erlaubnis: "default", antwort: "denied" } });
  await a.oeffnen({ sitzung: server.sitzung("u1", "k@test") });
  await schalten(a, true);
  assert.equal(a.win.document.getElementById("eriAn").checked, false);
  assert.match(eriStatus(a), /blockiert/);
  assert.equal(server.pushAbos, undefined);
  a.schliessen();
});

test("Erinnerungen: Browser ohne Push zeigt Hinweis statt Schalter", async () => {
  const server = new FakeSupabase();
  const a = new Geraet("Alt", server);
  await a.oeffnen({ sitzung: server.sitzung("u1", "k@test") });
  // jsdom kennt kein PushManager
  assert.equal(a.win.document.getElementById("eriDa").hidden, true);
  assert.equal(a.win.document.getElementById("eriGehtNicht").hidden, false);
  a.schliessen();
});
