'use client';

import type { Board, Card, Due } from '@kan/shared';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useState } from 'react';

import { BoardCard } from './card';
import { Composer } from './composer';

type List = Board['lists'][number];

export interface ColumnActions {
  addCard: (listId: string, title: string) => Promise<boolean>;
  renameCard: (card: Card, title: string) => Promise<boolean>;
  archiveCard: (card: Card) => Promise<boolean>;
  renameList: (list: List, name: string) => Promise<boolean>;
  archiveList: (list: List) => Promise<boolean>;
}

/**
 * One column.
 *
 * `useDroppable` on the column itself as well as `SortableContext` over the
 * cards, because an empty column has no sortable items and would otherwise not be
 * a drop target at all -- which is exactly the column somebody most wants to drag
 * the first card into.
 *
 * The WIP chip renders `list.wip.label`, the words `wipStateFor` produced, and
 * never derives its own from `list.wip.state`. That is the rule the whole palette
 * is built around: the three WIP inks separate by 1.23:1 in greyscale in light and
 * 1.02:1 in dark, so the words are not a caption on the colour, they are the
 * signal.
 */
export function Column({
  list,
  dueFor,
  canEdit,
  canManage,
  isOver,
  editingCardId,
  onEditCard,
  actions,
}: {
  list: List;
  dueFor: (card: Card) => Due;
  canEdit: boolean;
  /** Renaming and archiving a column are separate permissions from moving a card. */
  canManage: boolean;
  isOver: boolean;
  editingCardId: string | null;
  onEditCard: (cardId: string | null) => void;
  actions: ColumnActions;
}): JSX.Element {
  const { setNodeRef } = useDroppable({ id: list.id, data: { type: 'list' } });
  const [renaming, setRenaming] = useState(false);

  return (
    <section
      ref={setNodeRef}
      className={isOver ? 'column column-over' : 'column'}
      aria-label={`${list.name}, ${list.wip.label}`}
    >
      <header className="column-head">
        {renaming ? (
          <Composer
            label={`Rename ${list.name}`}
            buttonLabel="Rename"
            initialValue={list.name}
            maxLength={80}
            // Already open: `renaming` is true because somebody pressed Rename,
            // and a closed composer here would render a second Rename button
            // where the field was asked for.
            defaultOpen
            onSubmit={async (name) => {
              const ok = await actions.renameList(list, name);
              if (ok) setRenaming(false);
              return ok;
            }}
          />
        ) : (
          <>
            <h2 className="column-name">{list.name}</h2>
            {/*
              `aria-label` repeats the label rather than relying on the chip's
              text, because the chip is a bare count for the unlimited case
              ("7 cards") and a screen reader reaching it out of context would
              announce a number with no subject.
            */}
            <span
              className={`wip wip-${list.wip.state}`}
              aria-label={`Work in progress: ${list.wip.label}`}
            >
              {list.wip.label}
            </span>
            {canManage && (
              <>
                <button
                  type="button"
                  className="button button-quiet button-small"
                  onClick={() => setRenaming(true)}
                >
                  Rename<span className="visually-hidden"> {list.name}</span>
                </button>
                <button
                  type="button"
                  className="button button-quiet button-small"
                  onClick={() => void actions.archiveList(list)}
                >
                  Archive<span className="visually-hidden"> {list.name}</span>
                </button>
              </>
            )}
          </>
        )}
      </header>

      <SortableContext
        id={list.id}
        items={list.cards.map((card) => card.id)}
        strategy={verticalListSortingStrategy}
      >
        {/*
          `tabIndex={0}` on a scroll container, with a name.
          
          A column scrolls when it holds more cards than fit, and a region that
          scrolls with no way to focus it cannot be scrolled by keyboard at all --
          WCAG 2.1.1, and axe's `scrollable-region-focusable`. Firefox's engine
          reported it and Chromium's did not, which is the reason this suite runs
          both: the container is scrollable in both, and only one of them said so.
        */}
        <ul className="column-cards" tabIndex={0} aria-label={`Cards in ${list.name}`}>
          {list.cards.map((card) => (
            <BoardCard
              key={card.id}
              card={card}
              due={dueFor(card)}
              disabled={!canEdit}
              editing={editingCardId === card.id}
              onEdit={onEditCard}
              onRename={actions.renameCard}
              onArchive={actions.archiveCard}
            />
          ))}
          {list.cards.length === 0 && (
            <li className="card-placeholder">{isOver ? 'Drop here' : 'No cards'}</li>
          )}
        </ul>
      </SortableContext>

      {canEdit && (
        <div className="column-foot">
          <Composer
            label={`Title of the new card in ${list.name}`}
            buttonLabel={`+ Add a card to ${list.name}`}
            submitLabel="Add card"
            onSubmit={(title) => actions.addCard(list.id, title)}
          />
        </div>
      )}
    </section>
  );
}
