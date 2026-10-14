function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function toolConnectionCommand(tool: string, nativeName: string): string {
  if (tool === 'mysql') return `mysql --login-path=${shellQuote(nativeName)}`;
  if (tool === 'kubectl') return `kubectl --context=${shellQuote(nativeName)}`;
  return tool;
}
