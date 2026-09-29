/**
 * Turning a drag gesture into a move request.
 *
 * This is the only place in the web app that works out where a card landed. It
 * exists as a separate, pure module - no React, no dnd-kit types - because the
 * off-by-one bugs in drag-and-drop reordering are notoriously hard to reason
 * about in a component and trivially easy to unit test in isolation.
 *
 * The server owns order keys (see apps/api applications/service.ts). The client
 * only says WHICH TWO CARDS the dropped card landed between, by id.
 */

import type { Application, Stage } from '@job-tracker/shared';

export interface MoveRequest {
  stage: Stage;
  beforeId: string | null;
  afterId: string | null;
}

/** Group a flat application list into columns, each sorted by order key. */
export function groupByStage(applications: Application[]): Record<string, Application[]> {
  const columns: Record<string, Application[]> = {};

  for (const app of applications) {
    (columns[app.stage] ??= []).push(app);
  }

  for (const stage of Object.keys(columns)) {
    // Order keys are designed so plain string comparison is the sort.
    columns[stage]?.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
  }

  return columns;
}

/**
 * Work out the neighbours for a card dropped at `targetIndex` in `destination`.
 *
 * THE CRITICAL DETAIL: the moving card is removed from the destination list
 * before neighbours are read.
 *
 * Why it matters. Take a column [A, B, C] and drag A down one slot, to index 1.
 * If A is still in the list, index 1's neighbours are A (at 0) and B (at 1) - so
 * the server is asked to place A between A and B, which either throws or puts A
 * exactly where it already was. The card springs back and the app looks broken.
 *
 * With A removed the list is [B, C], and dropping at index 1 correctly yields
 * neighbours B and C. This mirrors orderKeyForIndex in
 * packages/shared/ordering.ts, which carries the same warning for the same
 * reason.
 */
export function computeMove(
  movingId: string,
  destinationStage: Stage,
  destinationCards: Application[],
  targetIndex: number,
): MoveRequest {
  const without = destinationCards.filter((card) => card.id !== movingId);
  const clamped = Math.max(0, Math.min(targetIndex, without.length));

  const before = clamped > 0 ? without[clamped - 1] : undefined;
  const after = clamped < without.length ? without[clamped] : undefined;

  return {
    stage: destinationStage,
    beforeId: before?.id ?? null,
    afterId: after?.id ?? null,
  };
}

/**
 * Apply a move to a board snapshot, for the optimistic update.
 *
 * Returns a NEW board - never mutates the cached one. TanStack Query hands back
 * the cached object directly, and mutating it would change what React sees
 * without changing the reference, so the UI would not re-render and the rollback
 * snapshot would already be corrupted.
 *
 * The placeholder order key is deliberately not a real fractional key. The
 * server computes the authoritative one; this value only has to sort correctly
 * against its neighbours for the fraction of a second before the response lands.
 */
export function applyOptimisticMove(
  applications: Application[],
  movingId: string,
  destinationStage: Stage,
  targetIndex: number,
): Application[] {
  const moving = applications.find((a) => a.id === movingId);
  if (!moving) return applications;

  const columns = groupByStage(applications);
  const destination = (columns[destinationStage] ?? []).filter((c) => c.id !== movingId);
  const clamped = Math.max(0, Math.min(targetIndex, destination.length));

  const before = clamped > 0 ? destination[clamped - 1] : undefined;
  const after = clamped < destination.length ? destination[clamped] : undefined;

  const optimisticOrder = interpolateOrder(before?.order ?? null, after?.order ?? null);

  return applications.map((app) =>
    app.id === movingId ? { ...app, stage: destinationStage, order: optimisticOrder } : app,
  );
}

/**
 * A throwaway string that sorts strictly between `before` and `after`.
 *
 * NOT the real fractional-indexing algorithm - the server runs that, and its
 * answer replaces this one the moment the response lands. This only has to sort
 * correctly for the fraction of a second in between.
 *
 * The trick is '!' (0x21), which is below every character a real order key can
 * contain (keys use 0-9, A-Z, a-z, starting at 0x30):
 *
 *   - appending it to `before` yields a string just above `before`, and still
 *     below `after` - a longer string sharing a prefix sorts after the shorter
 *     one, and '!' loses to any real character at the first differing position
 *   - PREPENDING it to `after` yields a string below `after`, which is what a
 *     drop at the top of a column needs
 *
 * The prepend case is easy to get wrong: appending a character to `after` makes
 * a key that sorts AFTER it, so the card lands second instead of first and
 * visibly jumps when the server's answer arrives.
 */
function interpolateOrder(before: string | null, after: string | null): string {
  if (before === null && after === null) return 'a0';
  if (before === null) return `!${after}`;
  return `${before}!`;
}

/**
 * Where within a column did the pointer land?
 *
 * dnd-kit reports the element the pointer is over, which may be a card or the
 * column itself. Dropping onto a card means "put it at that card's index";
 * dropping onto empty column space means "append".
 */
export function resolveDropIndex(
  destinationCards: Application[],
  overId: string,
  overIsColumn: boolean,
): number {
  if (overIsColumn) return destinationCards.length;

  const index = destinationCards.findIndex((card) => card.id === overId);
  return index === -1 ? destinationCards.length : index;
}
