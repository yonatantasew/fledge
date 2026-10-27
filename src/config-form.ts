// The Settings form edits the same JSON the Advanced tab shows. It changes
// only the fields it has controls for and keeps everything else as written,
// including fields it doesn't know.

export type Obj = Record<string, unknown>;
type Key = string | number;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The editor's text as an object the form can edit, or why it can't be. */
export function parseText(text: string): { value: Obj } | { error: string } {
  if (!text.trim()) return { value: {} };
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? { value: v } : { error: "the config must be a JSON object" };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export const toText = (v: Obj) => JSON.stringify(v, null, 2);

export function getIn(v: unknown, path: Key[]): unknown {
  let cur = v;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<Key, unknown>)[k];
  }
  return cur;
}

/**
 * A copy with `value` at `path`, creating objects on the way. undefined or ""
 * removes the field (the config rejects empty strings), and an object left
 * empty by that is removed too. null is kept: it means "none" (e.g. flavor).
 */
export function setIn(root: Obj, path: Key[], value: unknown): Obj {
  return put(root, path, value) as Obj ?? {};
}

function put(cur: unknown, path: Key[], value: unknown): unknown {
  const [k, ...rest] = path;
  const remove = rest.length === 0 && (value === undefined || value === "");
  if (Array.isArray(cur) && typeof k === "number") {
    const next = [...cur];
    next[k] = rest.length ? put(cur[k], rest, value) ?? {} : remove ? undefined : value;
    return next;
  }
  const obj: Obj = isObj(cur) ? { ...cur } : {};
  const child = rest.length ? put(obj[k], rest, value) : remove ? undefined : value;
  if (child === undefined) delete obj[k];
  else obj[k] = child;
  return Object.keys(obj).length || !path.length ? obj : undefined;
}

/** A copy of the list at `path` without item `index`. */
export function removeAt(root: Obj, path: Key[], index: number): Obj {
  const list = getIn(root, path);
  return Array.isArray(list) ? setIn(root, path, list.filter((_, i) => i !== index)) : root;
}

/** The fields of `v` the form has no controls for, so it can point to Advanced. */
export function otherKeys(v: unknown, known: readonly string[]): string[] {
  return isObj(v) ? Object.keys(v).filter((k) => !known.includes(k)) : [];
}
