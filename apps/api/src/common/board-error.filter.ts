/**
 * One table mapping a domain failure to an HTTP status.
 *
 * `services/board-ops` throws `BoardOpError` with a typed code, deliberately
 * knowing nothing about HTTP -- it is also called from a socket handler, where
 * the same code becomes an ack's `error.code`. This filter is where the REST
 * transport does its half of that translation, and having it in one place is what
 * stops the two transports from disagreeing about what a STALE means.
 *
 * The mapping is not arbitrary:
 *
 *   STALE        -> 409. The request was well-formed and the state moved. That is
 *                   what 409 is for, and it is what tells a client to refetch
 *                   rather than to fix its payload.
 *   CONFLICT     -> 409, same reasoning, different cause.
 *   FORBIDDEN    -> 403.
 *   NOT_FOUND    -> 404.
 *   INVALID      -> 400.
 *   RATE_LIMITED -> 429.
 *   INTERNAL     -> 500, and its message is NOT sent to the client.
 *
 * The body carries the code as well as the status, because a client that has to
 * infer "was this stale or was it a genuine conflict" from a shared 409 ends up
 * matching on prose.
 */
import { BoardOpError } from '@kan/board-ops';
import type { ErrorCode } from '@kan/shared';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

const STATUS_FOR: Record<ErrorCode, HttpStatus> = {
  STALE: HttpStatus.CONFLICT,
  CONFLICT: HttpStatus.CONFLICT,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID: HttpStatus.BAD_REQUEST,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

export interface BoardErrorBody {
  code: ErrorCode;
  message: string;
}

@Catch(BoardOpError)
export class BoardErrorFilter implements ExceptionFilter<BoardOpError> {
  private readonly logger = new Logger(BoardErrorFilter.name);

  catch(exception: BoardOpError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = STATUS_FOR[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    if (status >= 500) {
      // The only branch that logs, and the only one whose message is withheld.
      // Every other code is a message written for the person who triggered it.
      this.logger.error(exception.message, exception.stack);
      response.status(status).json({ code: exception.code, message: 'Something went wrong.' });
      return;
    }

    response.status(status).json({ code: exception.code, message: exception.message });
  }
}
