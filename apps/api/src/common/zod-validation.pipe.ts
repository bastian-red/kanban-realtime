import { BadRequestException, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { ZodError, ZodTypeAny, z } from 'zod';

/** One thing that was wrong with the request, and where. */
export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationErrorBody {
  statusCode: number;
  message: string;
  errors: ValidationIssue[];
}

/**
 * The only validation in this API.
 *
 * class-validator is not used at all, and that is deliberate rather than
 * incidental: the wire contract already exists as zod schemas in
 * `@kan/shared/contracts`, both sides import it, and a second set of rules
 * expressed as decorators on DTO classes would be a copy that can disagree with
 * the contract. A copy that disagrees is worse than no validation, because it
 * fails on the side nobody is looking at.
 *
 * Applied per route and per argument, `@Body(new ZodValidationPipe(schema))`,
 * rather than globally against a metatype. Global validation needs
 * `design:paramtypes` to find the DTO class, which means a class per payload,
 * which is the copy again.
 *
 * The pipe returns the schema's **output**, not its input. That matters for the
 * query schemas, where `z.coerce.number()` turns `"50"` into `50` and a default
 * fills in `limit`; a handler that read the raw query would be comparing a string
 * to a number.
 */
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata?: ArgumentMetadata): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new BadRequestException(bodyFor(result.error));
  }
}

/**
 * The error body, built from `flatten()`.
 *
 * `flatten()` rather than the raw issue list because the raw list carries zod's
 * internal discriminators (`code`, `expected`, `received`, `unionErrors`) which
 * are an implementation detail of the validator, not part of this API's contract.
 * Field errors keep the field name as `path`; form-level errors -- a refinement
 * across two fields, a union that matched nothing -- have no field to name, so
 * their path is the empty string.
 */
export function bodyFor(error: ZodError): ValidationErrorBody {
  const flat = error.flatten();
  const errors: ValidationIssue[] = [];

  for (const message of flat.formErrors) errors.push({ path: '', message });
  for (const [path, messages] of Object.entries(flat.fieldErrors)) {
    for (const message of messages ?? []) errors.push({ path, message });
  }

  return { statusCode: 400, message: 'Validation failed', errors };
}
