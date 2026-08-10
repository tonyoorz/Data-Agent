function nowMs() {
  return performance.now();
}

function roundMs(value) {
  return Number(value.toFixed(1));
}

function buildStatus(state, details = {}) {
  return {
    state,
    startedAt: null,
    finishedAt: null,
    lastDurationMs: null,
    lastReason: null,
    error: null,
    result: null,
    ...details,
  };
}

export function createDuplicateWarmupManager({ runDuplicateBridge, logger = console }) {
  let status = buildStatus("cold");
  let inFlightWarmup = null;

  const getStatus = () => ({ ...status });

  const ensureWarm = ({ reason = "manual", optional = false } = {}) => {
    if (status.state === "warm") {
      return Promise.resolve(getStatus());
    }

    if (inFlightWarmup) {
      return optional ? inFlightWarmup.catch(() => getStatus()) : inFlightWarmup;
    }

    const startedAt = Date.now();
    const perfStartedAt = nowMs();
    status = buildStatus("warming", {
      startedAt,
      lastReason: reason,
      result: status.result,
    });

    inFlightWarmup = runDuplicateBridge({ action: "warmup" })
      .then((payload) => {
        if (!payload?.success) {
          throw new Error(payload?.error || "Duplicate warmup failed");
        }

        status = buildStatus("warm", {
          startedAt,
          finishedAt: Date.now(),
          lastDurationMs: roundMs(nowMs() - perfStartedAt),
          lastReason: reason,
          result: payload.result ?? null,
        });

        return getStatus();
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        status = buildStatus("failed", {
          startedAt,
          finishedAt: Date.now(),
          lastDurationMs: roundMs(nowMs() - perfStartedAt),
          lastReason: reason,
          error: message,
        });
        throw error;
      })
      .finally(() => {
        inFlightWarmup = null;
      });

    return optional ? inFlightWarmup.catch(() => getStatus()) : inFlightWarmup;
  };

  const triggerBackgroundWarmup = ({ reason = "startup" } = {}) => {
    void ensureWarm({ reason }).catch((error) => {
      logger?.warn?.("[vizion-warmup] duplicate warmup failed", error);
    });
  };

  return {
    getStatus,
    ensureWarm,
    triggerBackgroundWarmup,
  };
}