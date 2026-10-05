// Reading a value that came from outside this package: an object is taken with exactly the fields that
// are read, each of the type it is read as. A field nobody reads is a field nobody checked.

export type Loose = Record<string, unknown>;

export const isObject = (v: unknown): v is Loose =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** A whole number of at least `least`, small enough to be exact. */
export const count = (v: unknown, least: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= least;

/** An object with these fields and no other. Throws an `Error` that says which field is the stranger. */
export function only(what: string, value: unknown, fields: readonly string[]): Loose {
  if (!isObject(value)) throw new Error(`${what} is not an object`);
  const extra = Object.keys(value).filter((key) => !fields.includes(key));
  if (extra.length)
    throw new Error(`${what} carries ${extra.join(', ')}, which the guard does not read`);
  return value;
}

export const must = (ok: boolean, what: string): void => {
  if (!ok) throw new Error(what);
};

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}
