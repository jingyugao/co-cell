import { HttpError } from '../../../util/errors.js';

type JsonRecord = Record<string, unknown>;

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value);
function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => equal(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const keys = Object.keys(left);
    const otherKeys = Object.keys(right);
    return keys.length === otherKeys.length && keys.every(key => hasOwn(right, key) && equal(left[key], right[key]));
  }
  return false;
}
function jsonShape<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return (serialized === undefined ? value : JSON.parse(serialized)) as T;
}
const hasStableIds = (value: unknown[]): value is Array<JsonRecord & { id: string }> =>
  value.every(item => isRecord(item) && typeof item.id === 'string');

function conflict(path: string): never {
  throw new HttpError(409, `记录字段已被其他请求修改（${path}），请刷新后重试`);
}

function mergeValue(previous: unknown, incoming: unknown, latest: unknown, path: string): unknown {
  const field = path.slice(path.lastIndexOf('.') + 1);
  if (field === 'updatedAt' && [previous, incoming, latest].every(value => typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value)))) {
    return [previous, incoming, latest].reduce((max, value) => Date.parse(value as string) > Date.parse(max as string) ? value : max);
  }
  if (equal(previous, incoming)) return latest;
  if (equal(previous, latest) || equal(incoming, latest)) return incoming;

  if (isRecord(previous) && isRecord(incoming) && isRecord(latest)) {
    const result: JsonRecord = { ...latest };
    const keys = new Set([...Object.keys(previous), ...Object.keys(incoming)]);
    for (const key of keys) {
      const hadPrevious = hasOwn(previous, key);
      const hasIncoming = hasOwn(incoming, key);
      if (hadPrevious === hasIncoming && (!hadPrevious || equal(previous[key], incoming[key]))) continue;
      const hasLatest = hasOwn(latest, key);
      const childPath = path ? `${path}.${key}` : key;
      if (!hasIncoming) {
        if (!hasLatest || equal(previous[key], latest[key])) delete result[key];
        else conflict(childPath);
      } else if (!hadPrevious) {
        if (hasLatest && !equal(incoming[key], latest[key])) conflict(childPath);
        result[key] = incoming[key];
      } else if (!hasLatest) {
        if (!equal(previous[key], incoming[key])) conflict(childPath);
      } else {
        result[key] = mergeValue(previous[key], incoming[key], latest[key], childPath);
      }
    }
    return result;
  }

  if (['turns', 'pendingTurns', 'userInputRequests'].includes(field)
    && Array.isArray(previous) && Array.isArray(incoming) && Array.isArray(latest)
    && hasStableIds(previous) && hasStableIds(incoming) && hasStableIds(latest)) {
    return mergeIdArray(previous, incoming, latest, path);
  }

  // Non-record values and arrays without stable identities are atomic fields.
  if (equal(previous, latest)) return incoming;
  conflict(path || 'document');
}

function mergeIdArray(
  previous: Array<JsonRecord & { id: string }>, incoming: Array<JsonRecord & { id: string }>,
  latest: Array<JsonRecord & { id: string }>, path: string,
): Array<JsonRecord & { id: string }> {
  const before = new Map(previous.map(item => [item.id, item]));
  const desired = new Map(incoming.map(item => [item.id, item]));
  const current = new Map(latest.map(item => [item.id, item]));
  const result = new Map(current);

  for (const [id, oldItem] of before) {
    if (!desired.has(id)) {
      const currentItem = current.get(id);
      if (currentItem && !equal(currentItem, oldItem)) conflict(`${path}[${id}]`);
      result.delete(id);
    }
  }
  for (const [id, newItem] of desired) {
    const oldItem = before.get(id);
    const currentItem = current.get(id);
    if (!oldItem) {
      if (currentItem && !equal(currentItem, newItem)) conflict(`${path}[${id}]`);
      if (!currentItem) result.set(id, newItem);
    } else if (!equal(oldItem, newItem)) {
      if (!currentItem) conflict(`${path}[${id}]`);
      result.set(id, mergeValue(oldItem, newItem, currentItem, `${path}[${id}]`) as JsonRecord & { id: string });
    }
  }

  // Keep the stored order, appending newly introduced items in caller order.
  const ordered = latest.map(item => result.get(item.id)).filter((item): item is JsonRecord & { id: string } => !!item);
  const present = new Set(ordered.map(item => item.id));
  for (const item of incoming) if (!present.has(item.id) && result.has(item.id)) ordered.push(result.get(item.id)!);
  return ordered;
}

/** Apply only caller changes from its baseline onto the newest stored record. */
export function mergeRecord<T>(previous: T, incoming: T, latest: T): T {
  // MySQL stores JSON documents, which omit undefined object properties and
  // normalize values such as undefined array entries. Compare the caller's
  // baseline and proposal in that same shape before applying the merge.
  return mergeValue(jsonShape(previous), jsonShape(incoming), jsonShape(latest), '') as T;
}
