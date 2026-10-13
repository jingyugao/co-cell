function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function toolConnectionCommand(tool: string, connectionName: string): string {
  return `${tool} --connection=${shellQuote(connectionName)}`;
}
