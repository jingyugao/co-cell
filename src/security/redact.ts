const SECRET_ENVIRONMENT_VALUE = /(^|\\[nr]|[^A-Za-z0-9_])([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)=([^\\\r\n]*)/gm;
const SECRET_JSON_VALUE = /("(?:token|password|secret|api[_-]?key|private[_-]?key)"\s*:\s*")([^"]+)(")/gi;
const AUTHORIZATION_VALUE = /(authorization\s*[:=]\s*(?:bearer|basic)?\s+)([^\s,;]+)/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(SECRET_ENVIRONMENT_VALUE, "$1$2=[REDACTED]")
    .replace(SECRET_JSON_VALUE, "$1[REDACTED]$3")
    .replace(AUTHORIZATION_VALUE, "$1[REDACTED]");
}
