const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Retry only the read-only scrape, never the notification delivery.
async function retryScrape(scrape, {
  label,
  getRemainingTimeInMillis = () => Infinity,
  maxAttempts = 3,
  attemptTimeoutMs = 60000,
  reserveMs = 20000,
  minAttemptTimeoutMs = 10000,
  wait = sleep,
  logger = console
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const delayMs = attempt === 1 ? 0 : 2000 * 2 ** (attempt - 2);
    if (getRemainingTimeInMillis() < reserveMs + delayMs + minAttemptTimeoutMs) {
      throw new Error(`Not enough time left to scrape ${label}`, { cause: lastError });
    }
    if (delayMs) await wait(delayMs);
    const timeoutMs = Math.min(attemptTimeoutMs, getRemainingTimeInMillis() - reserveMs);
    if (timeoutMs < minAttemptTimeoutMs) {
      throw new Error(`Not enough time left to scrape ${label}`, { cause: lastError });
    }
    logger.log(`Scrape attempt ${attempt}/${maxAttempts} for ${label} (budget ${timeoutMs}ms)`);
    try {
      return await scrape(timeoutMs);
    } catch (error) {
      lastError = error;
      logger.warn(`Scrape attempt ${attempt}/${maxAttempts} failed for ${label}: ${error.message}`);
    }
  }
  throw new Error(`Scrape failed after ${maxAttempts} attempts for ${label}`, { cause: lastError });
}

// Closing the page in the caller's finally block stops timed-out browser work.
async function withTimeout(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Scrape timed out after ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { retryScrape, withTimeout };
