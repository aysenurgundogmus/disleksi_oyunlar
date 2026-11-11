const WORD_SETS = [
  ["kedi", ["kedi", "kedi̇", "kedi "]],
  ["baba", ["baba", "bada", "baba "]],
  ["dede", ["dede", "dede ", "dedė"]],
  ["pencere", ["pencere", "pencer e", "pencere "]],
  ["kalem", ["kalem", "kaled", "kalem "]],
  ["kitap", ["kitap", "kıtap", "kitap "]],
  ["bardak", ["bardak", "bardak ", "bardap"]],
  ["dost", ["dost", "dost ", "doşt"]]
];

let running = false;
let locked = false;
let timerId = null;
let phaseTimeout = null;
let total = 0;
let correct = 0;
let timeLeft = 45;
let current = null;
let telemetry = new window.CognitiveTelemetry("hizli-kelime-kartlari");
let scoreModal;

function el(id) {
  return document.getElementById(id);
}

function setResult(text, kind) {
  const result = el("result");
  result.textContent = text || "";
  result.classList.remove("ok", "no");
  if (kind) result.classList.add(kind);
}

function updateUi() {
  el("scoreText").textContent = `${correct} / ${total}`;
  el("timeText").textContent = String(timeLeft);
}

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function shuffle(items) {
  const shuffled = items.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function normalizeWord(word) {
  return String(word).normalize("NFC").trim().toLocaleLowerCase("tr-TR");
}

function uniqueWords(words) {
  const seen = new Set();
  return words.filter((word) => {
    const normalized = normalizeWord(word);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function getFlashMs() {
  const value = Number(el("flashMs").value);
  if (!Number.isFinite(value)) return 650;
  return Math.max(150, Math.min(2000, Math.trunc(value)));
}

function renderOptions(options) {
  const container = el("options");
  container.replaceChildren();
  options.forEach((text, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option-btn";
    button.textContent = text;
    button.addEventListener("click", () => choose(index, button));
    container.appendChild(button);
  });
}

function setCard(phase, word, dim = false) {
  el("phaseText").textContent = phase;
  el("wordText").textContent = word;
  el("wordText").style.opacity = dim ? "0.08" : "1";
}

function buildRound() {
  const [target, optionSeeds] = pickRandom(WORD_SETS);
  const wordPool = WORD_SETS.map(([word]) => word);
  const unique = uniqueWords([target, ...optionSeeds, ...wordPool]);
  const options = shuffle(unique.slice(0, 4));
  return {
    target,
    options,
    correctIndex: options.findIndex((option) => normalizeWord(option) === normalizeWord(target))
  };
}

function newRound() {
  if (!running) return;
  if (phaseTimeout) window.clearTimeout(phaseTimeout);

  locked = true;
  current = buildRound();
  telemetry.startTrial(current.target, {
    options: current.options,
    flashMs: getFlashMs()
  });
  setResult("", null);
  renderOptions(["", "", "", ""]);
  document.querySelectorAll("#options button").forEach((button) => {
    button.disabled = true;
  });
  setCard("GÖSTER", current.target, false);

  phaseTimeout = window.setTimeout(() => {
    setCard("SEÇ", "?", true);
    renderOptions(current.options);
    locked = false;
  }, getFlashMs());
}

function choose(index, button) {
  if (!running || locked || !current) return;
  locked = true;
  total += 1;
  const selected = current.options[index];
  const isCorrect = index === current.correctIndex;
  telemetry.recordResponse(
    selected,
    isCorrect,
    isCorrect ? null : window.CognitiveTelemetry.getErrorType(current.target, selected)
  );

  if (isCorrect) {
    correct += 1;
    setResult("Doğru!", "ok");
    button.classList.add("correct");
  } else {
    setResult("Yanlış!", "no");
    button.classList.add("wrong");
    const buttons = Array.from(document.querySelectorAll("#options button"));
    buttons[current.correctIndex]?.classList.add("correct");
  }

  document.querySelectorAll("#options button").forEach((option) => {
    option.disabled = true;
  });
  updateUi();
  phaseTimeout = window.setTimeout(newRound, 650);
}

function start() {
  if (running) return;
  running = true;
  total = 0;
  correct = 0;
  timeLeft = 45;
  telemetry = new window.CognitiveTelemetry("hizli-kelime-kartlari");

  el("startBtn").disabled = true;
  el("stopBtn").disabled = false;
  el("flashMs").disabled = true;
  updateUi();
  setCard("Hazır", "Başladı", false);

  timerId = window.setInterval(() => {
    timeLeft -= 1;
    updateUi();
    if (timeLeft <= 0) stop();
  }, 1000);
  newRound();
}

function stop() {
  if (!running) return;
  running = false;
  locked = true;
  if (timerId) window.clearInterval(timerId);
  timerId = null;
  if (phaseTimeout) window.clearTimeout(phaseTimeout);
  phaseTimeout = null;

  el("startBtn").disabled = false;
  el("stopBtn").disabled = true;
  el("flashMs").disabled = false;
  setCard("Bitti", "Tur tamamlandı", false);
  renderOptions([]);
  setResult("Sonucun hazır.", null);
  scoreModal.show(correct, total);
}

async function saveScore(name) {
  let telemetryError = "";
  try {
    const telemetryResponse = await fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telemetry.getPayload(name, { correct, total, timeLeft }))
    });
    if (!telemetryResponse.ok) throw new Error(`Telemetri HTTP ${telemetryResponse.status}`);
  } catch (error) {
    telemetryError = error instanceof Error ? error.message : String(error);
  }

  const response = await fetch("/api/scores", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: telemetry.sessionId, name, correct, total })
  });
  if (!response.ok) throw new Error(`Skor kaydedilemedi (HTTP ${response.status}).`);

  return telemetryError
    ? { success: false, message: `Skor kaydedildi; telemetri kaydedilemedi: ${telemetryError}` }
    : { success: true, message: "Skor ve oyun verisi kaydedildi." };
}

window.addEventListener("DOMContentLoaded", () => {
  scoreModal = window.createScoreModal(saveScore);
  el("startBtn").addEventListener("click", start);
  el("stopBtn").addEventListener("click", stop);
  updateUi();
});
