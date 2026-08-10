'use client';

import { useFormState, useFormStatus } from 'react-dom';

import { createBoardAction } from '../actions';
import { Notice } from '../../../components/notice';

/**
 * Create a board.
 *
 * Inline on the list rather than behind a modal: it is one field, and a dialog
 * for one field is a focus trap somebody has to escape from.
 *
 * The label is visible rather than a placeholder. A placeholder disappears the
 * moment somebody types, which leaves the field unlabelled for exactly the people
 * who most need the label, and it is not an accessible name.
 */
export function NewBoardForm(): JSX.Element {
  const [result, action] = useFormState(createBoardAction, null);

  return (
    <form action={action} className="panel" style={{ marginBottom: 'var(--s-6)' }} noValidate>
      <Notice result={result} />
      <div className="row">
        <div className="field grow" style={{ marginBottom: 0 }}>
          <label htmlFor="board-name">New board</label>
          <input id="board-name" name="name" type="text" maxLength={120} required />
        </div>
        <Submit />
      </div>
    </form>
  );
}

function Submit(): JSX.Element {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="button button-primary" disabled={pending}>
      {pending ? 'Creating…' : 'Create board'}
    </button>
  );
}
