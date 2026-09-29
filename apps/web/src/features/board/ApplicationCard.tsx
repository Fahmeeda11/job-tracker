import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Application } from '@job-tracker/shared';

interface CardProps {
  application: Application;
  onOpen: (id: string) => void;
}

function formatSalary(app: Application): string | null {
  if (app.salaryMin === undefined && app.salaryMax === undefined) return null;
  const currency = app.currency ?? 'USD';
  const format = (n: number) =>
    // Compact notation keeps "120K" rather than "120,000" - cards are narrow and
    // the precise figure is in the drawer anyway.
    new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 0,
    }).format(n);

  if (app.salaryMin !== undefined && app.salaryMax !== undefined) {
    return `${format(app.salaryMin)} – ${format(app.salaryMax)}`;
  }
  return format((app.salaryMin ?? app.salaryMax) as number);
}

function relativeDate(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = typeof value === 'string' ? new Date(value) : value;
  const days = Math.round((Date.now() - date.getTime()) / 86_400_000);

  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

export function ApplicationCard({ application, onOpen }: CardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: application.id,
    data: { type: 'card', stage: application.stage },
  });

  const salary = formatSalary(application);
  const applied = relativeDate(application.appliedAt);

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? 'card-dragging' : undefined}
    >
      {/*
        The whole card is a button so it is reachable and activatable by
        keyboard. The drag listeners live on it too - dnd-kit's KeyboardSensor
        turns space/arrow keys into a drag, which is the only way this board is
        usable without a mouse.
      */}
      <button
        type="button"
        onClick={() => onOpen(application.id)}
        {...attributes}
        {...listeners}
        className="w-full cursor-grab rounded-xl bg-white p-3 text-left shadow-sm ring-1 ring-slate-200 transition-shadow hover:shadow-md active:cursor-grabbing dark:bg-slate-900 dark:ring-slate-800"
      >
        <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
          {application.company}
        </p>
        <p className="mt-0.5 truncate text-sm text-slate-600 dark:text-slate-400">
          {application.role}
        </p>

        {(application.location || salary) && (
          <p className="mt-2 truncate text-xs text-slate-500 dark:text-slate-500">
            {[application.location, salary].filter(Boolean).join(' · ')}
          </p>
        )}

        {(applied || application.noteCount > 0) && (
          <div className="mt-2.5 flex items-center gap-3 text-xs text-slate-400 dark:text-slate-500">
            {applied && <span>Applied {applied}</span>}
            {application.noteCount > 0 && (
              <span className="inline-flex items-center gap-1">
                <svg viewBox="0 0 16 16" className="size-3 fill-current" aria-hidden="true">
                  <path d="M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6l-3 3V11H3a1 1 0 0 1-1-1V3Z" />
                </svg>
                <span className="sr-only">Notes: </span>
                {application.noteCount}
              </span>
            )}
          </div>
        )}
      </button>
    </li>
  );
}

/** The card rendered inside DragOverlay - no sortable wiring, just the visuals. */
export function ApplicationCardPreview({ application }: { application: Application }) {
  return (
    <div className="w-full rotate-2 cursor-grabbing rounded-xl bg-white p-3 shadow-lg ring-1 ring-slate-300 dark:bg-slate-900 dark:ring-slate-700">
      <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
        {application.company}
      </p>
      <p className="mt-0.5 truncate text-sm text-slate-600 dark:text-slate-400">
        {application.role}
      </p>
    </div>
  );
}
