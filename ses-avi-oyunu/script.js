// Mikrofon YOK. Sadece ses çıkışı: speechSynthesis

const LETTERS = ["b", "d", "p", "q"];
const ROUND_LIMIT = 10;

let currentLetter = "";
let locked = false;
let nextTimer = null;

let total = 0;
let correct = 0;
let telemetry = new window.CognitiveTelemetry("ses-avi-oyunu");
let scoreModal;

function setDebug(lines) {
  const el = document.getElementById("debugInfo");
  if (!el) return;
  el.textContent = lines.join("\n");
}

function updateScoreUi() {
  const el = document.getElementById("scoreText");
  if (!el) return;
  el.textContent = `${correct} / ${ROUND_LIMIT}`;
}

function startTelemetryTrial(target, metadata) {
  telemetry.startTrial(target, metadata);
}

function getEnvDebug() {
  const inIframe = (() => {
    try {
      return window.top !== window.self;
    } catch {
      return true;
    }
  })();

  return [
    `URL: ${location.href}`,
    `userAgent: ${navigator.userAgent}`,
    `secureContext: ${String(window.isSecureContext)}`,
    `inIframe/webview: ${String(inIframe)}`,
  ];
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function setResult(text, kind) {
  const el = document.getElementById("result");
  el.textContent = text;
  el.classList.remove("ok", "no");
  if (kind) el.classList.add(kind);
}

function buildOptions(correct) {
  const options = [correct];
  while (options.length < 3) {
    const candidate = pickRandom(LETTERS);
    if (!options.includes(candidate)) options.push(candidate);
  }
  return shuffle(options);
}

function renderOptions(options) {
  const optionsDiv = document.getElementById("options");
  optionsDiv.innerHTML = "";

  options.forEach((letter) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "option-btn";
    btn.textContent = letter;
    btn.addEventListener("click", () => choose(letter, btn));
    optionsDiv.appendChild(btn);
  });
}

function newRound() {
  if (nextTimer) {
    clearTimeout(nextTimer);
    nextTimer = null;
  }
  locked = false;
  currentLetter = pickRandom(LETTERS);
  const options = buildOptions(currentLetter);
  startTelemetryTrial(currentLetter, { options });
  renderOptions(options);
  setResult("", null);
  playLetterSound(currentLetter);
}

function playLetterSound(letter) {
  if (!letter) return;
  if (!("speechSynthesis" in window)) {
    setResult("Tarayıcıda sesli okuma desteklenmiyor.", "no");
    return;
  }

  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(`Harf: ${letter}`);
  utterance.lang = "tr-TR";
  utterance.rate = 0.85;
  window.speechSynthesis.speak(utterance);
}

function choose(selected, btn) {
  if (locked) return;
  locked = true;

  document.querySelectorAll("#options button").forEach((b) => {
    b.disabled = true;
  });

  total += 1;
  const isCorrect = selected === currentLetter;
  telemetry.recordResponse(
    selected,
    isCorrect,
    isCorrect ? null : window.CognitiveTelemetry.getErrorType(currentLetter, selected)
  );
  if (isCorrect) {
    correct += 1;
    setResult("Doğru!", "ok");
    btn.classList.add("correct");
  } else {
    setResult("Yanlış!", "no");
    btn.classList.add("wrong");
  }

  updateScoreUi();
  nextTimer = setTimeout(() => {
    if (total >= ROUND_LIMIT) finishGame();
    else newRound();
  }, 1000);
}

async function saveScore(name) {
  let telemetryError = "";
  try {
    const telemetryRes = await fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telemetry.getPayload(name, { correct, total }))
    });
    if (!telemetryRes.ok) throw new Error(`Telemetri HTTP ${telemetryRes.status}`);
  } catch (error) {
    telemetryError = error instanceof Error ? error.message : String(error);
  }

  const res = await fetch("/api/scores", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: telemetry.sessionId, name, correct, total })
  });
  if (!res.ok) throw new Error(`Skor kaydedilemedi (HTTP ${res.status}).`);

  return telemetryError
    ? { success: false, message: `Skor kaydedildi; telemetri kaydedilemedi: ${telemetryError}` }
    : { success: true, message: "Skor ve oyun verisi kaydedildi." };
}

function finishGame() {
  locked = true;
  scoreModal.show(correct, total);
}

window.addEventListener("DOMContentLoaded", () => {
  scoreModal = window.createScoreModal(saveScore);
  document.getElementById("listenBtn").addEventListener("click", () => {
    if (locked) return;
    playLetterSound(currentLetter);
  });

  setDebug([
    `speechSynthesis: ${"speechSynthesis" in window ? "VAR" : "YOK"}`,
    "Ses modu: Web Speech API",
    "Dil: tr-TR",
    "Hız: 0.85",
    ...getEnvDebug(),
    "",
    "Çalıştırma:",
    "Backend (Python): python3 app.py",
    "Backend (Node): node server.js",
    "Sadece statik: python3 -m http.server 5500",
    "Tarayıcı:",
    "http://127.0.0.1:5500/",
  ]);

  // If we're inside an iframe/webview, warn early.
  const inIframe = (() => {
    try {
      return window.top !== window.self;
    } catch {
      return true;
    }
  })();
  if (inIframe) {
    setResult(
      "Not: Önizleme/WebView ses çıkışını engelleyebilir. Harici tarayıcıda aç.",
      "no"
    );
  }

  updateScoreUi();
  newRound();
});
