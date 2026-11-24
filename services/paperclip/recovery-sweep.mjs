// The historical-assignment scan is a fallback, not the normal dispatch path. Large backlogs
// must not start overlapping scans on every 30-second scheduler tick. Empty results keep the
// caller from reporting the previous scan's changes again while other recovery work proceeds.
export function recoverySweep(run, { intervalMs = 5 * 60_000, now = Date.now } = {}) {
  let running = false;
  let nextAt = 0;
  return async (...args) => {
    if (running || now() < nextAt) return {};
    running = true;
    try {
      const result = await run(...args);
      nextAt = now() + intervalMs;
      return result;
    } finally {
      running = false;
    }
  };
}
