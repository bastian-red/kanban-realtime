'use client';

import type { Card, Due } from '@kan/shared';
import { dueLabel } from '@kan/shared';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { Composer } from './composer';

/**
 * One card, draggable by pointer and by keyboard.
 *
 * The drag handle is a `<button>`, not the card `<div>`. That is what gives
 * dnd-kit's keyboard sensor something to focus: tab to the handle, press space,
 * move with the arrow keys, press space again. A `div` with `tabIndex={0}` would
 * look identical and would not be announced as operable.
 *
 * The handle is separate from the title for a reason that only shows up on a
 * keyboard: if the whole card were the drag source *and* the edit trigger, space
 * would have to mean both "lift" and "open", and dnd-kit claims space. Splitting
 * them means the title button opens the card and the handle moves it, and both
 * are reachable in one Tab each.
 *
 * The due badge is `dueLabel(due)` -- "Overdue by 3 days", not a red date --
 * because `--wip-over` against `--muted` separates by 1.12:1 in greyscale, which
 * is to say not at all (see `lib/contrast.test.ts`). Labels carry their names for
 * the same reason: a row of coloured rails is one channel.
 */
export function BoardCard({
  card,
  due,
  disabled,
  editing,
  onEdit,
  onRename,
  onArchive,
}: {
  card: Card;
  due: Due;
  /** Viewers cannot move or edit. dnd-kit is told, so the handle is not a drag source. */
  disabled: boolean;
  editing: boolean;
  onEdit: (cardId: string | null) => void;
  onRename: (card: Card, title: string) => Promise<boolean>;
  onArchive: (card: Card) => Promise<boolean>;
}): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
    disabled,
    data: { type: 'card', listId: card.listId },
  });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={isDragging ? 'card card-dragging' : 'card'}
    >
      {editing ? (
        <>
          <Composer
            label={`Rename ${card.title}`}
            buttonLabel="Rename"
            initialValue={card.title}
            submitLabel="Save"
            // Already open: the card is in editing mode because somebody clicked
            // its title, and a button to reveal the field they just asked for is
            // one click too many.
            defaultOpen
            onSubmit={(title) => onRename(card, title)}
          />
          <div className="row">
            {/*
              The name says what it archives. A board has one Archive button per
              column plus this one, and "Archive" alone is five identical
              accessible names -- ambiguous to a screen reader reading the page
              out of order, and to anything driving it.
            */}
            <button
              type="button"
              className="button button-small"
              onClick={() => void onArchive(card)}
            >
              Archive<span className="visually-hidden"> {card.title}</span>
            </button>
            <button type="button" className="button button-small" onClick={() => onEdit(null)}>
              Done<span className="visually-hidden"> editing {card.title}</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="card-top">
            <button
              type="button"
              className="card-title"
              onClick={() => onEdit(card.id)}
              disabled={disabled}
            >
              {card.title}
            </button>
            {!disabled && (
              <button
                type="button"
                className="card-handle"
                // dnd-kit's own attributes carry `role`, `aria-roledescription` and
                // the describedby pointing at its live region. Spreading them is
                // what makes "Draggable item. Press space bar to lift" reach a
                // screen reader.
                {...attributes}
                {...listeners}
                aria-label={`Move ${card.title}`}
              >
                <span aria-hidden="true">⠿</span>
              </button>
            )}
          </div>

          {(card.labels.length > 0 || due.state !== 'none') && (
            <div className="card-meta">
              {card.labels.length > 0 && (
                <span className="card-labels">
                  {card.labels.map((label) => (
                    <span key={label.id} className={`label-chip hue-${label.colorSlot}`}>
                      {label.name}
                    </span>
                  ))}
                </span>
              )}
              {due.state !== 'none' && (
                <span className={due.state === 'overdue' ? 'due due-overdue' : 'due'}>
                  {dueLabel(due)}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}
