const WORDS = ["kedi", "masa", "kitap", "kalem", "araba", "pencere", "bardak", "okul"];
const ROUND_LIMIT = 10;

let total = 0;
let correct = 0;
let current = "";
let availableTiles = [];
let selectedTiles = [];
let locked = false;
let telemetry = new window.CognitiveTelemetry("harf-karistirma");
let scoreModal;

function el(id) {
  return document.getElementById(id);
}

function shuffle(items) {
  const shuffled = items.slice();
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function setResult(text, kind) {
  const result = el("result");
  result.textContent = text || "";
  result.classList.remove("ok", "no");
  if (kind) result.classList.add(kind);
}

function updateUi() {
  el("scoreText").textContent = `${correct} / ${ROUND_LIMIT}`;
  el("roundText").textContent = `Tur ${Math.min(total + 1, ROUND_LIMIT)} / ${ROUND_LIMIT}`;
}

function renderTiles() {
  const pool = el("letterPool");
  const answer = el("answerTiles");
  pool.replaceChildren();
  answer.replaceChildren();

  availableTiles.forEach((tile) => {
    const button = createTileButton(tile, "Harfı cevaba ekle");
    button.addEventListener("click", () => {
      if (locked) return;
      availableTiles = availableTiles.filter((item) => item.id !== tile.id);
      selectedTiles.push(tile);
      renderTiles();
    });
    pool.appendChild(button);
  });

  selectedTiles.forEach((tile) => {
    const button = createTileButton(tile, "Harfi havuza geri taşı");
    button.addEventListener("click", () => {
      if (locked) return;
      selectedTiles = selectedTiles.filter((item) => item.id !== tile.id);
      availableTiles.push(tile);
      renderTiles();
    });
    answer.appendChild(button);
  });
}

function createTileButton(tile, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "letter-tile";
  button.textContent = tile.letter.toLocaleUpperCase("tr-TR");
  button.setAttribute("aria-label", `${label}: ${tile.letter}`);
  return button;
}

function newWord() {
  locked = false;
  current = WORDS[Math.floor(Math.random() * WORDS.length)];
  const letters = Array.from(current);
  let shuffledLetters = shuffle(letters);
  for (let attempt = 0; attempt < 10 && shuffledLetters.join("") === current; attempt += 1) {
    shuffledLetters = shuffle(letters);
  }
  availableTiles = shuffledLetters.map((letter, id) => ({ id, letter }));
  selectedTiles = [];
  telemetry.startTrial(current, { scrambled: shuffledLetters.join("") });
  setResult("", null);
  el("checkBtn").disabled = false;
  renderTiles();
  updateUi();
}

function check() {
  if (locked) return;
  locked = true;
  total += 1;

  const answer = selectedTiles.map((tile) => tile.letter).join("");
  const normalizedAnswer = answer.toLocaleLowerCase("tr-TR");
  const isCorrect = normalizedAnswer === current;
  telemetry.recordResponse(
    normalizedAnswer,
    isCorrect,
    isCorrect ? null : window.CognitiveTelemetry.getErrorType(current, normalizedAnswer),
    { selectedTileCount: selectedTiles.length }
  );

  if (isCorrect) {
    correct += 1;
    setResult("Doğru!", "ok");
  } else {
    setResult(`Olmadı. Doğru kelime: ${current.toLocaleUpperCase("tr-TR")}`, "no");
  }

  el("checkBtn").disabled = true;
  renderTiles();
  updateUi();
  window.setTimeout(() => {
    if (total >= ROUND_LIMIT) finishGame();
    else newWord();
  }, 1000);
}

async function saveScore(name) {
  let telemetryError = "";
  try {
    const telemetryResponse = await fetch("/api/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telemetry.getPayload(name, { correct, total }))
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

function finishGame() {
  scoreModal.show(correct, total);
}

window.addEventListener("DOMContentLoaded", () => {
  scoreModal = window.createScoreModal(saveScore);
  el("checkBtn").addEventListener("click", check);
  updateUi();
  newWord();
});
