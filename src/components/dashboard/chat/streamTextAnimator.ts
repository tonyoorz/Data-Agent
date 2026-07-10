type StreamTextAnimatorOptions = {
  onUpdate: (nextText: string) => void;
  intervalMs?: number;
  charsPerTick?: number;
};

export type StreamTextAnimator = {
  push: (text: string) => void;
  pushImmediate: (text: string) => void;
  finish: () => Promise<void>;
  stop: () => void;
};

export function createStreamTextAnimator({
  onUpdate,
  intervalMs = 6,
  charsPerTick = 1,
}: StreamTextAnimatorOptions): StreamTextAnimator {
  let renderedText = "";
  let pendingChars: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const finishResolvers = new Set<() => void>();

  const resolveFinishers = () => {
    for (const resolve of finishResolvers) {
      resolve();
    }
    finishResolvers.clear();
  };

  const flush = () => {
    timer = null;

    if (stopped) {
      pendingChars = [];
      resolveFinishers();
      return;
    }

    if (!pendingChars.length) {
      resolveFinishers();
      return;
    }

    const nextChars = pendingChars.splice(0, Math.max(1, charsPerTick)).join("");
    renderedText += nextChars;
    onUpdate(renderedText);

    if (pendingChars.length) {
      timer = setTimeout(flush, intervalMs);
      return;
    }

    resolveFinishers();
  };

  const ensureTimer = () => {
    if (stopped || timer !== null || !pendingChars.length) {
      return;
    }

    timer = setTimeout(flush, intervalMs);
  };

  return {
    push(text: string) {
      if (stopped || !text) {
        return;
      }

      pendingChars.push(...Array.from(text));
      ensureTimer();
    },
    pushImmediate(text: string) {
      if (stopped || !text) {
        return;
      }

      if (pendingChars.length) {
        renderedText += pendingChars.join("");
        pendingChars = [];
      }
      renderedText += text;
      onUpdate(renderedText);
      resolveFinishers();
    },
    finish() {
      if (stopped || (!pendingChars.length && timer === null)) {
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        finishResolvers.add(resolve);
        ensureTimer();
      });
    },
    stop() {
      stopped = true;
      pendingChars = [];
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolveFinishers();
    },
  };
}