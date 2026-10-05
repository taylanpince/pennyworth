// Numbered, append-only migrations. Never edit a migration that has shipped.
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE sources (
  id                TEXT PRIMARY KEY,
  source_type       TEXT NOT NULL CHECK (source_type IN ('local_transcript', 'google_drive', 'manual')),
  external_id       TEXT NOT NULL,           -- canonical path or provider file ID
  path              TEXT,
  content_hash      TEXT NOT NULL,           -- sha256 hex
  size              INTEGER,
  revision          INTEGER NOT NULL,        -- 1-based per (source_type, external_id)
  previous_source_id TEXT REFERENCES sources(id),
  created_at        TEXT,
  modified_at       TEXT,
  first_seen_at     TEXT NOT NULL,
  last_processed_at TEXT,
  status            TEXT NOT NULL,
  status_detail     TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  metadata_json     TEXT NOT NULL DEFAULT '{}',
  UNIQUE (source_type, external_id, content_hash)
);
CREATE INDEX sources_status ON sources(status);
CREATE INDEX sources_external ON sources(source_type, external_id, revision);

CREATE TABLE meetings (
  id                  TEXT PRIMARY KEY,
  calendar_provider   TEXT NOT NULL,
  calendar_event_id   TEXT NOT NULL,
  calendar_series_id  TEXT,
  title               TEXT NOT NULL,
  start_at            TEXT NOT NULL,         -- UTC ISO-8601
  end_at              TEXT NOT NULL,         -- UTC ISO-8601
  timezone            TEXT,                  -- event's source timezone
  attendees_json      TEXT NOT NULL DEFAULT '[]',
  match_score         REAL,
  match_status        TEXT NOT NULL CHECK (match_status IN ('matched', 'needs_review', 'unmatched', 'ignored')),
  canonical_note_path TEXT,
  canonical_note_hash TEXT,                  -- hash of the note as last written by us
  extraction_hash     TEXT,
  extraction_json     TEXT,                  -- last validated extraction, reused on retry
  html_link           TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (calendar_provider, calendar_event_id)
);

CREATE TABLE meeting_sources (
  meeting_id TEXT NOT NULL REFERENCES meetings(id),
  source_id  TEXT NOT NULL REFERENCES sources(id),
  linked_at  TEXT NOT NULL,
  link_method TEXT NOT NULL,                 -- auto | manual | carried_forward
  PRIMARY KEY (meeting_id, source_id)
);

CREATE TABLE meeting_targets (
  meeting_id         TEXT NOT NULL REFERENCES meetings(id),
  obsidian_path      TEXT NOT NULL,
  routing_method     TEXT NOT NULL,          -- rule | memory_series | memory_title | topic | manual
  routing_confidence REAL NOT NULL,
  write_status       TEXT NOT NULL,          -- written | exists | obsidian_write_pending | conflict
  written_at         TEXT,
  PRIMARY KEY (meeting_id, obsidian_path)
);

CREATE TABLE match_decisions (
  source_id        TEXT PRIMARY KEY REFERENCES sources(id),
  status           TEXT NOT NULL CHECK (status IN ('matched', 'needs_review', 'unmatched', 'ignored')),
  score            REAL,
  chosen_event_id  TEXT,
  components_json  TEXT NOT NULL DEFAULT '{}',
  explanation      TEXT NOT NULL DEFAULT '',
  candidates_json  TEXT NOT NULL DEFAULT '[]',  -- scored candidate snapshot (incl. event data)
  decided_by       TEXT NOT NULL,              -- matcher | user
  review_issue_id  TEXT,
  decided_at       TEXT NOT NULL
);

CREATE TABLE sync_cursors (
  name       TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE routing_memory (
  key_type     TEXT NOT NULL CHECK (key_type IN ('series', 'title')),
  key          TEXT NOT NULL,
  target       TEXT NOT NULL,                -- vault path, or '' for "no target"
  confirmed_at TEXT NOT NULL,
  PRIMARY KEY (key_type, key, target)
);

CREATE TABLE processing_runs (
  id          TEXT PRIMARY KEY,
  tool        TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,                 -- running | ok | error
  source_ids  TEXT NOT NULL DEFAULT '[]',
  detail_json TEXT NOT NULL DEFAULT '{}'
);

-- Idempotency for Paperclip tasks created by ops-mcp.
CREATE TABLE external_tasks (
  marker       TEXT PRIMARY KEY,             -- e.g. meeting:<event>:action:<hash>
  kind         TEXT NOT NULL,                -- action | meeting_review | routing_review | conflict | system
  issue_id     TEXT,                         -- NULL while creation is pending
  issue_ref    TEXT,                         -- human identifier, e.g. PEN-12
  status       TEXT NOT NULL,                -- open | resolved | pending_create
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
`,
  },
];
