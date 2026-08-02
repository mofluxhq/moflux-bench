/**
 * Shared retry-hint policy for the benchmark load generator.
 *
 * Tyr 0.19.0 emits `x-admission-retry-after-ms` and `Retry-After` on local
 * admission rejections. Hints are floors: the client never retries sooner
 * than its ordinary exponential backoff would have allowed.
 */

export function numericHeader(response, name) {
  const raw = response?.headers?.get?.(name);
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function retryHintMs(response) {
  if (!response) return null;
  const milliseconds = numericHeader(response, "x-admission-retry-after-ms");
  if (milliseconds !== null) return milliseconds;
  const seconds = numericHeader(response, "retry-after");
  return seconds === null ? null : seconds * 1000;
}

export function blindBackoffMs(baseMs, attempt, jitter) {
  return baseMs * 2 ** attempt * jitter;
}

export function hintedBackoffMs(baseMs, attempt, jitter, hintMs) {
  const blind = blindBackoffMs(baseMs, attempt, jitter);
  const spread = Math.min(baseMs, hintMs / 10);
  const serverJitter = (jitter - 0.5) * spread;
  return Math.max(blind, hintMs + serverJitter);
}

export function chooseRetryDelay({
  response,
  honorRetryHints,
  baseMs,
  attempt,
  jitter,
}) {
  const blindMs = blindBackoffMs(baseMs, attempt, jitter);
  const hintMs = honorRetryHints ? retryHintMs(response) : null;
  if (hintMs === null) {
    return { kind: "blind", waitMs: blindMs, blindMs, hintMs: null, applied: false };
  }
  const waitMs = hintedBackoffMs(baseMs, attempt, jitter, hintMs);
  return {
    kind: "hinted",
    waitMs,
    blindMs,
    hintMs,
    applied: waitMs > blindMs,
  };
}
