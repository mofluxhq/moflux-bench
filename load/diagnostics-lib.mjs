/** Credential redaction shared by retained benchmark diagnostics. */
export function redactDiagnostic(value, secrets = []) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  for (const secret of [...secrets].filter(Boolean).map(String).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/Bearer\s+[^\s"',}]+/giu, "Bearer [REDACTED]")
    .replace(/("(?:authorization|cookie|set-cookie|apiKey|accessToken|refreshToken|bootstrapToken|agentToken|password|secret)"\s*:\s*")[^"\r\n]*(")/giu, "$1[REDACTED]$2");
}
