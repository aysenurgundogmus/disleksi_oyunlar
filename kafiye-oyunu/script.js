const RHYME_QUESTIONS = [
  { target: "MASA", correctRhyme: "KASA", distractors: ["KAPI", "KEDİ"] },
  { target: "BABA", correctRhyme: "KABA", distractors: ["KAPI", "KEDİ"] },
  { target: "KEDİ", correctRhyme: "YEDİ", distractors: ["MASA", "KAPI"] },
  { target: "KAPI", correctRhyme: "YAPI", distractors: ["KEDİ", "MASA"] },
  { target: "KİTAP", correctRhyme: "HESAP", distractors: ["KEDİ", "MASA"] },
  { target: "ELMA", correctRhyme: "DALMA", distractors: ["KAPI", "KEDİ"] },
  { target: "KÖPEK", correctRhyme: "ÇÖREK", distractors: ["MASA", "KAPI"] },
];
const ROUND_LIMIT = 10;

let total = 0;
let correct = 0;
let locked = false;
let current = null;
let telemetry = new window.CognitiveTelemetry("kafiye-oyunu");
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

function renderOptions(options) {
  const container = el("options");
  container.replaceChildren();
  options.forEach((text) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option-btn";
    button.textContent = text;
    button.addEventListener("click", () => choose(text, button));
    container.appendChild(button);
  });
}

function newQuestion() {
  locked = false;
  current = RHYME_QUESTIONS[Math.floor(Math.random() * RHYME_QUESTIONS.length)];
  const options = shuffle([current.correctRhyme, ...current.distractors]);
  telemetry.startTrial(current.target, {
    correctRhyme: current.correctRhyme,
    options
  });
  el("targetWord").textContent = current.target;
  renderOptions(options);
  setResult("", null);
  updateUi();
}

function choose(selected, button) {
  if (locked || !current) return;
  locked = true;
  total += 1;
  const isCorrect = selected === current.correctRhyme;
  telemetry.recordResponse(selected, isCorrect, isCorrect ? null : "rhyme_mismatch", {
    correctRhyme: current.correctRhyme,
    selectedRelation: isCorrect ? "rhymes_with_target" : "does_not_rhyme_with_target"
  });

  if (isCorrect) {
    correct += 1;
    button.classList.add("correct");
    setResult("Doğru!", "ok");
  } else {
    button.classList.add("wrong");
    setResult("Yanlış. Doğru kafiye yeşil renkle gösterildi.", "no");
    document.querySelectorAll("#options button").forEach((option) => {
      if (option.textContent === current.correctRhyme) option.classList.add("correct");
    });
  }

  document.querySelectorAll("#options button").forEach((option) => {
    option.disabled = true;
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

window.addEventListener("DOMContentLoaded", () => {
  scoreModal = window.createScoreModal(saveScore);
  newQuestion();
});
