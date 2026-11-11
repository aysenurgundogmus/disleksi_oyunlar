const ROUND_LIMIT = 10;

let questions = [];
let questionDeck = [];
let total = 0;
let correct = 0;
let locked = false;
let current = null;
let telemetry = new window.CognitiveTelemetry("cumle-tamamlama");
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

function renderSentence(sentence) {
  const container = el("sentence");
  const [before, after] = sentence.split("_____");
  container.replaceChildren(document.createTextNode(before));
  const blank = document.createElement("span");
  blank.className = "blank";
  blank.textContent = "_____";
  container.append(blank, document.createTextNode(after));
}

function renderOptions(options) {
  const container = el("options");
  container.replaceChildren();
  options.forEach((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option-btn";
    button.textContent = option;
    button.addEventListener("click", () => choose(option, button));
    container.appendChild(button);
  });
}

function newQuestion() {
  locked = false;
  current = questionDeck[total];
  const options = shuffle(current.options);
  telemetry.startTrial(current.correct, { sentence: current.sentence, options });
  renderSentence(current.sentence);
  renderOptions(options);
  setResult("", null);
  updateUi();
}

function choose(selected, button) {
  if (locked || !current) return;
  locked = true;
  total += 1;
  const isCorrect = selected === current.correct;
  telemetry.recordResponse(selected, isCorrect, isCorrect ? null : "incorrect_selection");

  if (isCorrect) {
    correct += 1;
    button.classList.add("correct");
    setResult("Doğru!", "ok");
  } else {
    button.classList.add("wrong");
    setResult("Bir sonraki soruda tekrar deneyelim.", "no");
    document.querySelectorAll("#options button").forEach((optionButton) => {
      if (optionButton.textContent === current.correct) optionButton.classList.add("correct");
    });
  }

  document.querySelectorAll("#options button").forEach((optionButton) => {
    optionButton.disabled = true;
  });
  updateUi();
  window.setTimeout(() => {
    if (total >= ROUND_LIMIT) finishGame();
    else newQuestion();
  }, 1200);
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

async function loadQuestions() {
  const response = await fetch("questions.json");
  if (!response.ok) throw new Error(`Soru havuzu yüklenemedi (HTTP ${response.status}).`);
  const data = await response.json();
  if (
    !Array.isArray(data) ||
    data.length < ROUND_LIMIT ||
    data.some((question) =>
      typeof question.sentence !== "string" ||
      typeof question.correct !== "string" ||
      !Array.isArray(question.options) ||
      question.options.length < 3 ||
      question.options.length > 4 ||
      !question.options.includes(question.correct) ||
      new Set(question.options).size !== question.options.length ||
      (question.sentence.match(/_____/g) || []).length !== 1
    )
  ) {
    throw new Error("Soru havuzunun biçimi geçersiz.");
  }
  questions = data;
  questionDeck = shuffle(questions);
}

window.addEventListener("DOMContentLoaded", async () => {
  scoreModal = window.createScoreModal(saveScore);
  try {
    await loadQuestions();
    newQuestion();
  } catch (error) {
    console.error("Cümle Tamamlama başlatılamadı:", error);
    setResult("Sorular yüklenemedi. Lütfen sayfayı yenileyin.", "no");
  }
});
