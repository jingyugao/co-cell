/** Runtime identity is a routing key, not an authentication credential. */
export function toolRuntimeBoxId(value) {
  if (typeof value !== 'string') return undefined;
  if (/^[a-z0-9][a-z0-9-]{0,54}$/.test(value)) return value;
  return undefined;
}
