const SECRET_ENVIRONMENT_VALUE = /(^|\\[nr]|[^A-Za-z0-9_])([A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)=([^\\\r\n]*)/gm;
const SECRET_JSON_VALUE = /("(?:token|password|secret|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|authorization)"\s*:\s*")([^"]+)(")/gi;
const SECRET_YAML_VALUE = /(^|\n)(\s*(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|client-key-data|token|password)\s*:\s*)([^\r\n]+)/gi;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
const AUTHORIZATION_VALUE = /(authorization\s*[:=]\s*(?:bearer|basic)?\s+)([^\s,;]+)/gi;

export function redactSensitiveText(value: string): string {
  return value
    .replace(SECRET_ENVIRONMENT_VALUE, "$1$2=[REDACTED]")
    .replace(SECRET_JSON_VALUE, "$1[REDACTED]$3")
    .replace(SECRET_YAML_VALUE, "$1$2[REDACTED]")
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]")
    .replace(AUTHORIZATION_VALUE, "$1[REDACTED]");
}
