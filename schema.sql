-- Wien / NÖ Dojo + Nihongo Dojo – D1-Schema (legt der Worker beim ersten Aufruf auch selbst an)
-- Jede Tabelle hat zusätzlich die Spalte dojo TEXT NOT NULL DEFAULT 'wien' (wien | nihongo), die der Worker selbst nachrüstet.
CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,          -- Zeitpunkt (ms)
  vid TEXT,                     -- anonyme Besucher-ID aus dem Browser
  kind TEXT,                    -- 'visit' | 'progress'
  settings TEXT,                -- Sprache · Dialekt · Modus · Richtung
  topics TEXT,                  -- lesbare Zusammenfassung
  decks TEXT,                   -- JSON {deck:{ok,no}}
  ok INTEGER, no INTEGER, best INTEGER, rec INTEGER, min INTEGER,
  dev TEXT,                     -- Handy/PC · Quelle
  geo TEXT                      -- Zeitzone · Sprache (keine IP)
);
CREATE INDEX IF NOT EXISTS stats_ts ON stats(ts);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT,                    -- 'feedback' | 'bug' | 'vote'
  rating INTEGER,               -- 1–5 (nur feedback)
  topic TEXT,                   -- gewähltes Thema (nur vote)
  card TEXT,                    -- gemeldete Karte (nur bug)
  text TEXT,
  vid TEXT,
  lang TEXT
);
CREATE INDEX IF NOT EXISTS feedback_ts ON feedback(ts);

CREATE TABLE IF NOT EXISTS scores (
  vid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  best INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS scores_best ON scores(best DESC);
