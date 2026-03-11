/**
 * Exponential backoff retry utility.
 * Delays: baseDelayMs * 2^attempt — e.g. 1s, 2s, 4s for the default 3 attempts.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000,
  label = "operation"
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt < maxAttempts - 1) {
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        console.warn(
          `[retry] ${label} failed (attempt ${attempt + 1}/${maxAttempts}), ` +
            `retrying in ${delayMs}ms… ${String(err)}`
        );
        await sleep(delayMs);
      }
    }
  }

  throw new Error(
    `[retry] ${label} failed after ${maxAttempts} attempts: ${String(lastError)}`,
    { cause: lastError }
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
