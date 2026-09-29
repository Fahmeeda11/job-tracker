/**
 * The board.
 *
 * Owns the drag-and-drop context and turns a completed drag into a move request.
 * All the index arithmetic lives in reorder.ts, which is pure and unit-tested -
 * this component's job is to translate dnd-kit events into calls to it.
 */

import { useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { STAGES, type Stage } from '@job-tracker/shared';
import { useApplications, useMoveApplication } from './queries.js';
import { computeMove, groupByStage, resolveDropIndex } from './reorder.js';
import { BoardColumn } from './BoardColumn.js';
import { ApplicationCardPreview } from './ApplicationCard.js';
import { ApplicationDrawer } from './ApplicationDrawer.js';
import { NewApplicationDialog } from './NewApplicationDialog.js';
import { Button, ErrorBanner, Spinner } from '../../components/ui.js';
import { useAuth } from '../../lib/auth.js';

export function BoardPage() {
  const { user, logout } = useAuth();
  const { data: applications, isPending, error } = useApplications();
  const moveApplication = useMoveApplication();

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [openApplicationId, setOpenApplicationId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      /*
        An 8px threshold before a drag starts. Without it, the click that opens
        a card's detail drawer registers as a 1px drag and the drawer never
        opens - the single most common complaint about draggable cards.
      */
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const columns = useMemo(() => groupByStage(applications ?? []), [applications]);
  const draggingApplication = applications?.find((a) => a.id === draggingId) ?? null;

  function handleDragStart(event: DragStartEvent): void {
    setDraggingId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    setDraggingId(null);

    // Dropped outside any droppable.
    if (!over) return;

    const movingId = String(active.id);
    const overId = String(over.id);
    const overData = over.data.current as { type?: string; stage?: Stage } | undefined;

    const overIsColumn = overData?.type === 'column';
    const destinationStage = (overData?.stage ?? null) as Stage | null;
    if (!destinationStage) return;

    const destinationCards = columns[destinationStage] ?? [];
    const targetIndex = resolveDropIndex(destinationCards, overId, overIsColumn);

    // No-op guard: dropped exactly where it started. Skipping the request keeps
    // the timeline clean and avoids a pointless write.
    const current = applications?.find((a) => a.id === movingId);
    if (current?.stage === destinationStage) {
      const currentIndex = destinationCards.findIndex((c) => c.id === movingId);
      if (currentIndex === targetIndex || currentIndex === targetIndex - 1) return;
    }

    moveApplication.mutate({
      id: movingId,
      targetIndex,
      move: computeMove(movingId, destinationStage, destinationCards, targetIndex),
    });
  }

  /* ---------------------------------------------------------------------- */

  if (isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner className="size-6 text-slate-400" />
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex items-center gap-4 border-b border-slate-200 px-6 py-3 dark:border-slate-800">
        <h1 className="text-lg font-semibold tracking-tight">Job Tracker</h1>
        <div className="ml-auto flex items-center gap-3">
          <Button onClick={() => setIsCreating(true)}>Add application</Button>
          <span className="hidden text-sm text-slate-500 sm:inline dark:text-slate-400">
            {user?.name}
          </span>
          <Button variant="ghost" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-x-auto p-6">
        {error && <ErrorBanner message={error.message} />}

        {/*
          The move mutation's own error. The optimistic update has already been
          rolled back by this point, so the card is visibly back where it was -
          this explains why.
        */}
        {moveApplication.isError && (
          <div className="mb-4">
            <ErrorBanner message={moveApplication.error.message} />
          </div>
        )}

        <DndContext
          sensors={sensors}
          // closestCorners beats the default rectangle intersection for columns
          // of differing heights: it picks the nearest slot rather than requiring
          // real overlap, which makes dropping near a short column much easier.
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setDraggingId(null)}
        >
          <div className="flex gap-4">
            {STAGES.map((stage) => (
              <BoardColumn
                key={stage}
                stage={stage}
                applications={columns[stage] ?? []}
                onOpenApplication={setOpenApplicationId}
              />
            ))}
          </div>

          {/*
            DragOverlay renders the card in a portal that follows the cursor,
            so the dragged card is not clipped by the column's overflow and does
            not disturb the layout of the list it came from.
          */}
          <DragOverlay dropAnimation={null}>
            {draggingApplication && <ApplicationCardPreview application={draggingApplication} />}
          </DragOverlay>
        </DndContext>
      </main>

      {openApplicationId && (
        <ApplicationDrawer
          applicationId={openApplicationId}
          onClose={() => setOpenApplicationId(null)}
        />
      )}

      {isCreating && <NewApplicationDialog onClose={() => setIsCreating(false)} />}
    </div>
  );
}
