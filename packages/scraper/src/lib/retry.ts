/**
 * Exponential backoff retry utility with full jitter.
 */
function isRetryableError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  if (msg.includes("http 429")) return true;
  if (msg.includes("http 5")) return true;
  if (msg.includes("timed out") || msg.includes("timeout")) return true;
  if (msg.includes("econnreset") || msg.includes("enotfound") || msg.includes("socket")) return true;
  if (msg.includes("http 4")) return false;
  return true;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1000,
  label = "operation",
  shouldRetry: (err: unknown) => boolean = isRetryableError
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = shouldRetry(err);

      if (!retryable) {
        throw err;
      }

      if (attempt < maxAttempts - 1) {
        const maxDelayMs = baseDelayMs * Math.pow(2, attempt);
        const delayMs = Math.floor(Math.random() * maxDelayMs);
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
