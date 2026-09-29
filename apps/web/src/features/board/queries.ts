/**
 * Server state for the board.
 *
 * Everything the server owns lives in TanStack Query, not in useState. That
 * distinction is the single biggest structural improvement over the
 * useEffect-plus-useState fetching most tutorials teach: caching, deduplication,
 * background refetching, loading and error states, and - the reason this file is
 * worth reading - optimistic updates with automatic rollback all come from it.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  Application,
  CreateApplicationInput,
  CreateNoteInput,
  CreateReminderInput,
  Note,
  Reminder,
  Stage,
  UpdateApplicationInput,
} from '@job-tracker/shared';
import { apiRequest } from '../../lib/api.js';
import { applyOptimisticMove, type MoveRequest } from './reorder.js';

/**
 * Query keys as a typed factory rather than scattered string arrays.
 *
 * Invalidation is only as reliable as key consistency: a stray
 * ['applications'] somewhere that should have been ['applications', 'list']
 * produces a cache that silently never updates. One factory, one source of truth.
 */
export const boardKeys = {
  all: ['applications'] as const,
  list: (includeArchived: boolean) => ['applications', 'list', { includeArchived }] as const,
  detail: (id: string) => ['applications', 'detail', id] as const,
  notes: (id: string) => ['applications', id, 'notes'] as const,
  reminders: (id: string) => ['applications', id, 'reminders'] as const,
};

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

export function useApplications(includeArchived = false) {
  return useQuery({
    queryKey: boardKeys.list(includeArchived),
    queryFn: () =>
      apiRequest<{ applications: Application[] }>(
        `/applications?includeArchived=${includeArchived}`,
      ).then((r) => r.applications),
    // The board is the app's home screen and is revisited constantly; 30s of
    // staleness avoids a refetch storm on every tab focus without ever showing
    // meaningfully old data.
    staleTime: 30_000,
  });
}

export function useNotes(applicationId: string | null) {
  return useQuery({
    queryKey: boardKeys.notes(applicationId ?? ''),
    queryFn: () =>
      apiRequest<{ notes: Note[] }>(`/applications/${applicationId}/notes`).then((r) => r.notes),
    enabled: Boolean(applicationId),
  });
}

export function useReminders(applicationId: string | null) {
  return useQuery({
    queryKey: boardKeys.reminders(applicationId ?? ''),
    queryFn: () =>
      apiRequest<{ reminders: Reminder[] }>(`/applications/${applicationId}/reminders`).then(
        (r) => r.reminders,
      ),
    enabled: Boolean(applicationId),
  });
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

export function useCreateApplication() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateApplicationInput) =>
      apiRequest<{ application: Application }>('/applications', {
        method: 'POST',
        body: input,
      }).then((r) => r.application),
    onSuccess: () => {
      // Not optimistic: the server assigns the id and the order key, and
      // inventing a temporary id here would mean reconciling it afterwards for
      // no real gain - creating a card is a deliberate action where a brief
      // spinner is entirely acceptable.
      void queryClient.invalidateQueries({ queryKey: boardKeys.all });
    },
  });
}

export function useUpdateApplication() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateApplicationInput }) =>
      apiRequest<{ application: Application }>(`/applications/${id}`, {
        method: 'PATCH',
        body: input,
      }).then((r) => r.application),
    onSuccess: (updated) => {
      // Write the server's version straight into the cache so the drawer updates
      // instantly, then invalidate so any derived view stays consistent.
      patchApplicationInCache(queryClient, updated);
      void queryClient.invalidateQueries({ queryKey: boardKeys.all });
    },
  });
}

export function useDeleteApplication() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => apiRequest<void>(`/applications/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: boardKeys.all }),
  });
}

/* -------------------------------------------------------------------------- */
/* The optimistic move                                                         */
/* -------------------------------------------------------------------------- */

export interface MoveVariables {
  id: string;
  targetIndex: number;
  move: MoveRequest;
}

/**
 * Move a card, updating the UI before the server has agreed.
 *
 * Drag-and-drop is the one interaction where waiting for a round trip is
 * genuinely unacceptable - a card that snaps back to its old position for 200ms
 * before jumping to the new one feels broken even though it is technically
 * correct. So the cache is updated the instant the drag ends.
 *
 * The lifecycle, which is the part worth learning:
 *
 *   onMutate  - cancel in-flight refetches (a response that started before the
 *               drag would otherwise land afterwards and overwrite the
 *               optimistic state), snapshot the cache, apply the change.
 *   onError   - restore the snapshot. The card visibly slides back, which is
 *               honest: the move did not happen.
 *   onSettled - refetch either way, so the server's real order key replaces the
 *               placeholder and any concurrent change by another session shows up.
 */
export function useMoveApplication() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, move }: MoveVariables) =>
      apiRequest<{ application: Application }>(`/applications/${id}/move`, {
        method: 'POST',
        body: move,
      }).then((r) => r.application),

    onMutate: async ({ id, targetIndex, move }: MoveVariables) => {
      const key = boardKeys.list(false);

      // Critical: a refetch already in flight would resolve after this and clobber
      // the optimistic update, making the card jump back for no visible reason.
      await queryClient.cancelQueries({ queryKey: boardKeys.all });

      const previous = queryClient.getQueryData<Application[]>(key);

      if (previous) {
        queryClient.setQueryData<Application[]>(
          key,
          applyOptimisticMove(previous, id, move.stage as Stage, targetIndex),
        );
      }

      // Returned as mutation context, so onError can put it back.
      return { previous, key };
    },

    onError: (_err, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.key, context.previous);
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: boardKeys.all });
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Notes and reminders                                                         */
/* -------------------------------------------------------------------------- */

export function useCreateNote(applicationId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateNoteInput) =>
      apiRequest<{ note: Note }>(`/applications/${applicationId}/notes`, {
        method: 'POST',
        body: input,
      }).then((r) => r.note),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: boardKeys.notes(applicationId) });
      // The card badge count changed too.
      void queryClient.invalidateQueries({ queryKey: boardKeys.all });
    },
  });
}

export function useDeleteNote(applicationId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (noteId: string) =>
      apiRequest<void>(`/applications/${applicationId}/notes/${noteId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: boardKeys.notes(applicationId) });
      void queryClient.invalidateQueries({ queryKey: boardKeys.all });
    },
  });
}

export function useCreateReminder(applicationId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: CreateReminderInput) =>
      apiRequest<{ reminder: Reminder; deduplicated?: boolean }>(
        `/applications/${applicationId}/reminders`,
        { method: 'POST', body: input },
      ),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: boardKeys.reminders(applicationId) }),
  });
}

export function useCancelReminder(applicationId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (reminderId: string) =>
      apiRequest<void>(`/applications/${applicationId}/reminders/${reminderId}`, {
        method: 'DELETE',
      }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: boardKeys.reminders(applicationId) }),
  });
}

/* -------------------------------------------------------------------------- */

/** Replace one application in every cached board list, without a refetch. */
function patchApplicationInCache(queryClient: QueryClient, updated: Application): void {
  for (const includeArchived of [false, true]) {
    queryClient.setQueryData<Application[]>(boardKeys.list(includeArchived), (current) =>
      current?.map((app) => (app.id === updated.id ? updated : app)),
    );
  }
}
