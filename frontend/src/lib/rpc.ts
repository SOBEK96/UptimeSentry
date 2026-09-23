// Retry helpers for the shared GenLayer RPC, which sheds load with
// "Server busy: all N execution slots occupied" under contention.

const TRANSIENT = [
  /server busy/i,
  /execution slots/i,
  /failed to fetch/i,
  /network ?error/i,
  /timed? ?out/i,
  /\b429\b/,
  /\b50[234]\b/,
  /version of json-rpc protocol is not supported/i,
];

export function isTransient(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${String((err as { details?: unknown }).details ?? "")}` : String(err);
  if (/ERR_[A-Z_]+/.test(text)) return false; // contract rejections are final
  return TRANSIENT.some((re) => re.test(text));
}

export function isBusy(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /server busy|execution slots/i.test(text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  onRetry?: (attempt: number, err: unknown) => void;
}

/** Exponential backoff with jitter: 1.5s, 3s, 6s by default. Only transient
 * RPC failures are retried; contract errors surface immediately. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 3, baseDelayMs = 1500, onRetry } = opts;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransient(err)) throw err;
      attempt += 1;
      onRetry?.(attempt, err);
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await sleep(delay * (0.85 + Math.random() * 0.3));
    }
  }
}
