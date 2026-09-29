/**
 * Application detail: notes timeline and follow-up reminders.
 *
 * The timeline mixes what the user typed with what the system recorded - stage
 * changes and sent reminders - so the whole history of an application reads as
 * one story instead of three separate views the user has to correlate.
 */

import { useEffect, useRef, useState } from 'react';
import {
  REMINDER_PRESETS,
  STAGE_LABELS,
  type Note,
  type Reminder,
  type Stage,
} from '@job-tracker/shared';
import {
  useApplications,
  useCancelReminder,
  useCreateNote,
  useCreateReminder,
  useDeleteApplication,
  useNotes,
  useReminders,
} from './queries.js';
import { Button, EmptyState, ErrorBanner, Spinner, Textarea } from '../../components/ui.js';

interface DrawerProps {
  applicationId: string;
  onClose: () => void;
}

function formatDateTime(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

const NOTE_KIND_STYLE: Record<Note['kind'], string> = {
  note: 'border-slate-300 dark:border-slate-700',
  stage_change: 'border-sky-400 dark:border-sky-600',
  reminder_sent: 'border-amber-400 dark:border-amber-600',
};

export function ApplicationDrawer({ applicationId, onClose }: DrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  const { data: applications } = useApplications();
  const application = applications?.find((a) => a.id === applicationId);

  const { data: notes, isPending: notesPending } = useNotes(applicationId);
  const { data: reminders } = useReminders(applicationId);

  const createNote = useCreateNote(applicationId);
  const createReminder = useCreateReminder(applicationId);
  const cancelReminder = useCancelReminder(applicationId);
  const deleteApplication = useDeleteApplication();

  const [noteBody, setNoteBody] = useState('');
  const [reminderFeedback, setReminderFeedback] = useState<string | null>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  if (!application) return null;

  async function handleAddNote(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const body = noteBody.trim();
    if (!body) return;

    await createNote.mutateAsync({ body });
    setNoteBody('');
  }

  async function handleAddReminder(days: number): Promise<void> {
    const dueAt = new Date(Date.now() + days * 86_400_000);
    const result = await createReminder.mutateAsync({
      dueAt,
      message: `Follow up on ${application?.role} at ${application?.company}`,
    });

    // The API absorbs a duplicate rather than erroring, and says so. Telling the
    // user "already scheduled" is more honest than silently doing nothing.
    setReminderFeedback(
      result.deduplicated
        ? 'That reminder was already scheduled.'
        : `Reminder set for ${formatDateTime(dueAt)}.`,
    );
  }

  const scheduled = (reminders ?? []).filter((r) => r.status === 'scheduled');
  const past = (reminders ?? []).filter((r) => r.status !== 'scheduled');

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      className="m-0 ml-auto h-dvh w-full max-w-lg rounded-none bg-white p-0 backdrop:bg-slate-900/40 dark:bg-slate-900"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-start gap-4 border-b border-slate-200 p-6 dark:border-slate-800">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{application.company}</h2>
            <p className="truncate text-sm text-slate-600 dark:text-slate-400">
              {application.role}
            </p>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-500">
              {STAGE_LABELS[application.stage as Stage]}
              {application.location ? ` · ${application.location}` : ''}
            </p>
            {application.url && (
              <a
                href={application.url}
                target="_blank"
                // noreferrer as well as noopener: without it the destination can
                // read where the link came from, and with older browsers the new
                // tab can navigate this one.
                rel="noopener noreferrer"
                className="mt-2 inline-block text-xs font-medium text-sky-600 hover:underline dark:text-sky-400"
              >
                View posting ↗
              </a>
            )}
          </div>
          <Button variant="ghost" className="ml-auto" onClick={() => dialogRef.current?.close()}>
            Close
          </Button>
        </header>

        <div className="flex-1 space-y-8 overflow-y-auto p-6">
          {/* ---------------------------------------------------------- */}
          <section>
            <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-300">
              Follow-up reminders
            </h3>

            <div className="flex flex-wrap gap-2">
              {REMINDER_PRESETS.map((preset) => (
                <Button
                  key={preset.days}
                  variant="secondary"
                  isLoading={createReminder.isPending}
                  onClick={() => void handleAddReminder(preset.days)}
                >
                  {preset.label}
                </Button>
              ))}
            </div>

            {reminderFeedback && (
              <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">{reminderFeedback}</p>
            )}
            {createReminder.isError && (
              <div className="mt-3">
                <ErrorBanner message={createReminder.error.message} />
              </div>
            )}

            {scheduled.length > 0 && (
              <ul className="mt-4 space-y-2">
                {scheduled.map((reminder) => (
                  <ReminderRow
                    key={reminder.id}
                    reminder={reminder}
                    onCancel={() => cancelReminder.mutate(reminder.id)}
                  />
                ))}
              </ul>
            )}

            {past.length > 0 && (
              <ul className="mt-2 space-y-2 opacity-60">
                {past.map((reminder) => (
                  <ReminderRow key={reminder.id} reminder={reminder} />
                ))}
              </ul>
            )}
          </section>

          {/* ---------------------------------------------------------- */}
          <section>
            <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-300">
              Timeline
            </h3>

            <form onSubmit={handleAddNote} className="space-y-2">
              <Textarea
                rows={3}
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                placeholder="Recruiter said they'd call Thursday…"
                aria-label="Add a note"
              />
              <div className="flex justify-end">
                <Button
                  type="submit"
                  isLoading={createNote.isPending}
                  disabled={!noteBody.trim()}
                >
                  Add note
                </Button>
              </div>
            </form>

            {notesPending ? (
              <Spinner className="mt-4 text-slate-400" />
            ) : notes && notes.length > 0 ? (
              <ul className="mt-4 space-y-3">
                {notes.map((note) => (
                  <li
                    key={note.id}
                    className={`border-l-2 pl-3 ${NOTE_KIND_STYLE[note.kind]}`}
                  >
                    <p className="text-sm whitespace-pre-wrap text-slate-700 dark:text-slate-300">
                      {note.body}
                    </p>
                    <p className="mt-1 text-xs text-slate-400 dark:text-slate-600">
                      {formatDateTime(note.createdAt)}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="mt-4">
                <EmptyState
                  title="Nothing here yet"
                  description="Notes, stage changes and sent reminders all show up on this timeline."
                />
              </div>
            )}
          </section>
        </div>

        <footer className="border-t border-slate-200 p-6 dark:border-slate-800">
          <Button
            variant="danger"
            isLoading={deleteApplication.isPending}
            onClick={() => {
              deleteApplication.mutate(applicationId, {
                onSuccess: () => dialogRef.current?.close(),
              });
            }}
          >
            Delete application
          </Button>
        </footer>
      </div>
    </dialog>
  );
}

/* -------------------------------------------------------------------------- */

function ReminderRow({ reminder, onCancel }: { reminder: Reminder; onCancel?: () => void }) {
  return (
    <li className="flex items-center gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
      <span className="text-slate-700 dark:text-slate-300">{formatDateTime(reminder.dueAt)}</span>
      <span className="text-xs text-slate-500 dark:text-slate-500">{reminder.status}</span>
      {onCancel && (
        <Button variant="ghost" className="ml-auto px-2 py-1 text-xs" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </li>
  );
}
