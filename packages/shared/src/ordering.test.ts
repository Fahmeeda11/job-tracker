import { describe, it, expect } from 'vitest';
import {
  generateKeyBetween,
  generateNKeysBetween,
  orderKeyForIndex,
  isValidOrderKey,
  OrderKeyError,
} from './ordering.js';

/**
 * The property that actually matters: whatever keys we generate, sorting them as
 * plain strings must reproduce the intended order. Everything else is detail.
 */
function isSorted(keys: string[]): boolean {
  return keys.every((k, i) => i === 0 || (keys[i - 1] as string) < k);
}

describe('generateKeyBetween', () => {
  it('produces a first key for an empty list', () => {
    expect(generateKeyBetween(null, null)).toBe('a0');
  });

  it('appends after a key', () => {
    const first = generateKeyBetween(null, null);
    const second = generateKeyBetween(first, null);
    expect(second > first).toBe(true);
  });

  it('prepends before a key', () => {
    const first = generateKeyBetween(null, null);
    const before = generateKeyBetween(null, first);
    expect(before < first).toBe(true);
  });

  it('lands strictly between two adjacent keys', () => {
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    const mid = generateKeyBetween(a, b);
    expect(a < mid).toBe(true);
    expect(mid < b).toBe(true);
  });

  it('rejects arguments given in the wrong order', () => {
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    expect(() => generateKeyBetween(b, a)).toThrow(OrderKeyError);
  });

  it('rejects identical bounds', () => {
    const a = generateKeyBetween(null, null);
    expect(() => generateKeyBetween(a, a)).toThrow(OrderKeyError);
  });

  it('rejects structurally invalid keys', () => {
    expect(() => generateKeyBetween('!!', null)).toThrow(OrderKeyError);
    // Trailing zero is invalid: it would break midpoint termination.
    expect(() => generateKeyBetween('a00', null)).toThrow(OrderKeyError);
  });

  /**
   * Note the invariant is about the FRACTIONAL part, not the whole key. 'a0' is
   * the legitimate first key and appending eventually reaches 'b00' - both end in
   * '0' and both are valid, because their fractional part is empty. What must
   * never happen is a fractional part ending in zero, which would break midpoint
   * termination. validateOrderKey is the authority on that.
   */
  it('only ever emits structurally valid, strictly increasing keys', () => {
    let prev = generateKeyBetween(null, null);
    expect(isValidOrderKey(prev)).toBe(true);

    for (let i = 0; i < 200; i++) {
      const next = generateKeyBetween(prev, null);
      expect(isValidOrderKey(next)).toBe(true);
      expect(next > prev).toBe(true);
      prev = next;
    }
  });

  it('emits valid keys when squeezing into a gap, where fractional parts do grow', () => {
    const lo = generateKeyBetween(null, null);
    let hi = generateKeyBetween(lo, null);

    for (let i = 0; i < 200; i++) {
      hi = generateKeyBetween(lo, hi);
      expect(isValidOrderKey(hi)).toBe(true);
      // These keys DO have a fractional part, and it must never end in zero.
      expect(hi.endsWith('0')).toBe(false);
    }
  });
});

describe('repeated insertion at the same point', () => {
  /**
   * This is the case that kills the float approach. With doubles you get ~50
   * insertions before (a+b)/2 === a and two cards collide. Strings just get
   * longer, so this must survive far past that.
   */
  it('survives 500 insertions into the same gap without collision', () => {
    const lo = generateKeyBetween(null, null);
    let hi = generateKeyBetween(lo, null);
    const seen = new Set<string>([lo, hi]);

    for (let i = 0; i < 500; i++) {
      const mid = generateKeyBetween(lo, hi);
      expect(lo < mid).toBe(true);
      expect(mid < hi).toBe(true);
      expect(seen.has(mid)).toBe(false);
      seen.add(mid);
      hi = mid; // keep squeezing into the same shrinking gap
    }
  });

  it('keeps keys reasonably short under normal append load', () => {
    let prev = generateKeyBetween(null, null);
    for (let i = 0; i < 1000; i++) {
      prev = generateKeyBetween(prev, null);
    }
    // Appending walks the integer part, so length grows logarithmically at worst.
    expect(prev.length).toBeLessThan(10);
  });
});

describe('generateNKeysBetween', () => {
  it('returns nothing for n = 0', () => {
    expect(generateNKeysBetween(null, null, 0)).toEqual([]);
  });

  it('generates n ascending keys from nothing', () => {
    const keys = generateNKeysBetween(null, null, 25);
    expect(keys).toHaveLength(25);
    expect(isSorted(keys)).toBe(true);
  });

  it('generates n keys strictly inside a bounded gap', () => {
    const a = generateKeyBetween(null, null);
    const b = generateKeyBetween(a, null);
    const keys = generateNKeysBetween(a, b, 20);

    expect(keys).toHaveLength(20);
    expect(isSorted(keys)).toBe(true);
    expect(a < (keys[0] as string)).toBe(true);
    expect((keys[keys.length - 1] as string) < b).toBe(true);
  });

  it('generates n keys below a bound', () => {
    const b = generateKeyBetween(null, null);
    const keys = generateNKeysBetween(null, b, 10);
    expect(isSorted(keys)).toBe(true);
    expect((keys[keys.length - 1] as string) < b).toBe(true);
  });

  it('rejects negative n', () => {
    expect(() => generateNKeysBetween(null, null, -1)).toThrow(OrderKeyError);
  });
});

describe('orderKeyForIndex', () => {
  // A realistic column: six cards already sitting in order.
  const column = generateNKeysBetween(null, null, 6);

  it('computes a key for the top of the column', () => {
    const key = orderKeyForIndex(column, 0);
    expect(key < (column[0] as string)).toBe(true);
  });

  it('computes a key for the bottom of the column', () => {
    const key = orderKeyForIndex(column, column.length);
    expect((column[column.length - 1] as string) < key).toBe(true);
  });

  it('computes a key for the middle of the column', () => {
    const key = orderKeyForIndex(column, 3);
    expect((column[2] as string) < key).toBe(true);
    expect(key < (column[3] as string)).toBe(true);
  });

  it('clamps an out-of-range index instead of throwing', () => {
    expect(() => orderKeyForIndex(column, 99)).not.toThrow();
    expect(() => orderKeyForIndex(column, -5)).not.toThrow();
    expect(orderKeyForIndex(column, 99) > (column[column.length - 1] as string)).toBe(true);
    expect(orderKeyForIndex(column, -5) < (column[0] as string)).toBe(true);
  });

  it('handles an empty column', () => {
    expect(isValidOrderKey(orderKeyForIndex([], 0))).toBe(true);
  });

  /**
   * The bug this guards against: if the caller leaves the dragged card in
   * `siblings`, moving it down one slot computes a key between itself and the
   * next card, which is where it already was - the card springs back and the user
   * thinks the app is broken. reorder.ts on the web side strips it first; this
   * documents why.
   */
  it('moves a card down one slot when the caller removes it from siblings first', () => {
    const moving = column[1] as string;
    const without = column.filter((k) => k !== moving);
    const key = orderKeyForIndex(without, 2);

    const resorted = [...without.slice(0, 2), key, ...without.slice(2)].sort();
    expect(resorted[2]).toBe(key);
    expect(isSorted(resorted)).toBe(true);
  });
});

describe('full board simulation', () => {
  /**
   * Fuzz: shuffle a column through many random drags and assert the order keys
   * still reproduce the intended order every single time. This catches the
   * off-by-one class of bug that unit tests on individual functions miss.
   */
  it('keeps order consistent across 300 random moves', () => {
    let items = generateNKeysBetween(null, null, 12).map((order, i) => ({ id: `c${i}`, order }));

    // Deterministic PRNG so a failure is reproducible.
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };

    for (let step = 0; step < 300; step++) {
      const from = rand(items.length);
      const to = rand(items.length);
      const moving = items[from];
      if (!moving) continue;

      const without = items.filter((it) => it.id !== moving.id);
      const newOrder = orderKeyForIndex(
        without.map((it) => it.order),
        to,
      );

      items = [...without];
      items.splice(to, 0, { ...moving, order: newOrder });

      // The invariant: sorting by order key must match the array we maintain.
      const byKey = [...items].sort((x, y) => (x.order < y.order ? -1 : 1));
      expect(byKey.map((it) => it.id)).toEqual(items.map((it) => it.id));
      expect(new Set(items.map((it) => it.order)).size).toBe(items.length);
    }
  });
});
