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
        const text = r.body === undefined ? "" : JSON.stringify(r.body);
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

  antwort(u, init) {
    const koerper = init.body ? JSON.parse(init.body) : null;
    const methode = init.method || "GET";

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

    return { status: 404, body: { message: "unbekannt " + u.pathname } };
  }
}

/* ---------------- Ein Geraet ---------------- */

// Schlaegt ein Test fehl, bleiben Fenster mit laufenden Timern offen. Aufraeumen.
const offeneFenster = new Set();
afterEach(() => { for (const w of offeneFenster) w.close(); offeneFenster.clear(); });

class Geraet {
  constructor(name, server, { uhrVersatzMs = 0 } = {}) {
    this.name = name;
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
