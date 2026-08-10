'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A one-field inline form that a button turns into.
 *
 * Used for every "add a card", "add a list" and "rename" on the board, which is
 * why it is one component rather than five: they all have the same three states
 * (a button, an open field, a pending submit) and the same three keyboard
 * expectations, and five copies is five chances to forget the Escape handler.
 *
 * **Not a `window.prompt`.** The board's first draft used one, and it is wrong on
 * three counts: it blocks the event loop so an incoming `card.moved` is not
 * applied until it closes, it cannot be styled or labelled, and it is invisible
 * to any test driver that has not been told to expect a dialog. It is also the
 * one control on the page a screen-reader user cannot get a label for.
 *
 * **Not a modal either.** A dialog for a single text field is a focus trap
 * somebody has to escape from, over a board they were looking at. This opens in
 * place, takes focus, and gives it back to the button on Escape -- which is where
 * focus was, so nothing is lost.
 */
export function Composer({
  label,
  buttonLabel,
  initialValue = '',
  submitLabel = 'Save',
  maxLength = 200,
  defaultOpen = false,
  onSubmit,
}: {
  /** The field's accessible name. Never a placeholder: those are not labels. */
  label: string;
  /** The trigger's text, when the form is closed. */
  buttonLabel: string;
  initialValue?: string;
  submitLabel?: string;
  maxLength?: number;
  /**
   * Open on mount, with no trigger button.
   *
   * For the card editor, where the surrounding component has already decided the
   * card is being edited: rendering a "Rename" button inside an editing card
   * would be a second click to reach a field the person has already asked for.
   */
  defaultOpen?: boolean;
  /** Resolves when the server has answered. The form stays open on failure. */
  onSubmit: (value: string) => Promise<boolean>;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [value, setValue] = useState(initialValue);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /**
   * Whether focus owes a return trip to the trigger.
   *
   * A ref rather than a branch inside `close`, because the trigger does not
   * exist at the moment `close` runs: it was unmounted when the form opened, so
   * `triggerRef.current` is null and the focus call is a silent no-op. That was
   * the bug -- Escape closed the form and dropped focus to `<body>`, so the next
   * Tab restarted from the top of the document, which is exactly the thing a
   * keyboard user notices and a mouse user never does. The effect below runs
   * after React has put the button back.
   */
  const restoreFocus = useRef(false);

  // Focus moves into the field when it opens. This is the one place autofocus is
  // right: the person pressed a button whose entire purpose is to produce this
  // field, so focus arriving there is what they asked for -- unlike a page that
  // steals focus on load.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (open || !restoreFocus.current) return;
    restoreFocus.current = false;
    triggerRef.current?.focus();
  }, [open]);

  const close = (): void => {
    // Only when there is a trigger to go back to. An always-open composer inside
    // a card editor has none, and the card's own Done button is where focus
    // belongs there.
    restoreFocus.current = !defaultOpen;
    setOpen(false);
    setValue(initialValue);
  };

  if (!open) {
    return (
      <button
        ref={triggerRef}
        type="button"
        className="button button-quiet button-small"
        onClick={() => setOpen(true)}
      >
        {buttonLabel}
      </button>
    );
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (trimmed === '' || pending) return;
        setPending(true);
        void onSubmit(trimmed).then((ok) => {
          setPending(false);
          if (ok) close();
          // On failure the field keeps what was typed and stays open. The error
          // itself is rendered by the board, once, rather than by every form.
        });
      }}
      // Escape closes, from anywhere inside. On the form rather than the input so
      // it works from the buttons too.
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <label className="visually-hidden" htmlFor={`composer-${label}`}>
        {label}
      </label>
      <input
        ref={inputRef}
        id={`composer-${label}`}
        className="composer-input"
        type="text"
        value={value}
        maxLength={maxLength}
        onChange={(event) => setValue(event.target.value)}
        aria-label={label}
      />
      <div className="row">
        <button type="submit" className="button button-primary button-small" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </button>
        <button type="button" className="button button-small" onClick={close} disabled={pending}>
          Cancel
        </button>
      </div>
    </form>
  );
}
