import { useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  COMMON_SOURCES,
  STAGE_LABELS,
  STAGES,
  createApplicationSchema,
  type CreateApplicationInput,
} from '@job-tracker/shared';
import { useCreateApplication } from './queries.js';
import { ApiRequestError } from '../../lib/api.js';
import { Button, ErrorBanner, Field, Input } from '../../components/ui.js';

/**
 * Add an application.
 *
 * Built on the native <dialog> element rather than a div-with-a-backdrop:
 * showModal() gives focus trapping, Escape-to-close, inert background content
 * and the top layer for free. Re-implementing those correctly in React is a
 * surprising amount of work to get wrong.
 */
export function NewApplicationDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const createApplication = useCreateApplication();

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<CreateApplicationInput>({
    resolver: zodResolver(createApplicationSchema),
    defaultValues: { stage: 'wishlist' },
  });

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const onSubmit = handleSubmit(async (values) => {
    try {
      await createApplication.mutateAsync(values);
      onClose();
    } catch (err) {
      if (err instanceof ApiRequestError && err.fields) {
        for (const [field, message] of Object.entries(err.fields)) {
          setError(field as never, { type: 'server', message });
        }
      }
    }
  });

  return (
    <dialog
      ref={dialogRef}
      // Fires on Escape as well as an explicit close, so the React state that
      // renders this component is always kept in step with the dialog.
      onClose={onClose}
      className="m-auto w-full max-w-md rounded-2xl bg-white p-0 backdrop:bg-slate-900/40 dark:bg-slate-900"
    >
      <form onSubmit={onSubmit} className="space-y-4 p-6" noValidate>
        <h2 className="text-lg font-semibold">Add application</h2>

        {/*
          Field-level errors are already attached to their inputs by onSubmit,
          so only show the banner for failures that belong to no single field.
        */}
        {createApplication.isError &&
          !(
            createApplication.error instanceof ApiRequestError &&
            createApplication.error.isValidationError
          ) && <ErrorBanner message={createApplication.error.message} />}

        <Field label="Company" htmlFor="company" error={errors.company?.message}>
          <Input id="company" autoFocus {...register('company')} />
        </Field>

        <Field label="Role" htmlFor="role" error={errors.role?.message}>
          <Input id="role" {...register('role')} />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Stage" htmlFor="stage" error={errors.stage?.message}>
            <select
              id="stage"
              className="w-full rounded-lg border-0 px-3 py-2 text-sm ring-1 ring-slate-300 focus:ring-2 focus:ring-sky-500 dark:bg-slate-800 dark:ring-slate-700"
              {...register('stage')}
            >
              {STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {STAGE_LABELS[stage]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Location" htmlFor="location" error={errors.location?.message}>
            <Input id="location" placeholder="Remote" {...register('location')} />
          </Field>
        </div>

        <Field
          label="Posting URL"
          htmlFor="url"
          error={errors.url?.message}
          hint="Optional, but handy when the listing disappears."
        >
          <Input id="url" type="url" placeholder="https://" {...register('url')} />
        </Field>

        <Field label="Source" htmlFor="source" error={errors.source?.message}>
          <Input id="source" list="sources" placeholder="LinkedIn" {...register('source')} />
          <datalist id="sources">
            {COMMON_SOURCES.map((source) => (
              <option key={source} value={source} />
            ))}
          </datalist>
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Salary min" htmlFor="salaryMin" error={errors.salaryMin?.message}>
            <Input
              id="salaryMin"
              type="number"
              inputMode="numeric"
              {...register('salaryMin', { setValueAs: (v) => (v === '' ? undefined : Number(v)) })}
            />
          </Field>
          <Field label="Salary max" htmlFor="salaryMax" error={errors.salaryMax?.message}>
            <Input
              id="salaryMax"
              type="number"
              inputMode="numeric"
              {...register('salaryMax', { setValueAs: (v) => (v === '' ? undefined : Number(v)) })}
            />
          </Field>
          <Field label="Currency" htmlFor="currency" error={errors.currency?.message}>
            <Input id="currency" placeholder="USD" maxLength={3} {...register('currency')} />
          </Field>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={() => dialogRef.current?.close()}>
            Cancel
          </Button>
          <Button type="submit" isLoading={isSubmitting}>
            Add
          </Button>
        </div>
      </form>
    </dialog>
  );
}
