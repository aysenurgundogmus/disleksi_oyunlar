(function () {
  class CognitiveTelemetry {
    constructor(gameId) {
      this.gameId = gameId;
      this.sessionId = this.createSessionId();
      this.startedAt = new Date().toISOString();
      this.trials = [];
      this.nextTrialIndex = 1;
      this.activeTrial = null;
    }

    createSessionId() {
      if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();

      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }

    startTrial(targetStimulus, metadata = {}) {
      this.activeTrial = {
        trialIndex: this.nextTrialIndex++,
        target: targetStimulus,
        metadata,
        startedAt: performance.now()
      };
    }

    recordResponse(selectedStimulus, isCorrect, errorType = null, responseMetadata = {}) {
      if (!this.activeTrial) return null;

      const { trialIndex, target, metadata, startedAt } = this.activeTrial;
      const trial = {
        trialIndex,
        target,
        selected: selectedStimulus,
        isCorrect: Boolean(isCorrect),
        reactionTimeMs: Math.round((performance.now() - startedAt) * 100) / 100,
        errorType: isCorrect ? null : errorType,
        timestamp: new Date().toISOString(),
        metadata,
        responseMetadata
      };

      this.trials.push(trial);
      this.activeTrial = null;
      return trial;
    }

    getPayload(userName, scoreData) {
      return {
        sessionId: this.sessionId,
        gameId: this.gameId,
        userName: String(userName || "").trim() || null,
        startedAt: this.startedAt,
        submittedAt: new Date().toISOString(),
        scoreData: scoreData ? { ...scoreData } : null,
        trials: this.trials.map((trial) => ({ ...trial }))
      };
    }

    static getErrorType(target, selected) {
      const expected = String(target ?? "").trim().toLowerCase();
      const actual = String(selected ?? "").trim().toLowerCase();
      if (expected.length !== actual.length) return "incorrect_selection";

      let difference = -1;
      for (let index = 0; index < expected.length; index += 1) {
        if (expected[index] === actual[index]) continue;
        if (difference !== -1) return "incorrect_selection";
        difference = index;
      }

      if (difference === -1) return null;
      const pair = `${expected[difference]}${actual[difference]}`;
      return ["bd", "db", "pq", "qp"].includes(pair)
        ? "mirror_swap"
        : "incorrect_selection";
    }
  }

  window.CognitiveTelemetry = CognitiveTelemetry;
})();
