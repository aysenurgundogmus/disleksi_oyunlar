import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getScores, openDatabase, saveScore, saveTelemetry } from "./database.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 5500;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname;
const db = openDatabase();
const GAME_DIRS = new Map([
  ["ses-avi-oyunu", path.join(ROOT_DIR, "ses-avi-oyunu")],
  ["hizli-kelime-kartlari", path.join(ROOT_DIR, "hizli-kelime-kartlari")],
  ["kafiye-oyunu", path.join(ROOT_DIR, "kafiye-oyunu")],
  ["harf-karistirma", path.join(ROOT_DIR, "harf-karistirma")],
  ["hikaye-tamamlama", path.join(ROOT_DIR, "hikaye-tamamlama")]
]);
function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function sendJson(res, status, data) {
  const body = Buffer.from(`${JSON.stringify(data)}\n`, "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendText(res, status, text) {
  const body = Buffer.from(String(text ?? ""), "utf8");
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  return "application/octet-stream";
}

async function readJsonBody(req, { limitBytes = 32 * 1024 } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function safeJoinPublic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const clean = decoded.split("?")[0].split("#")[0];
  if (clean === "/" || clean === "/index.html") {
    return path.join(ROOT_DIR, "index.html");
  }
  if (["/telemetry.js", "/score-modal.js", "/score-modal.css", "/game-layout.css"].includes(clean)) {
    return path.join(ROOT_DIR, clean.slice(1));
  }

  const [game, ...parts] = clean.split("/").filter(Boolean);
  const baseDir = GAME_DIRS.get(game);
  if (!baseDir) return null;

  const rel = parts.length ? parts.join("/") : "index.html";
  const resolvedBase = path.resolve(baseDir);
  const resolvedFile = path.resolve(resolvedBase, rel);
  if (!resolvedFile.startsWith(`${resolvedBase}${path.sep}`)) return null;
  return resolvedFile;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname || "/";

    // API
    if (pathname === "/api/health" && req.method === "GET") {
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === "/api/scores" && req.method === "GET") {
      const limit = clampInt(url.searchParams.get("limit"), 1, 50);
      return sendJson(res, 200, getScores(db, limit));
    }

    if (pathname === "/api/scores" && req.method === "POST") {
      let body = null;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        if (String(e?.message) === "PAYLOAD_TOO_LARGE") {
          return sendJson(res, 413, { error: "Payload too large" });
        }
        return sendJson(res, 400, { error: "Invalid JSON" });
      }

      if (body !== null && (typeof body !== "object" || Array.isArray(body))) {
        return sendJson(res, 400, { error: "Invalid score payload" });
      }
      try {
        return sendJson(res, 201, saveScore(db, body || {}));
      } catch (error) {
        console.error("Score database write failed:", error);
        return sendJson(res, 500, { error: "Could not save score" });
      }
    }

    if (pathname === "/api/telemetry" && req.method === "POST") {
      let payload;
      try {
        payload = await readJsonBody(req, { limitBytes: 1024 * 1024 });
      } catch (e) {
        if (String(e?.message) === "PAYLOAD_TOO_LARGE") {
          return sendJson(res, 413, { error: "Payload too large" });
        }
        return sendJson(res, 400, { error: "Invalid JSON" });
      }

      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        typeof payload.sessionId !== "string" ||
        !payload.sessionId.trim() ||
        !Array.isArray(payload.trials) ||
        payload.trials.length > 10_000 ||
        payload.trials.some((trial) => !trial || typeof trial !== "object" || Array.isArray(trial))
      ) {
        return sendJson(res, 400, { error: "Invalid telemetry payload" });
      }

      try {
        saveTelemetry(db, payload);
      } catch (error) {
        console.error("Telemetry database write failed:", error);
        return sendJson(res, 500, { error: "Could not save telemetry" });
      }
      return sendJson(res, 201, { ok: true, sessionId: payload.sessionId });
    }

    // Static
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendText(res, 405, "Method Not Allowed");
    }

    const filePath = safeJoinPublic(pathname);
    if (!filePath) return sendText(res, 404, "Not Found");

    let data;
    try {
      data = await fs.readFile(filePath);
    } catch {
      return sendText(res, 404, "Not Found");
    }

    res.writeHead(200, {
      "Content-Type": getContentType(filePath),
      "Content-Length": data.length
    });
    if (req.method === "HEAD") return res.end();
    return res.end(data);
  } catch {
    return sendJson(res, 500, { error: "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Server hazır: http://127.0.0.1:${PORT}/`);
});
