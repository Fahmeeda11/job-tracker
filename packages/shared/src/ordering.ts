/**
 * Fractional indexing
 * ===================
 *
 * The problem this solves
 * -----------------------
 * A Kanban column is an ordered list. The naive model is an integer `position`
 * field: 0, 1, 2, 3... Dragging a card from position 7 to position 1 then means
 * rewriting `position` on every card in between - an O(n) write for an O(1) user
 * action, and a guaranteed conflict the moment two people drag at once.
 *
 * Fractional indexing instead gives each item an *order key*: a string chosen so
 * that plain lexicographic sort produces the right order. To move a card, you
 * generate a new key strictly between its new neighbours and write exactly ONE
 * document. No neighbours are touched, so concurrent drags in different parts of
 * the board do not collide.
 *
 *     ['a0', 'a1', 'a2']            insert between a0 and a1
 *  -> ['a0', 'a0V', 'a1', 'a2']     one write, still sorts correctly
 *
 * Why strings and not floats
 * --------------------------
 * `(a + b) / 2` looks like the obvious answer, and it works until it does not:
 * IEEE-754 doubles run out of room after ~50 consecutive midpoint insertions at
 * the same spot, and then two cards silently share a position. Strings can grow a
 * character instead of running out of precision, so the structure degrades
 * gracefully - keys get longer, never ambiguous.
 *
 * The encoding
 * ------------
 * A key is an integer part followed by an optional fractional part. The integer
 * part's first character encodes its own length, which is what lets keys of
 * different magnitudes still compare correctly as plain strings:
 *
 *   'a' -> 2 chars total ('a' + 1 digit)   ... 'z' -> 27 chars
 *   'Z' -> 2 chars total                   ... 'A' -> 27 chars
 *
 * Uppercase heads encode negative integers (descending), lowercase encode
 * non-negative (ascending), so 'Z...' < 'a...' lexicographically matches -1 < 0.
 *
 * This is the algorithm described in "Implementing Fractional Indexing"
 * (David Greenspan) and used by Figma and Replicache. It is reimplemented here
 * rather than installed as a dependency because understanding it is the point of
 * this feature - and because it is ~150 lines with no runtime deps.
 *
 * Invariants worth remembering:
 *   - A key never ends in the zero digit ('0'). That is what keeps keys unique
 *     and the midpoint search terminating.
 *   - generateKeyBetween(a, b) requires a < b. Callers must pass neighbours in
 *     order; passing them backwards is a bug, not a recoverable state.
 */

export const BASE_62_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Thrown when an order key is structurally invalid or arguments are out of order. */
export class OrderKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderKeyError';
  }
}

/**
 * Returns a string strictly between `a` and `b` (exclusive), where both are
 * *fractional* parts only - no integer head. `b === null` means "no upper bound".
 *
 * Works digit by digit: skip the shared prefix, then either pick a digit halfway
 * between the two differing digits, or - when they are adjacent and there is no
 * gap to exploit - descend one more character and recurse.
 */
function midpoint(a: string, b: string | null, digits: string): string {
  const zero = digits.charAt(0);

  if (b !== null && a >= b) {
    throw new OrderKeyError(`midpoint: ${a} >= ${b}`);
  }
  if (a.slice(-1) === zero || (b !== null && b.slice(-1) === zero)) {
    throw new OrderKeyError('midpoint: order keys must not end in the zero digit');
  }

  if (b !== null) {
    // Strip the longest common prefix and recurse on the remainder.
    let n = 0;
    while (n < b.length && (a.charAt(n) || zero) === b.charAt(n)) {
      n += 1;
    }
    if (n > 0) {
      return b.slice(0, n) + midpoint(a.slice(n), b.slice(n) || null, digits);
    }
  }

  // The leading digits differ (or `a` is empty). Try to land between them.
  const digitA = a.length > 0 ? digits.indexOf(a.charAt(0)) : 0;
  const digitB = b !== null && b.length > 0 ? digits.indexOf(b.charAt(0)) : digits.length;

  if (digitB - digitA > 1) {
    // There is at least one digit of room between them: take the middle.
    const midDigit = Math.round(0.5 * (digitA + digitB));
    return digits.charAt(midDigit);
  }

  // Leading digits are consecutive - no room at this level.
  if (b !== null && b.length > 1) {
    // Borrow from `b`: its own first digit is already above `a`.
    return b.slice(0, 1);
  }

  // `b` is null or a single digit. Keep `a`'s digit and go one level deeper.
  // e.g. midpoint('49', '5') -> '4' + midpoint('9', null) -> '4' + '9' + ...
  return digits.charAt(digitA) + midpoint(a.slice(1), null, digits);
}

/** How many characters the integer part occupies, given its first character. */
function getIntegerLength(head: string): number {
  if (head >= 'a' && head <= 'z') {
    return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  }
  if (head >= 'A' && head <= 'Z') {
    return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  }
  throw new OrderKeyError(`invalid order key head: ${head}`);
}

function validateInteger(int: string): void {
  if (int.length !== getIntegerLength(int.charAt(0))) {
    throw new OrderKeyError(`invalid integer part of order key: ${int}`);
  }
}

function getIntegerPart(key: string): string {
  const head = key.charAt(0);
  const len = getIntegerLength(head);
  if (len > key.length) {
    throw new OrderKeyError(`invalid order key: ${key}`);
  }
  return key.slice(0, len);
}

/**
 * Structural validation. Throws rather than returning false - a malformed order
 * key means data corruption somewhere upstream, and silently coercing it would
 * scramble the board.
 */
export function validateOrderKey(key: string, digits: string = BASE_62_DIGITS): void {
  if (key === 'A' + digits.charAt(0).repeat(26)) {
    throw new OrderKeyError(`invalid order key (smallest possible): ${key}`);
  }
  const int = getIntegerPart(key);
  const frac = key.slice(int.length);
  if (frac.slice(-1) === digits.charAt(0)) {
    throw new OrderKeyError(`invalid order key (trailing zero): ${key}`);
  }
}

/** Boolean wrapper around validateOrderKey, for call sites that want to branch. */
export function isValidOrderKey(key: string, digits: string = BASE_62_DIGITS): boolean {
  try {
    validateOrderKey(key, digits);
    return true;
  } catch {
    return false;
  }
}

function incrementInteger(x: string, digits: string): string | null {
  validateInteger(x);
  const head = x.charAt(0);
  const digs = x.slice(1).split('');

  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = digits.indexOf(digs[i] as string) + 1;
    if (d === digits.length) {
      digs[i] = digits.charAt(0);
    } else {
      digs[i] = digits.charAt(d);
      carry = false;
    }
  }

  if (!carry) return head + digs.join('');

  // Overflowed this magnitude - widen the integer part by moving to the next head.
  if (head === 'Z') return 'a' + digits.charAt(0);
  if (head === 'z') return null; // exhausted the key space entirely
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > 'a') {
    digs.push(digits.charAt(0));
  } else {
    digs.pop();
  }
  return h + digs.join('');
}

function decrementInteger(x: string, digits: string): string | null {
  validateInteger(x);
  const head = x.charAt(0);
  const digs = x.slice(1).split('');

  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = digits.indexOf(digs[i] as string) - 1;
    if (d === -1) {
      digs[i] = digits.slice(-1);
    } else {
      digs[i] = digits.charAt(d);
      borrow = false;
    }
  }

  if (!borrow) return head + digs.join('');

  if (head === 'a') return 'Z' + digits.slice(-1);
  if (head === 'A') return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < 'Z') {
    digs.push(digits.slice(-1));
  } else {
    digs.pop();
  }
  return h + digs.join('');
}

/**
 * Generate a key that sorts strictly between `a` and `b`.
 *
 *   generateKeyBetween(null, null)  -> first key in an empty list
 *   generateKeyBetween(last, null)  -> append to the end
 *   generateKeyBetween(null, first) -> prepend to the front
 *   generateKeyBetween(x, y)        -> insert between two existing items
 *
 * Throws if `a >= b`, or if either key is structurally invalid.
 */
export function generateKeyBetween(
  a: string | null,
  b: string | null,
  digits: string = BASE_62_DIGITS,
): string {
  if (a !== null) validateOrderKey(a, digits);
  if (b !== null) validateOrderKey(b, digits);
  if (a !== null && b !== null && a >= b) {
    throw new OrderKeyError(`generateKeyBetween: ${a} >= ${b}`);
  }

  // Empty list.
  if (a === null && b === null) return 'a' + digits.charAt(0);

  // Prepend before `b`.
  if (a === null) {
    const bKey = b as string;
    const ib = getIntegerPart(bKey);
    const fb = bKey.slice(ib.length);
    if (ib === 'A' + digits.charAt(0).repeat(26)) {
      return ib + midpoint('', fb || null, digits);
    }
    if (ib < bKey) return ib;
    const res = decrementInteger(ib, digits);
    if (res === null) throw new OrderKeyError('cannot decrement any further');
    return res;
  }

  // Append after `a`.
  if (b === null) {
    const ia = getIntegerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia, digits);
    return i === null ? ia + midpoint(fa, null, digits) : i;
  }

  // Between two existing keys.
  const ia = getIntegerPart(a);
  const fa = a.slice(ia.length);
  const ib = getIntegerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb || null, digits);

  const i = incrementInteger(ia, digits);
  if (i === null) throw new OrderKeyError('cannot increment any further');
  if (i < b) return i;
  return ia + midpoint(fa, null, digits);
}

/**
 * Generate `n` keys in ascending order, all strictly between `a` and `b`.
 * Used when seeding a board or bulk-importing applications.
 *
 * Bisects rather than chaining, so the keys stay short: generating sequentially
 * would hang each key off the previous one and grow them without bound.
 */
export function generateNKeysBetween(
  a: string | null,
  b: string | null,
  n: number,
  digits: string = BASE_62_DIGITS,
): string[] {
  if (n === 0) return [];
  if (n < 0) throw new OrderKeyError(`generateNKeysBetween: n must be >= 0, got ${n}`);
  if (n === 1) return [generateKeyBetween(a, b, digits)];

  if (b === null) {
    let c = generateKeyBetween(a, b, digits);
    const result = [c];
    for (let i = 0; i < n - 1; i++) {
      c = generateKeyBetween(c, b, digits);
      result.push(c);
    }
    return result;
  }

  if (a === null) {
    let c = generateKeyBetween(a, b, digits);
    const result = [c];
    for (let i = 0; i < n - 1; i++) {
      c = generateKeyBetween(a, c, digits);
      result.push(c);
    }
    return result.reverse();
  }

  const mid = Math.floor(n / 2);
  const c = generateKeyBetween(a, b, digits);
  return [
    ...generateNKeysBetween(a, c, mid, digits),
    c,
    ...generateNKeysBetween(c, b, n - mid - 1, digits),
  ];
}

/**
 * Work out the order key for an item dropped at `targetIndex` within `siblings`.
 *
 * `siblings` must already be sorted ascending by order key and must NOT contain
 * the item being moved - strip it out first, or a move-down-by-one lands the card
 * back where it started. The board code does this in
 * apps/web/src/features/board/reorder.ts, which is the only place that should be
 * computing drop targets.
 */
export function orderKeyForIndex(siblings: string[], targetIndex: number): string {
  const clamped = Math.max(0, Math.min(targetIndex, siblings.length));
  const before = clamped > 0 ? (siblings[clamped - 1] ?? null) : null;
  const after = clamped < siblings.length ? (siblings[clamped] ?? null) : null;
  return generateKeyBetween(before, after);
}
