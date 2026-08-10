/**
 * The REST surface.
 *
 * Every handler is thin on purpose: validate with the shared zod schema, call the
 * service, return the row. There is no business logic here, because the same
 * business logic has to be reachable from `apps/realtime`, and anything that
 * lived in a controller would be reachable from exactly one transport.
 *
 * `BoardOpError` is turned into an HTTP status by `BoardErrorFilter`, not by
 * try/catch in each handler. That mapping is one table in one place, and it is
 * the same table the gateway uses to fill in an ack's `code`.
 */
import type { BoardRole } from '@kan/shared';
import {
  activityQuerySchema,
  addMemberSchema,
  archiveCardSchema,
  createBoardSchema,
  createCardSchema,
  createListSchema,
  moveCardSchema,
  moveListSchema,
  renameBoardSchema,
  updateCardSchema,
  updateListSchema,
  updateMemberSchema,
  wireDayToUtc,
} from '@kan/shared';
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../common/current-user.decorator';
import type { TokenUser } from '../common/service-token.guard';
import { OrdinaryRate } from '../common/rate-limit';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { BoardsService } from './boards.service';

@Controller('boards')
@OrdinaryRate()
export class BoardsController {
  constructor(@Inject(BoardsService) private readonly boards: BoardsService) {}

  @Get()
  list(@CurrentUser() user: TokenUser) {
    return this.boards.listBoards(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: TokenUser,
    @Body(new ZodValidationPipe(createBoardSchema)) body: { name: string },
  ) {
    return this.boards.createBoard(user.id, body.name);
  }

  @Get(':boardId')
  get(@CurrentUser() user: TokenUser, @Param('boardId') boardId: string) {
    return this.boards.getBoard(boardId, user.id);
  }

  @Patch(':boardId')
  rename(
    @CurrentUser() user: TokenUser,
    @Param('boardId') boardId: string,
    @Body(new ZodValidationPipe(renameBoardSchema)) body: { name: string },
  ) {
    return this.boards.renameBoard(boardId, user, body.name);
  }

  @Get(':boardId/members')
  members(@CurrentUser() user: TokenUser, @Param('boardId') boardId: string) {
    return this.boards.members(boardId, user.id);
  }

  @Post(':boardId/members')
  addMember(
    @CurrentUser() user: TokenUser,
    @Param('boardId') boardId: string,
    @Body(new ZodValidationPipe(addMemberSchema)) body: { email: string; role: BoardRole },
  ) {
    return this.boards.addMember(boardId, user, body.email, body.role);
  }

  @Patch(':boardId/members/:userId')
  updateMember(
    @CurrentUser() user: TokenUser,
    @Param('boardId') boardId: string,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(updateMemberSchema)) body: { role: BoardRole },
  ) {
    return this.boards.updateMemberRole(boardId, user, userId, body.role);
  }

  @Delete(':boardId/members/:userId')
  removeMember(
    @CurrentUser() user: TokenUser,
    @Param('boardId') boardId: string,
    @Param('userId') userId: string,
  ) {
    return this.boards.removeMember(boardId, user, userId);
  }

  /**
   * A hard delete, and the only one in this API.
   *
   * `DELETE` rather than an archive flag because the schema cascades from the
   * board down: there is no half-deleted state to represent. Cards and lists are
   * archived instead, which is a different verb for a different intent.
   */
  @Delete(':boardId')
  deleteBoard(@CurrentUser() user: TokenUser, @Param('boardId') boardId: string) {
    return this.boards.deleteBoard(boardId, user.id);
  }

  @Get(':boardId/activity')
  activity(
    @CurrentUser() user: TokenUser,
    @Param('boardId') boardId: string,
    @Query(new ZodValidationPipe(activityQuerySchema)) query: { cursor?: string; limit?: number },
  ) {
    return this.boards.activity(boardId, user.id, query.cursor, query.limit);
  }

  @Post(':boardId/lists')
  createList(
    @CurrentUser() user: TokenUser,
    @Param('boardId') boardId: string,
    @Body(new ZodValidationPipe(createListSchema))
    body: { name: string; wipLimit?: number | null; afterListId?: string | null },
  ) {
    return this.boards.createList(user, {
      boardId,
      name: body.name,
      wipLimit: body.wipLimit,
      afterListId: body.afterListId,
    });
  }

  @Patch(':boardId/lists/:listId')
  updateList(
    @CurrentUser() user: TokenUser,
    @Param('boardId') boardId: string,
    @Param('listId') listId: string,
    @Body(new ZodValidationPipe(updateListSchema))
    body: { name?: string; wipLimit?: number | null },
  ) {
    return this.boards.updateList(user, { boardId, listId, ...body });
  }

  @Patch(':boardId/lists/:listId/move')
  moveList(
    @CurrentUser() user: TokenUser,
    @Param('boardId') boardId: string,
    @Param('listId') listId: string,
    @Body(new ZodValidationPipe(moveListSchema))
    body: { afterListId: string | null; beforeListId: string | null },
  ) {
    return this.boards.moveList(user, { boardId, listId, ...body });
  }

  /**
   * Archive, not delete. `POST`, not `DELETE`.
   *
   * The row stays and `archived_at` is set, so the card can come back and the
   * activity feed keeps pointing at something real. `DELETE` would be the wrong
   * verb for a write that leaves the resource addressable, and this operation had
   * no route at all until now: `archiveList` and `archiveCard` were implemented
   * and unit-tested in `services/board-ops` and unreachable over HTTP, so the
   * `archived_at` column that every read path filters on could never be set.
   */
  @Post(':boardId/lists/:listId/archive')
  archiveList(
    @CurrentUser() user: TokenUser,
    @Param('boardId') boardId: string,
    @Param('listId') listId: string,
  ) {
    return this.boards.archiveList(user, { boardId, listId });
  }

  @Post(':boardId/cards')
  createCard(
    @CurrentUser() user: TokenUser,
    @Param('boardId') boardId: string,
    @Body(new ZodValidationPipe(createCardSchema))
    body: {
      listId: string;
      title: string;
      description?: string | null;
      dueOn?: string | null;
      assigneeId?: string | null;
      labelIds?: string[];
      afterCardId?: string | null;
    },
  ) {
    return this.boards.createCard(user, {
      boardId,
      listId: body.listId,
      title: body.title,
      // These four were accepted by `createCardSchema` and then dropped on the
      // floor: the handler destructured three fields out of a seven-field body,
      // so a card created with a description, a due date, an assignee or labels
      // came back with none of them and no error to explain it.
      description: body.description,
      dueOn: wireDayToUtc(body.dueOn),
      assigneeId: body.assigneeId,
      labelIds: body.labelIds,
      afterCardId: body.afterCardId,
    });
  }

  @Patch(':boardId/cards/:cardId')
  updateCard(
    @CurrentUser() user: TokenUser,
    @Param('boardId') boardId: string,
    @Param('cardId') cardId: string,
    @Body(new ZodValidationPipe(updateCardSchema))
    body: {
      expectedVersion: number;
      title?: string;
      description?: string | null;
      dueOn?: string | null;
      assigneeId?: string | null;
      labelIds?: string[];
    },
  ) {
    return this.boards.updateCard(user, {
      boardId,
      cardId,
      expectedVersion: body.expectedVersion,
      title: body.title,
      description: body.description,
      dueOn: wireDayToUtc(body.dueOn),
      assigneeId: body.assigneeId,
      labelIds: body.labelIds,
    });
  }

  /**
   * Archiving a card takes the optimistic lock; archiving a list does not.
   *
   * Not an inconsistency. A card carries a `version` because two people edit the
   * same card's fields, and archiving one somebody else just retitled should be
   * refused the same way a title edit would be. A list has no version column: its
   * mutations are name, WIP limit and position, none of which race in a way the
   * archive needs to know about, and archiving an already-archived list is
   * idempotent rather than wrong.
   */
  @Post(':boardId/cards/:cardId/archive')
  archiveCard(
    @CurrentUser() user: TokenUser,
    @Param('boardId') boardId: string,
    @Param('cardId') cardId: string,
    @Body(new ZodValidationPipe(archiveCardSchema)) body: { expectedVersion: number },
  ) {
    return this.boards.archiveCard(user, {
      boardId,
      cardId,
      expectedVersion: body.expectedVersion,
    });
  }

  /**
   * The move. Also reachable as a `card.move` socket event, through the same
   * `moveCard` in services/board-ops.
   *
   * It exists over HTTP as well as over the socket because the socket is an
   * optimisation, not a requirement: a client whose WebSocket is blocked by a
   * corporate proxy still has a working board, just one that updates on reload.
   */
  @Patch(':boardId/cards/:cardId/move')
  moveCard(
    @CurrentUser() user: TokenUser,
    @Param('boardId') boardId: string,
    @Param('cardId') cardId: string,
    @Body(new ZodValidationPipe(moveCardSchema))
    body: {
      expectedVersion: number;
      toListId: string;
      afterCardId: string | null;
      beforeCardId: string | null;
    },
  ) {
    return this.boards.moveCard(user, { boardId, cardId, ...body });
  }
}
