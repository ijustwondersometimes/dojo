// Wien / NÖ Dojo – Cloudflare Worker
// Öffentlich:  POST /api/stats · POST /api/feedback · GET /api/highscore · POST /api/score
// Nur Admin:   /admin (Seite) und /admin/api/* – geschützt durch ein Passwort (Worker-Secret ADMIN_PASSWORD)
// Alles andere liefert die statischen Dateien (index.html usw.) aus.

import ADMIN_HTML from "./admin.html"; // wird von wrangler als Text eingebunden

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS stats (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, vid TEXT, kind TEXT, settings TEXT, topics TEXT, decks TEXT, ok INTEGER, no INTEGER, best INTEGER, rec INTEGER, min INTEGER, dev TEXT, geo TEXT)`,
  `CREATE INDEX IF NOT EXISTS stats_ts ON stats(ts)`,
  `CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT, rating INTEGER, topic TEXT, card TEXT, text TEXT, vid TEXT, lang TEXT)`,
  `CREATE INDEX IF NOT EXISTS feedback_ts ON feedback(ts)`,
  `CREATE TABLE IF NOT EXISTS scores (vid TEXT PRIMARY KEY, name TEXT NOT NULL, best INTEGER NOT NULL, ts INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS scores_best ON scores(best DESC)`,
];
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
  schemaReady = true;
}

// Seiten, die die öffentliche API aufrufen dürfen (GitHub-Pages-Version + Cloudflare selbst)
const ORIGINS = [
  "https://ijustwondersometimes.github.io",
  "https://dojo.ijustwondersometimes.workers.dev",
];
function cors(req) {
  const o = req.headers.get("Origin");
  return o && ORIGINS.includes(o) ? { "Access-Control-Allow-Origin": o, Vary: "Origin" } : {};
}
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

const str = (v, n) => (v == null ? "" : String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n));
const int = (v, max = 100000) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
const vidOk = (v) => /^[a-z0-9]{3,16}$/i.test(String(v || ""));

async function body(req) {
  const t = await req.text();
  if (t.length > 8000) throw new Error("zu groß");
  return JSON.parse(t || "{}");
}

// ---------- Öffentliche API ----------
async function postStats(req, env) {
  const b = await body(req);
  const decks = {};
  if (b.decks && typeof b.decks === "object")
    for (const [k, x] of Object.entries(b.decks).slice(0, 30))
      decks[str(k, 40)] = { ok: int(x && x.ok, 10000), no: int(x && x.no, 10000) };
  await env.DB.prepare(
    `INSERT INTO stats (ts,vid,kind,settings,topics,decks,ok,no,best,rec,min,dev,geo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(
      Date.now(),
      vidOk(b.vid) ? b.vid : "-",
      b.kind === "visit" ? "visit" : "progress",
      str(b.set, 120),
      str(b.topics, 600),
      JSON.stringify(decks),
      int(b.ok, 10000), int(b.no, 10000), int(b.best, 10000), int(b.rec, 1000), int(b.min, 1440),
      str(b.dev, 60),
      str(b.geo, 80)
    )
    .run();
  return json({ ok: true });
}

async function postFeedback(req, env) {
  const b = await body(req);
  const kind = ["feedback", "bug", "vote"].includes(b.kind) ? b.kind : "feedback";
  const vid = vidOk(b.vid) ? b.vid : "-";
  const text = str(b.text, 1000);
  const rating = kind === "feedback" ? int(b.rating, 5) || null : null;
  const topic = kind === "vote" ? str(b.topic, 60) : "";
  if (!text && !rating && !topic) return json({ ok: false, error: "leer" }, 400);
  // Bremse gegen Spam: max. 10 Einträge pro Besucher-ID und Stunde
  if (vid !== "-") {
    const r = await env.DB.prepare(`SELECT COUNT(*) n FROM feedback WHERE vid=? AND ts>?`).bind(vid, Date.now() - 3600e3).first();
    if (r && r.n >= 10) return json({ ok: false, error: "zu viele" }, 429);
  }
  await env.DB.prepare(`INSERT INTO feedback (ts,kind,rating,topic,card,text,vid,lang) VALUES (?,?,?,?,?,?,?,?)`)
    .bind(Date.now(), kind, rating, topic, kind === "bug" ? str(b.card, 200) : "", text, vid, str(b.lang, 5))
    .run();
  return json({ ok: true });
}

async function getHighscore(env) {
  const { results } = await env.DB.prepare(`SELECT name,best,ts FROM scores ORDER BY best DESC, ts ASC LIMIT 10`).all();
  return json({ ok: true, top: results }, 200, { "cache-control": "max-age=30" });
}

async function postScore(req, env) {
  const b = await body(req);
  if (!vidOk(b.vid)) return json({ ok: false, error: "id" }, 400);
  const name = str(b.name, 20);
  const best = int(b.best, 5000);
  if (!name || best < 1) return json({ ok: false, error: "leer" }, 400);
  // Pro Besucher ein Eintrag; der Rekord kann nur steigen, der Name darf sich ändern
  await env.DB.prepare(
    `INSERT INTO scores (vid,name,best,ts) VALUES (?,?,?,?)
     ON CONFLICT(vid) DO UPDATE SET name=excluded.name,
       ts=CASE WHEN excluded.best>scores.best THEN excluded.ts ELSE scores.ts END,
       best=MAX(scores.best, excluded.best)`
  )
    .bind(b.vid, name, best, Date.now())
    .run();
  const me = await env.DB.prepare(`SELECT best FROM scores WHERE vid=?`).bind(b.vid).first();
  const rank = await env.DB.prepare(`SELECT COUNT(*)+1 r FROM scores WHERE best>?`).bind(me.best).first();
  return json({ ok: true, best: me.best, rank: rank.r });
}

// ---------- Admin-Passwort prüfen (Worker-Secret ADMIN_PASSWORD) ----------
// Der Browser fragt per Login-Fenster nach Benutzername + Passwort (HTTP Basic Auth über HTTPS).
// Der Benutzername ist egal, nur das Passwort zählt. Danach schickt der Browser es bei jedem
// Aufruf von /admin/api/* automatisch mit – an der Admin-Seite muss nichts geändert werden.
const enc = new TextEncoder();
const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));

async function checkAdmin(req, env) {
  const secret = env.ADMIN_PASSWORD;
  if (!secret) return "setup";
  const m = (req.headers.get("Authorization") || "").match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
  if (!m) return "login";
  let given = "";
  try {
    const raw = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
    const pair = new TextDecoder().decode(raw); // UTF-8, damit auch Umlaute im Passwort gehen
    given = pair.slice(pair.indexOf(":") + 1);
  } catch (e) {
    return "login";
  }
  // Vergleich über Hashes in konstanter Zeit (verrät nichts über Länge oder Anfang des Passworts)
  const [a, b] = await Promise.all([sha256(given), sha256(secret)]);
  if (crypto.subtle.timingSafeEqual(a, b)) return null;
  await new Promise((r) => setTimeout(r, 1000)); // Bremse gegen Durchprobieren
  return "falsch";
}

function denyAdmin(path, why) {
  if (why === "setup") {
    const msg = "Admin ist noch nicht eingerichtet: Secret ADMIN_PASSWORD fehlt (npx wrangler secret put ADMIN_PASSWORD).";
    return path.startsWith("/admin/api/")
      ? json({ ok: false, error: "setup" }, 503)
      : new Response(msg, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const headers = {
    "WWW-Authenticate": 'Basic realm="Dojo Admin", charset="UTF-8"',
    "cache-control": "no-store",
  };
  return path.startsWith("/admin/api/")
    ? json({ ok: false, error: "login" }, 401, headers)
    : new Response("Kein Zugang.", { status: 401, headers: { ...headers, "content-type": "text/plain; charset=utf-8" } });
}

// ---------- Admin-API ----------
const DAY = 86400e3;
async function adminSummary(env, days) {
  const since = Date.now() - days * DAY;
  const db = env.DB;
  const [tot, perDay, dev, geo, set, rows, fbn, sc] = await db.batch([
    db.prepare(`SELECT COUNT(DISTINCT vid) users, SUM(kind='visit') visits, SUM(ok) ok, SUM(no) no, SUM(min) min, MAX(best) best FROM stats WHERE ts>?`).bind(since),
    db.prepare(`SELECT date(ts/1000,'unixepoch') d, SUM(kind='visit') visits, COUNT(DISTINCT vid) users, SUM(ok) ok, SUM(no) no FROM stats WHERE ts>? GROUP BY d ORDER BY d`).bind(since),
    db.prepare(`SELECT dev k, COUNT(DISTINCT vid) n FROM stats WHERE ts>? AND kind='visit' GROUP BY dev ORDER BY n DESC LIMIT 10`).bind(since),
    db.prepare(`SELECT geo k, COUNT(DISTINCT vid) n FROM stats WHERE ts>? GROUP BY geo ORDER BY n DESC LIMIT 15`).bind(since),
    db.prepare(`SELECT settings k, COUNT(*) n FROM stats WHERE ts>? AND kind='visit' GROUP BY settings ORDER BY n DESC LIMIT 10`).bind(since),
    db.prepare(`SELECT decks FROM stats WHERE ts>? AND kind='progress'`).bind(since),
    db.prepare(`SELECT kind k, COUNT(*) n FROM feedback WHERE ts>? GROUP BY kind`).bind(since),
    db.prepare(`SELECT COUNT(*) n FROM scores`),
  ]);
  const decks = {};
  for (const r of rows.results) {
    try {
      for (const [k, x] of Object.entries(JSON.parse(r.decks || "{}"))) {
        const d = (decks[k] ||= { ok: 0, no: 0 });
        d.ok += x.ok || 0;
        d.no += x.no || 0;
      }
    } catch (e) {}
  }
  return {
    days, total: tot.results[0], perDay: perDay.results, devices: dev.results, geo: geo.results,
    settings: set.results, decks, feedback: fbn.results, scores: sc.results[0].n,
  };
}

function csv(rows) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const q = (v) => (v == null ? "" : /[",\n;]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return "\uFEFF" + [cols.join(";"), ...rows.map((r) => cols.map((c) => q(r[c])).join(";"))].join("\n");
}

async function adminApi(req, env, path, url) {
  const db = env.DB;
  if (path === "/admin/api/me") return json({ ok: true });
  if (path === "/admin/api/summary") return json(await adminSummary(env, Math.min(365, int(url.searchParams.get("days")) || 30)));
  if (path === "/admin/api/feedback") {
    const { results } = await db.prepare(`SELECT * FROM feedback ORDER BY id DESC LIMIT 300`).all();
    return json({ rows: results });
  }
  if (path === "/admin/api/scores") {
    const { results } = await db.prepare(`SELECT * FROM scores ORDER BY best DESC, ts ASC LIMIT 200`).all();
    return json({ rows: results });
  }
  if (path === "/admin/api/delete" && req.method === "POST") {
    const b = await body(req);
    if (b.table === "feedback") await db.prepare(`DELETE FROM feedback WHERE id=?`).bind(int(b.id, 1e12)).run();
    else if (b.table === "scores") await db.prepare(`DELETE FROM scores WHERE vid=?`).bind(str(b.vid, 16)).run();
    else return json({ ok: false }, 400);
    return json({ ok: true });
  }
  if (path === "/admin/api/export") {
    const t = url.searchParams.get("table");
    if (!["stats", "feedback", "scores"].includes(t)) return json({ ok: false }, 400);
    const { results } = await db.prepare(`SELECT * FROM ${t} ORDER BY ts DESC LIMIT 50000`).all();
    return new Response(csv(results), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="dojo-${t}.csv"` },
    });
  }
  return json({ ok: false, error: "unbekannt" }, 404);
}

// ---------- Router ----------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      const h = cors(req);
      if (req.method === "OPTIONS")
        return new Response(null, { status: 204, headers: { ...h, "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "86400" } });
      try {
        await ensureSchema(env);
        let r;
        if (path === "/api/stats" && req.method === "POST") r = await postStats(req, env);
        else if (path === "/api/feedback" && req.method === "POST") r = await postFeedback(req, env);
        else if (path === "/api/highscore" && req.method === "GET") r = await getHighscore(env);
        else if (path === "/api/score" && req.method === "POST") r = await postScore(req, env);
        else r = json({ ok: false, error: "unbekannt" }, 404);
        for (const [k, v] of Object.entries(h)) r.headers.set(k, v);
        return r;
      } catch (e) {
        return json({ ok: false, error: "fehler" }, 400, h);
      }
    }

    if (path === "/admin" || path.startsWith("/admin/") || path.startsWith("/admin.")) {
      const why = await checkAdmin(req, env);
      if (why) return denyAdmin(path, why);
      if (path.startsWith("/admin/api/")) {
        try { await ensureSchema(env); return await adminApi(req, env, path, url); }
        catch (e) { return json({ ok: false, error: String(e.message || e) }, 500); }
      }
      if (path !== "/admin") return Response.redirect(new URL("/admin", url), 302);
      // admin.html steckt direkt im Worker (import oben) – unabhängig von den statischen Dateien
      const r = new Response(ADMIN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      r.headers.set("cache-control", "no-store");
      r.headers.set("x-robots-tag", "noindex");
      return r;
    }

    return env.ASSETS.fetch(req);
  },
};
