/** Runtime identity is a routing key, not an authentication credential. */
export function toolRuntimeBoxId(value) {
  if (typeof value !== 'string') return undefined;
  if (/^[a-z0-9][a-z0-9-]{0,54}$/.test(value)) return value;
  // Checkpointed older images still send their former signed token. Read the
  // routing field only; signatures and execution generations are not checked.
  try {
    const payload = JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString('utf8'));
    if (typeof payload.boxId === 'string' && /^[a-z0-9][a-z0-9-]{0,54}$/.test(payload.boxId)) return payload.boxId;
  } catch {}
  return undefined;
}
