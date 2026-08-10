import { activityQuerySchema, moveCardSchema } from '@kan/shared';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { ZodValidationPipe, type ValidationErrorBody } from './zod-validation.pipe';

const bodyOf = (error: unknown): ValidationErrorBody => {
  if (!(error instanceof BadRequestException)) throw new Error('expected a BadRequestException');
  return error.getResponse() as ValidationErrorBody;
};

describe('ZodValidationPipe', () => {
  it('returns the schema output, not the input', () => {
    // The query schema coerces. A handler that received the raw query would
    // compare the string "50" to a number and page by NaN.
    const pipe = new ZodValidationPipe(activityQuerySchema);
    expect(pipe.transform({ limit: '50' })).toEqual({ limit: 50 });
    expect(pipe.transform({})).toEqual({});
  });

  it('answers 400 with a path and a message per problem', () => {
    const pipe = new ZodValidationPipe(moveCardSchema);
    let caught: unknown;
    try {
      pipe.transform({ toListId: '', afterCardId: 5 });
    } catch (error) {
      caught = error;
    }

    const body = bodyOf(caught);
    expect(body.statusCode).toBe(400);
    expect(body.message).toBe('Validation failed');

    const paths = body.errors.map((issue) => issue.path).sort();
    // `expectedVersion` and `beforeCardId` are both required and both absent, so
    // all four problems are reported at once rather than one per round trip.
    expect(paths).toEqual(['afterCardId', 'beforeCardId', 'expectedVersion', 'toListId']);
    expect(body.errors.every((issue) => issue.message.length > 0)).toBe(true);
  });

  it('refuses a move with no optimistic lock', () => {
    // The rule the whole concurrent-edit story rests on. An optional lock is not
    // a lock, so the schema makes it required and this asserts the pipe enforces
    // that rather than filling in a default.
    const pipe = new ZodValidationPipe(moveCardSchema);
    try {
      pipe.transform({ toListId: 'list_1', afterCardId: null, beforeCardId: null });
      expect.unreachable('a move with no expectedVersion must not validate');
    } catch (error) {
      expect(bodyOf(error).errors.map((issue) => issue.path)).toEqual(['expectedVersion']);
    }
  });

  it('carries no zod internals into the response body', () => {
    // `code`, `expected`, `received` and `unionErrors` are the validator's
    // implementation, not this API's contract. A client that started matching on
    // them would break the next time zod changed its wording.
    const pipe = new ZodValidationPipe(moveCardSchema);
    try {
      pipe.transform({ expectedVersion: 'one' });
      expect.unreachable('expected a validation failure');
    } catch (error) {
      for (const issue of bodyOf(error).errors) {
        expect(Object.keys(issue).sort()).toEqual(['message', 'path']);
      }
    }
  });

  it('passes a valid payload straight through', () => {
    const pipe = new ZodValidationPipe(moveCardSchema);
    const input = {
      expectedVersion: 3,
      toListId: 'list_2',
      afterCardId: 'card_9',
      beforeCardId: null,
    };
    expect(pipe.transform(input)).toEqual(input);
  });
});
