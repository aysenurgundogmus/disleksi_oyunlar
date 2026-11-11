import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT_DIR, "data");
const DATABASE_FILE = process.env.DATABASE_PATH || path.join(DATA_DIR, "games.sqlite3");
const LEGACY_SCORES_FILE = path.join(DATA_DIR, "scores.json");
const LEGACY_TELEMETRY_FILE = path.join(DATA_DIR, "telemetry_sessions.jsonl");

function readLegacyScores() {
  if (!fs.existsSync(LEGACY_SCORES_FILE)) return [];
  const parsed = JSON.parse(fs.readFileSync(LEGACY_SCORES_FILE, "utf8") || "[]");
  if (!Array.isArray(parsed)) throw new Error("Legacy scores file must contain a JSON array.");
  return parsed;
}

function readLegacyTelemetry() {
  if (!fs.existsSync(LEGACY_TELEMETRY_FILE)) return [];
  return fs.readFileSync(LEGACY_TELEMETRY_FILE, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid legacy telemetry JSON on line ${index + 1}.`, { cause: error });
      }
    });
}

function jsonValue(value) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function createSchema(db) {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      game_id TEXT NOT NULL,
      user_name TEXT,
      started_at TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      score_data_json TEXT
    );
    CREATE TABLE IF NOT EXISTS scores (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      name TEXT NOT NULL,
      correct INTEGER NOT NULL CHECK (correct >= 0),
      total INTEGER NOT NULL CHECK (total >= 0),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trials (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      trial_index INTEGER NOT NULL CHECK (trial_index > 0),
      target TEXT,
      selected TEXT,
      is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
      reaction_time_ms REAL,
      error_type TEXT,
      timestamp TEXT NOT NULL,
      metadata_json TEXT,
      response_metadata_json TEXT,
      UNIQUE (session_id, trial_index)
    );
    CREATE INDEX IF NOT EXISTS scores_created_at_idx ON scores(created_at);
    CREATE INDEX IF NOT EXISTS scores_session_id_idx ON scores(session_id);
    CREATE INDEX IF NOT EXISTS trials_session_id_idx ON trials(session_id);
    CREATE INDEX IF NOT EXISTS trials_error_type_idx ON trials(error_type);
    CREATE INDEX IF NOT EXISTS trials_timestamp_idx ON trials(timestamp);
  `);
}

function migrateLegacyFiles(db) {
  const migration = db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?");
  if (migration.get("import-json-files-v1")) return;

  const legacyScores = readLegacyScores();
  const legacySessions = readLegacyTelemetry();
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, game_id, user_name, started_at, submitted_at, score_data_json)
    VALUES (@id, @game_id, @user_name, @started_at, @submitted_at, @score_data_json)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertScore = db.prepare(`
    INSERT INTO scores (id, session_id, name, correct, total, created_at)
    VALUES (@id, @session_id, @name, @correct, @total, @created_at)
    ON CONFLICT(id) DO NOTHING
  `);
  const insertTrial = db.prepare(`
    INSERT INTO trials (
      session_id, trial_index, target, selected, is_correct, reaction_time_ms,
      error_type, timestamp, metadata_json, response_metadata_json
    ) VALUES (
      @session_id, @trial_index, @target, @selected, @is_correct, @reaction_time_ms,
      @error_type, @timestamp, @metadata_json, @response_metadata_json
    )
    ON CONFLICT(session_id, trial_index) DO NOTHING
  `);

  db.transaction(() => {
    for (const [index, score] of legacyScores.entries()) {
      const scoreId = String(score.id || `legacy-score-${index + 1}`);
      const createdAt = String(score.createdAt || new Date().toISOString());
      const sessionId = `legacy-score-${scoreId}`;
      insertSession.run({
        id: sessionId,
        game_id: "legacy-score",
        user_name: score.name ?? null,
        started_at: createdAt,
        submitted_at: createdAt,
        score_data_json: JSON.stringify({
          correct: Number(score.correct) || 0,
          total: Number(score.total) || 0
        })
      });
      insertScore.run({
        id: scoreId,
        session_id: sessionId,
        name: String(score.name || "Anonim"),
        correct: Math.max(0, Math.trunc(Number(score.correct) || 0)),
        total: Math.max(0, Math.trunc(Number(score.total) || 0)),
        created_at: createdAt
      });
    }

    for (const [sessionIndex, session] of legacySessions.entries()) {
      if (!session || typeof session !== "object" || Array.isArray(session)) continue;
      const sessionId = String(session.sessionId || `legacy-telemetry-${sessionIndex + 1}`);
      const startedAt = String(session.startedAt || session.submittedAt || new Date().toISOString());
      const submittedAt = String(session.submittedAt || startedAt);
      insertSession.run({
        id: sessionId,
        game_id: String(session.gameId || "unknown"),
        user_name: session.userName ?? null,
        started_at: startedAt,
        submitted_at: submittedAt,
        score_data_json: jsonValue(session.scoreData)
      });

      const trials = Array.isArray(session.trials) ? session.trials : [];
      for (const [trialIndex, trial] of trials.entries()) {
        if (!trial || typeof trial !== "object" || Array.isArray(trial)) continue;
        insertTrial.run({
          session_id: sessionId,
          trial_index: Math.max(1, Math.trunc(Number(trial.trialIndex) || trialIndex + 1)),
          target: jsonValue(trial.target),
          selected: jsonValue(trial.selected),
          is_correct: trial.isCorrect ? 1 : 0,
          reaction_time_ms: Number.isFinite(Number(trial.reactionTimeMs))
            ? Number(trial.reactionTimeMs)
            : null,
          error_type: trial.errorType ?? null,
          timestamp: String(trial.timestamp || submittedAt),
          metadata_json: jsonValue(trial.metadata),
          response_metadata_json: jsonValue(trial.responseMetadata)
        });
      }
    }

    db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)")
      .run("import-json-files-v1", new Date().toISOString());
  })();
}

export function openDatabase() {
  fs.mkdirSync(path.dirname(DATABASE_FILE), { recursive: true });
  const db = new Database(DATABASE_FILE);
  createSchema(db);
  migrateLegacyFiles(db);
  return db;
}

export function serializeTelemetryValue(value) {
  return jsonValue(value);
}

export function saveTelemetry(db, payload) {
  const now = new Date().toISOString();
  const submittedAt = String(payload.submittedAt || now);
  const startedAt = String(payload.startedAt || submittedAt);
  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO sessions (id, game_id, user_name, started_at, submitted_at, score_data_json)
      VALUES (@id, @game_id, @user_name, @started_at, @submitted_at, @score_data_json)
      ON CONFLICT(id) DO UPDATE SET
        game_id = excluded.game_id,
        user_name = COALESCE(excluded.user_name, sessions.user_name),
        submitted_at = excluded.submitted_at,
        score_data_json = COALESCE(excluded.score_data_json, sessions.score_data_json)
    `).run({
      id: payload.sessionId,
      game_id: String(payload.gameId || "unknown"),
      user_name: payload.userName ?? null,
      started_at: startedAt,
      submitted_at: submittedAt,
      score_data_json: jsonValue(payload.scoreData)
    });

    const insertTrial = db.prepare(`
      INSERT INTO trials (
        session_id, trial_index, target, selected, is_correct, reaction_time_ms,
        error_type, timestamp, metadata_json, response_metadata_json
      ) VALUES (
        @session_id, @trial_index, @target, @selected, @is_correct, @reaction_time_ms,
        @error_type, @timestamp, @metadata_json, @response_metadata_json
      )
      ON CONFLICT(session_id, trial_index) DO UPDATE SET
        target = excluded.target,
        selected = excluded.selected,
        is_correct = excluded.is_correct,
        reaction_time_ms = excluded.reaction_time_ms,
        error_type = excluded.error_type,
        timestamp = excluded.timestamp,
        metadata_json = excluded.metadata_json,
        response_metadata_json = excluded.response_metadata_json
    `);

    payload.trials.forEach((trial, index) => {
      insertTrial.run({
        session_id: payload.sessionId,
        trial_index: Math.max(1, Math.trunc(Number(trial.trialIndex) || index + 1)),
        target: jsonValue(trial.target),
        selected: jsonValue(trial.selected),
        is_correct: trial.isCorrect ? 1 : 0,
        reaction_time_ms: Number.isFinite(Number(trial.reactionTimeMs))
          ? Number(trial.reactionTimeMs)
          : null,
        error_type: trial.errorType ?? null,
        timestamp: String(trial.timestamp || submittedAt),
        metadata_json: jsonValue(trial.metadata),
        response_metadata_json: jsonValue(trial.responseMetadata)
      });
    });
  });
  save();
}

export function saveScore(db, payload) {
  const id = randomUUID();
  const sessionId = String(payload.sessionId || randomUUID());
  const name = String(payload.name ?? "").trim().slice(0, 40) || "Anonim";
  const correct = Math.max(0, Math.min(10_000, Math.trunc(Number(payload.correct) || 0)));
  const total = Math.max(0, Math.min(10_000, Math.trunc(Number(payload.total) || 0)));
  const createdAt = new Date().toISOString();
  const save = db.transaction(() => {
    db.prepare(`
      INSERT INTO sessions (id, game_id, user_name, started_at, submitted_at, score_data_json)
      VALUES (@id, 'score-only', @user_name, @now, @now, @score_data_json)
      ON CONFLICT(id) DO UPDATE SET
        user_name = COALESCE(excluded.user_name, sessions.user_name),
        submitted_at = excluded.submitted_at,
        score_data_json = excluded.score_data_json
    `).run({
      id: sessionId,
      user_name: name,
      now: createdAt,
      score_data_json: JSON.stringify({ correct, total })
    });
    db.prepare(`
      INSERT INTO scores (id, session_id, name, correct, total, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sessionId, name, correct, total, createdAt);
  });
  save();
  return { id, sessionId, name, correct, total, createdAt };
}

export function getScores(db, limit) {
  return db.prepare(`
    SELECT id, session_id AS sessionId, name, correct, total, created_at AS createdAt
    FROM scores
    ORDER BY correct DESC, total DESC, created_at DESC
    LIMIT ?
  `).all(limit);
}
