import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { STAGE_LABELS, type Application, type Stage } from '@job-tracker/shared';
import { ApplicationCard } from './ApplicationCard.js';

interface ColumnProps {
  stage: Stage;
  applications: Application[];
  onOpenApplication: (id: string) => void;
}

/** Accent bar colour per stage, using the tokens defined in index.css. */
const STAGE_ACCENT: Record<Stage, string> = {
  wishlist: 'bg-stage-wishlist',
  applied: 'bg-stage-applied',
  screen: 'bg-stage-screen',
  onsite: 'bg-stage-onsite',
  offer: 'bg-stage-offer',
  rejected: 'bg-stage-rejected',
};

export function BoardColumn({ stage, applications, onOpenApplication }: ColumnProps) {
  /*
    The column itself is a drop target, separately from the cards inside it.
    Without this, dropping onto the empty space below the last card would find
    no droppable and the drag would be cancelled - which is exactly what a user
    does when moving a card into an empty column.
  */
  const { setNodeRef, isOver } = useDroppable({
    id: stage,
    data: { type: 'column', stage },
  });

  const ids = applications.map((a) => a.id);

  return (
    <section
      className="flex w-72 shrink-0 flex-col rounded-2xl bg-slate-100/70 dark:bg-slate-900/60"
      aria-label={`${STAGE_LABELS[stage]} column`}
    >
      <header className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className={`size-2 rounded-full ${STAGE_ACCENT[stage]}`} aria-hidden="true" />
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
          {STAGE_LABELS[stage]}
        </h2>
        <span className="ml-auto rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-400">
          {applications.length}
        </span>
      </header>

      <div
        ref={setNodeRef}
        className={`flex-1 rounded-b-2xl px-2 pb-2 transition-colors ${
          isOver ? 'bg-sky-100/60 dark:bg-sky-950/30' : ''
        }`}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          <ul className="flex min-h-24 flex-col gap-2">
            {applications.map((application) => (
              <ApplicationCard
                key={application.id}
                application={application}
                onOpen={onOpenApplication}
              />
            ))}
          </ul>
        </SortableContext>

        {applications.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-slate-400 dark:text-slate-600">
            Drop a card here
          </p>
        )}
      </div>
    </section>
  );
}
