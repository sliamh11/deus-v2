/**
 * Exponential-backoff retry with transient-vs-permanent HTTP classification.
 *
 * Extracted from linear-webhook.ts (LIA-462) so it can be shared without a
 * dispatcher ↔ webhook import cycle: linear-webhook re-exports these for its
 * own callers and tests, and linear-dispatcher imports `retryWithBackoff`
 * directly for `ensureGateWorktree`'s `gh pr view`. Behavior (including log
 * strings and thrown error types) is byte-for-byte the pre-extraction version.
 */
import { RetryableError, UserError, FatalError } from './errors/index.js';
import { logger } from './logger.js';

const WEBHOOK_MAX_DELAY_MS = 30_000;

// Async sleep — swapped out in tests for deterministic timing.
let sleepFn = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Replace the sleep implementation (test-only). */
export function _setSleepFnForTests(fn: (ms: number) => Promise<void>): void {
  sleepFn = fn;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
): Promise<T> {
  let lastErr: unknown;
  let firstErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === 0) firstErr = err;

      if (err instanceof UserError) {
        throw err;
      }

      if (isNonRetryableHttpError(err)) {
        throw new UserError(
          `Webhook dispatch failed with non-retryable HTTP error`,
          { cause: err },
        );
      }

      const isLastAttempt = attempt === maxAttempts - 1;
      if (isLastAttempt) {
        break;
      }

      const retryAfterMs = extractRetryAfterMs(err);
      const delayMs =
        retryAfterMs !== null
          ? Math.min(retryAfterMs, WEBHOOK_MAX_DELAY_MS)
          : Math.min(
              baseDelayMs * Math.pow(2, attempt) + Math.random() * baseDelayMs,
              WEBHOOK_MAX_DELAY_MS,
            );

      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          attempt: attempt + 1,
          maxAttempts,
          delayMs: Math.round(delayMs),
          error: errMsg,
          ...(retryAfterMs !== null && { retryAfterHeader: true }),
        },
        'webhook.retry',
      );

      await sleepFn(delayMs);
    }
  }

  const lastMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const firstMsg =
    firstErr instanceof Error ? firstErr.message : String(firstErr);
  logger.error(
    {
      attempts_exhausted: maxAttempts,
      first_error: firstMsg,
      error: lastMsg,
    },
    'webhook.failed',
  );
  throw new FatalError(
    `Webhook dispatch failed after ${maxAttempts} attempts`,
    {
      cause: lastErr,
    },
  );
}

function extractRetryAfterMs(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  const typed = err as Error & {
    headers?: Record<string, string>;
    response?: {
      headers?: Record<string, string> & { get?: (k: string) => string };
    };
  };
  const raw =
    typed.headers?.['retry-after'] ??
    typed.response?.headers?.['retry-after'] ??
    typed.response?.headers?.get?.('retry-after');
  if (!raw) return null;

  const seconds = Number(raw);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

function isNonRetryableHttpError(err: unknown): boolean {
  if (err instanceof RetryableError) return false;
  if (!(err instanceof Error)) return false;

  const statusCode =
    (err as Error & { status?: number; statusCode?: number }).status ??
    (err as Error & { status?: number; statusCode?: number }).statusCode;

  if (typeof statusCode === 'number') {
    if (statusCode === 429) return false;
    if (statusCode >= 400 && statusCode < 500) return true;
  }

  return false;
}
