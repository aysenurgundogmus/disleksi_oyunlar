(function () {
  function createScoreModal(onSave) {
    const dialog = document.createElement("dialog");
    dialog.className = "score-modal";

    const title = document.createElement("h2");
    title.textContent = "Tur tamamlandı!";

    const score = document.createElement("p");
    score.className = "score-modal__score";

    const label = document.createElement("label");
    label.className = "score-modal__label";
    label.textContent = "İsim (isteğe bağlı)";

    const nameInput = document.createElement("input");
    nameInput.className = "score-modal__name";
    nameInput.type = "text";
    nameInput.maxLength = 40;
    nameInput.autocomplete = "name";
    label.appendChild(nameInput);

    const status = document.createElement("p");
    status.className = "score-modal__status";
    status.setAttribute("aria-live", "polite");

    const actions = document.createElement("div");
    actions.className = "score-modal__actions";

    const saveButton = document.createElement("button");
    saveButton.type = "button";
    saveButton.className = "score-modal__button score-modal__button--save";
    saveButton.textContent = "Skoru Kaydet";

    const restartButton = document.createElement("button");
    restartButton.type = "button";
    restartButton.className = "score-modal__button";
    restartButton.textContent = "Yeniden Oyna";

    actions.append(saveButton, restartButton);
    dialog.append(title, score, label, status, actions);
    document.body.appendChild(dialog);
    dialog.addEventListener("cancel", (event) => event.preventDefault());

    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      status.textContent = "Kaydediliyor...";
      status.classList.remove("is-error");
      let completed = false;
      try {
        const result = await onSave(nameInput.value.trim());
        status.textContent = result.message;
        status.classList.toggle("is-error", !result.success);
        completed = true;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
        status.classList.add("is-error");
      } finally {
        saveButton.disabled = completed;
      }
    });

    restartButton.addEventListener("click", () => window.location.reload());

    return {
      show(correct, total) {
        score.textContent = `Doğru: ${correct} / ${total}`;
        status.textContent = "";
        status.classList.remove("is-error");
        saveButton.disabled = false;
        if (!dialog.open) dialog.showModal();
      }
    };
  }

  window.createScoreModal = createScoreModal;
})();
