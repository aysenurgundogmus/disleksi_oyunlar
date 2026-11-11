import json
import os
import posixpath
import sqlite3
import uuid
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT_DIR = Path(__file__).resolve().parent
SES_AVI_DIR = ROOT_DIR / "ses-avi-oyunu"
KELIME_KART_DIR = ROOT_DIR / "hizli-kelime-kartlari"
KAFIYE_DIR = ROOT_DIR / "kafiye-oyunu"
HARF_KARISTIRMA_DIR = ROOT_DIR / "harf-karistirma"
HIKAYE_TAMAMLAMA_DIR = ROOT_DIR / "hikaye-tamamlama"
DATA_DIR = ROOT_DIR / "data"
SCORES_FILE = DATA_DIR / "scores.json"
TELEMETRY_FILE = DATA_DIR / "telemetry_sessions.jsonl"
DATABASE_FILE = Path(os.environ.get("DATABASE_PATH", DATA_DIR / "games.sqlite3"))


SCHEMA = """
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
"""


def connect_database() -> sqlite3.Connection:
    connection = sqlite3.connect(DATABASE_FILE, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


def json_value(value):
    if value is None:
        return None
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def read_legacy_scores() -> list[dict]:
    if not SCORES_FILE.exists():
        return []
    scores = json.loads(SCORES_FILE.read_text(encoding="utf-8") or "[]")
    if not isinstance(scores, list):
        raise ValueError("Legacy scores file must contain a JSON array.")
    return scores


def read_legacy_telemetry() -> list[dict]:
    if not TELEMETRY_FILE.exists():
        return []
    sessions = []
    for line_number, line in enumerate(TELEMETRY_FILE.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            sessions.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid legacy telemetry JSON on line {line_number}.") from exc
    return sessions


def migrate_legacy_files(connection: sqlite3.Connection) -> None:
    if connection.execute(
        "SELECT 1 FROM schema_migrations WHERE name = ?",
        ("import-json-files-v1",),
    ).fetchone():
        return

    scores = read_legacy_scores()
    sessions = read_legacy_telemetry()
    with connection:
        for index, score in enumerate(scores, 1):
            score_id = str(score.get("id") or f"legacy-score-{index}")
            created_at = str(score.get("createdAt") or datetime.now(timezone.utc).isoformat())
            session_id = f"legacy-score-{score_id}"
            correct = max(0, int(score.get("correct") or 0))
            total = max(0, int(score.get("total") or 0))
            connection.execute(
                """
                INSERT OR IGNORE INTO sessions
                    (id, game_id, user_name, started_at, submitted_at, score_data_json)
                VALUES (?, 'legacy-score', ?, ?, ?, ?)
                """,
                (session_id, score.get("name"), created_at, created_at,
                 json.dumps({"correct": correct, "total": total})),
            )
            connection.execute(
                """
                INSERT OR IGNORE INTO scores (id, session_id, name, correct, total, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (score_id, session_id, str(score.get("name") or "Anonim"),
                 correct, total, created_at),
            )

        for session_index, session in enumerate(sessions, 1):
            if not isinstance(session, dict):
                continue
            session_id = str(session.get("sessionId") or f"legacy-telemetry-{session_index}")
            started_at = str(session.get("startedAt") or session.get("submittedAt") or datetime.now(timezone.utc).isoformat())
            submitted_at = str(session.get("submittedAt") or started_at)
            connection.execute(
                """
                INSERT OR IGNORE INTO sessions
                    (id, game_id, user_name, started_at, submitted_at, score_data_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (session_id, str(session.get("gameId") or "unknown"),
                 session.get("userName"), started_at, submitted_at,
                 json_value(session.get("scoreData"))),
            )
            trials = session.get("trials", [])
            if not isinstance(trials, list):
                continue
            for trial_index, trial in enumerate(trials, 1):
                if not isinstance(trial, dict):
                    continue
                try:
                    reaction_time = float(trial["reactionTimeMs"])
                except (KeyError, TypeError, ValueError):
                    reaction_time = None
                connection.execute(
                    """
                    INSERT OR IGNORE INTO trials (
                        session_id, trial_index, target, selected, is_correct,
                        reaction_time_ms, error_type, timestamp, metadata_json,
                        response_metadata_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        session_id,
                        max(1, int(trial.get("trialIndex") or trial_index)),
                        json_value(trial.get("target")),
                        json_value(trial.get("selected")),
                        int(bool(trial.get("isCorrect"))),
                        reaction_time,
                        trial.get("errorType"),
                        str(trial.get("timestamp") or submitted_at),
                        json_value(trial.get("metadata")),
                        json_value(trial.get("responseMetadata")),
                    ),
                )
        connection.execute(
            "INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
            ("import-json-files-v1", datetime.now(timezone.utc).isoformat()),
        )


def initialize_database() -> None:
    DATABASE_FILE.parent.mkdir(parents=True, exist_ok=True)
    connection = connect_database()
    try:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(SCHEMA)
        migrate_legacy_files(connection)
    finally:
        connection.close()


def save_telemetry(payload: dict) -> None:
    now = datetime.now(timezone.utc).isoformat()
    started_at = str(payload.get("startedAt") or now)
    submitted_at = str(payload.get("submittedAt") or now)
    connection = connect_database()
    try:
        with connection:
            connection.execute(
                """
                INSERT INTO sessions
                    (id, game_id, user_name, started_at, submitted_at, score_data_json)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    game_id = excluded.game_id,
                    user_name = COALESCE(excluded.user_name, sessions.user_name),
                    submitted_at = excluded.submitted_at,
                    score_data_json = COALESCE(excluded.score_data_json, sessions.score_data_json)
                """,
                (
                    payload["sessionId"],
                    str(payload.get("gameId") or "unknown"),
                    payload.get("userName"),
                    started_at,
                    submitted_at,
                    json_value(payload.get("scoreData")),
                ),
            )
            for index, trial in enumerate(payload["trials"], 1):
                if not isinstance(trial, dict):
                    continue
                try:
                    reaction_time = float(trial["reactionTimeMs"])
                except (KeyError, TypeError, ValueError):
                    reaction_time = None
                connection.execute(
                    """
                    INSERT INTO trials (
                        session_id, trial_index, target, selected, is_correct,
                        reaction_time_ms, error_type, timestamp, metadata_json,
                        response_metadata_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(session_id, trial_index) DO UPDATE SET
                        target = excluded.target,
                        selected = excluded.selected,
                        is_correct = excluded.is_correct,
                        reaction_time_ms = excluded.reaction_time_ms,
                        error_type = excluded.error_type,
                        timestamp = excluded.timestamp,
                        metadata_json = excluded.metadata_json,
                        response_metadata_json = excluded.response_metadata_json
                    """,
                    (
                        payload["sessionId"],
                        max(1, int(trial.get("trialIndex") or index)),
                        json_value(trial.get("target")),
                        json_value(trial.get("selected")),
                        int(bool(trial.get("isCorrect"))),
                        reaction_time,
                        trial.get("errorType"),
                        str(trial.get("timestamp") or submitted_at),
                        json_value(trial.get("metadata")),
                        json_value(trial.get("responseMetadata")),
                    ),
                )
    finally:
        connection.close()


def save_score(payload: dict) -> dict:
    score_id = str(uuid.uuid4())
    session_id = str(payload.get("sessionId") or uuid.uuid4())
    created_at = datetime.now(timezone.utc).isoformat()
    name = sanitize_name(payload.get("name"))
    correct = clamp_int(payload.get("correct"), 0, 10_000)
    total = clamp_int(payload.get("total"), 0, 10_000)
    connection = connect_database()
    try:
        with connection:
            connection.execute(
                """
                INSERT INTO sessions
                    (id, game_id, user_name, started_at, submitted_at, score_data_json)
                VALUES (?, 'score-only', ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    user_name = COALESCE(excluded.user_name, sessions.user_name),
                    submitted_at = excluded.submitted_at,
                    score_data_json = excluded.score_data_json
                """,
                (session_id, name, created_at, created_at,
                 json.dumps({"correct": correct, "total": total})),
            )
            connection.execute(
                """
                INSERT INTO scores (id, session_id, name, correct, total, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (score_id, session_id, name, correct, total, created_at),
            )
        return {
            "id": score_id,
            "sessionId": session_id,
            "name": name,
            "correct": correct,
            "total": total,
            "createdAt": created_at,
        }
    finally:
        connection.close()


def clamp_int(value, min_v: int, max_v: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return min_v
    return max(min_v, min(max_v, n))


def sanitize_name(name) -> str:
    s = str(name or "").strip()[:40]
    return s if s else "Anonim"


class Handler(SimpleHTTPRequestHandler):
    # Serve files from allowed game folders + root index.html
    def translate_path(self, path: str) -> str:
        parsed = urlparse(path)
        req_path = parsed.path
        if req_path in ("", "/"):
            return str((ROOT_DIR / "index.html").resolve())
        shared_files = {
            "/telemetry.js",
            "/score-modal.js",
            "/score-modal.css",
            "/game-layout.css",
        }
        if req_path in shared_files:
            return str((ROOT_DIR / req_path.lstrip("/")).resolve())

        # prevent path traversal
        req_path = posixpath.normpath(req_path)
        req_path = req_path.lstrip("/")

        # Routing:
        # /ses-avi-oyunu/... -> SES_AVI_DIR
        # /hizli-kelime-kartlari/... -> KELIME_KART_DIR
        # Only known game folders and shared files are exposed.
        if req_path.startswith("ses-avi-oyunu/") or req_path == "ses-avi-oyunu":
            rel = req_path[len("ses-avi-oyunu") :].lstrip("/")
            if rel == "":
                rel = "index.html"
            base = SES_AVI_DIR
        elif req_path.startswith("hizli-kelime-kartlari/") or req_path == "hizli-kelime-kartlari":
            rel = req_path[len("hizli-kelime-kartlari") :].lstrip("/")
            if rel == "":
                rel = "index.html"
            base = KELIME_KART_DIR
        elif req_path.startswith("kafiye-oyunu/") or req_path == "kafiye-oyunu":
            rel = req_path[len("kafiye-oyunu") :].lstrip("/")
            if rel == "":
                rel = "index.html"
            base = KAFIYE_DIR
        elif req_path.startswith("harf-karistirma/") or req_path == "harf-karistirma":
            rel = req_path[len("harf-karistirma") :].lstrip("/")
            if rel == "":
                rel = "index.html"
            base = HARF_KARISTIRMA_DIR
        elif req_path.startswith("hikaye-tamamlama/") or req_path == "hikaye-tamamlama":
            rel = req_path[len("hikaye-tamamlama") :].lstrip("/")
            if rel == "":
                rel = "index.html"
            base = HIKAYE_TAMAMLAMA_DIR
        else:
            return str((ROOT_DIR / "__not_found__").resolve())

        full = (base / rel).resolve()
        try:
            full.relative_to(base.resolve())
        except ValueError:
            return str((base / "index.html").resolve())
        return str(full)

    def _send_json(self, status: int, obj) -> None:
        body = (json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self, limit_bytes: int = 32 * 1024):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return None
        if length > limit_bytes:
            raise ValueError("PAYLOAD_TOO_LARGE")
        raw = self.rfile.read(length).decode("utf-8", errors="replace")
        return json.loads(raw)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            return self._send_json(200, {"ok": True})

        if parsed.path == "/api/scores":
            qs = parse_qs(parsed.query or "")
            limit = clamp_int((qs.get("limit") or ["20"])[0], 1, 50)
            connection = connect_database()
            try:
                scores = connection.execute(
                    """
                    SELECT id, session_id AS sessionId, name, correct, total,
                           created_at AS createdAt
                    FROM scores
                    ORDER BY correct DESC, total DESC, created_at DESC
                    LIMIT ?
                    """,
                    (limit,),
                ).fetchall()
                return self._send_json(200, [dict(score) for score in scores])
            finally:
                connection.close()

        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/telemetry":
            try:
                body = self._read_json_body(limit_bytes=1024 * 1024)
            except ValueError as exc:
                if str(exc) == "PAYLOAD_TOO_LARGE":
                    return self._send_json(413, {"error": "Payload too large"})
                raise
            except json.JSONDecodeError:
                return self._send_json(400, {"error": "Invalid JSON"})

            if (
                not isinstance(body, dict)
                or not isinstance(body.get("sessionId"), str)
                or not body["sessionId"].strip()
                or not isinstance(body.get("trials"), list)
                or len(body["trials"]) > 10_000
                or any(not isinstance(trial, dict) for trial in body["trials"])
            ):
                return self._send_json(400, {"error": "Invalid telemetry payload"})

            try:
                save_telemetry(body)
            except sqlite3.Error as exc:
                self.log_error("Telemetry database write failed: %s", exc)
                return self._send_json(500, {"error": "Could not save telemetry"})
            return self._send_json(201, {"ok": True, "sessionId": body["sessionId"]})

        if parsed.path != "/api/scores":
            self.send_error(404, "Not Found")
            return

        try:
            body = self._read_json_body()
        except ValueError as exc:
            if str(exc) == "PAYLOAD_TOO_LARGE":
                return self._send_json(413, {"error": "Payload too large"})
            raise
        except json.JSONDecodeError:
            return self._send_json(400, {"error": "Invalid JSON"})

        if body is not None and not isinstance(body, dict):
            return self._send_json(400, {"error": "Invalid score payload"})
        try:
            entry = save_score(body or {})
        except sqlite3.Error as exc:
            self.log_error("Score database write failed: %s", exc)
            return self._send_json(500, {"error": "Could not save score"})
        return self._send_json(201, entry)


def main() -> None:
    initialize_database()
    start_port = int(os.environ.get("PORT", "5500"))
    httpd = None

    # If the port is busy, automatically try the next ports.
    for port in range(start_port, start_port + 25): 
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError as e:
            if getattr(e, "errno", None) != 98:  # 98 = Address already in use (Linux)
                raise

    if httpd is None:
        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)

    port = httpd.server_address[1]
    print(f"Server hazır: http://127.0.0.1:{port}/", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
