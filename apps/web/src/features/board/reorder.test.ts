import { describe, it, expect } from 'vitest';
import type { Application, Stage } from '@job-tracker/shared';
import { computeMove, groupByStage, applyOptimisticMove, resolveDropIndex } from './reorder.js';

/** Minimal application fixture - only the fields reordering actually reads. */
function card(id: string, stage: Stage, order: string): Application {
  return {
    id,
    company: `Company ${id}`,
    role: 'Engineer',
    stage,
    order,
    noteCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as Application;
}

const board: Application[] = [
  card('a', 'wishlist', 'a1'),
  card('b', 'wishlist', 'a2'),
  card('c', 'wishlist', 'a3'),
  card('x', 'applied', 'a1'),
  card('y', 'applied', 'a2'),
];

describe('groupByStage', () => {
  it('groups cards into columns', () => {
    const columns = groupByStage(board);
    expect(columns['wishlist']?.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(columns['applied']?.map((c) => c.id)).toEqual(['x', 'y']);
  });

  it('sorts each column by order key, not by insertion order', () => {
    const shuffled = [
      card('c', 'wishlist', 'a3'),
      card('a', 'wishlist', 'a1'),
      card('b', 'wishlist', 'a2'),
    ];
    expect(groupByStage(shuffled)['wishlist']?.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty board', () => {
    expect(groupByStage([])).toEqual({});
  });
});

describe('computeMove', () => {
  const wishlist = [card('a', 'wishlist', 'a1'), card('b', 'wishlist', 'a2'), card('c', 'wishlist', 'a3')];

  it('moving to the top has no card before it', () => {
    expect(computeMove('c', 'wishlist', wishlist, 0)).toEqual({
      stage: 'wishlist',
      beforeId: null,
      afterId: 'a',
    });
  });

  it('moving to the bottom has no card after it', () => {
    // With 'a' removed the column is [b, c], so index 2 is past the end: the
    // card lands below 'c' with nothing after it.
    expect(computeMove('a', 'wishlist', wishlist, 2)).toEqual({
      stage: 'wishlist',
      beforeId: 'c',
      afterId: null,
    });
  });

  it('moving into the middle names both neighbours', () => {
    expect(computeMove('c', 'wishlist', wishlist, 1)).toEqual({
      stage: 'wishlist',
      beforeId: 'a',
      afterId: 'b',
    });
  });

  it('moving into an empty column names no neighbours', () => {
    expect(computeMove('a', 'offer', [], 0)).toEqual({
      stage: 'offer',
      beforeId: null,
      afterId: null,
    });
  });

  it('moving into another column treats the card as not already present', () => {
    const applied = [card('x', 'applied', 'a1'), card('y', 'applied', 'a2')];
    expect(computeMove('a', 'applied', applied, 1)).toEqual({
      stage: 'applied',
      beforeId: 'x',
      afterId: 'y',
    });
  });

  /**
   * The regression this module exists to prevent. Dragging a card down one slot
   * inside its own column must not name the card itself as a neighbour - doing
   * so asks the server to place A between A and B, and the card springs back.
   */
  it('never names the moving card as its own neighbour', () => {
    for (let index = 0; index <= wishlist.length; index++) {
      for (const id of ['a', 'b', 'c']) {
        const move = computeMove(id, 'wishlist', wishlist, index);
        expect(move.beforeId).not.toBe(id);
        expect(move.afterId).not.toBe(id);
      }
    }
  });

  it('moving a card down one slot targets the slot below it', () => {
    // 'a' is at index 0. Dropping at index 1 of [b, c] puts it between b and c.
    expect(computeMove('a', 'wishlist', wishlist, 1)).toEqual({
      stage: 'wishlist',
      beforeId: 'b',
      afterId: 'c',
    });
  });

  it('clamps an out-of-range index rather than producing undefined neighbours', () => {
    expect(computeMove('a', 'wishlist', wishlist, 99).afterId).toBeNull();
    expect(computeMove('a', 'wishlist', wishlist, -3).beforeId).toBeNull();
  });
});

describe('applyOptimisticMove', () => {
  it('moves the card to the destination stage', () => {
    const next = applyOptimisticMove(board, 'a', 'applied', 0);
    expect(next.find((c) => c.id === 'a')?.stage).toBe('applied');
  });

  it('places the card at the requested index once re-sorted', () => {
    const next = applyOptimisticMove(board, 'c', 'wishlist', 0);
    expect(groupByStage(next)['wishlist']?.map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('places the card at the end of a column', () => {
    const next = applyOptimisticMove(board, 'a', 'applied', 2);
    expect(groupByStage(next)['applied']?.map((c) => c.id)).toEqual(['x', 'y', 'a']);
  });

  it('places the card into an empty column', () => {
    const next = applyOptimisticMove(board, 'a', 'offer', 0);
    expect(groupByStage(next)['offer']?.map((c) => c.id)).toEqual(['a']);
  });

  /**
   * TanStack Query hands back the cached array directly. Mutating it would change
   * what React sees without changing the reference (so no re-render) and would
   * corrupt the snapshot the rollback depends on.
   */
  it('does not mutate the input array or its cards', () => {
    const snapshot = JSON.stringify(board);
    applyOptimisticMove(board, 'a', 'applied', 0);
    expect(JSON.stringify(board)).toBe(snapshot);
  });

  it('returns the board unchanged when the card is unknown', () => {
    expect(applyOptimisticMove(board, 'does-not-exist', 'applied', 0)).toBe(board);
  });

  /**
   * Regression: the placeholder order key for a drop at the TOP of a column has
   * to sort BELOW its neighbour. Generating it by appending a character to the
   * neighbour produces a key that sorts above it instead, so the card lands
   * second and then visibly jumps to first when the server responds.
   */
  it('gives a top-of-column drop a key that sorts below its neighbour', () => {
    const next = applyOptimisticMove(board, 'c', 'wishlist', 0);
    const moved = next.find((card) => card.id === 'c');
    const neighbour = next.find((card) => card.id === 'a');

    expect(moved?.order && neighbour?.order && moved.order < neighbour.order).toBe(true);
  });

  it('keeps every column consistently ordered after a move to any index', () => {
    for (let index = 0; index <= 3; index++) {
      const next = applyOptimisticMove(board, 'c', 'wishlist', index);
      const ids = groupByStage(next)['wishlist']?.map((card) => card.id) ?? [];
      // 'c' must land exactly where it was dropped, clamped to the column length.
      expect(ids.indexOf('c')).toBe(Math.min(index, 2));
    }
  });
});

describe('resolveDropIndex', () => {
  const column = [card('a', 'wishlist', 'a1'), card('b', 'wishlist', 'a2')];

  it('dropping on the column appends', () => {
    expect(resolveDropIndex(column, 'wishlist', true)).toBe(2);
  });

  it('dropping on a card targets that card\'s index', () => {
    expect(resolveDropIndex(column, 'b', false)).toBe(1);
  });

  it('appends when the target card is not in this column', () => {
    expect(resolveDropIndex(column, 'unknown', false)).toBe(2);
  });

  it('dropping on an empty column gives index 0', () => {
    expect(resolveDropIndex([], 'offer', true)).toBe(0);
  });
});
