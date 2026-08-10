import type { z } from 'zod';
import { apiBaseUrl } from './config';

/**
 * The only thing between a server component and the API.
 *
 * Three properties everything above this file depends on:
 *
 * **Every response is parsed through its contract schema.** `packages/shared`
 * defines the shapes both sides import. Casting the JSON with `as Transaction[]`
 * would compile and would render `undefined` in a table cell the day a field is
 * renamed; parsing it throws at the boundary with the path of the field that
 * moved. The cost is one schema argument per call.
 *
 * **Authenticated reads are never cached.** `cache: 'no-store'` on every one of
 * them. Next's Data Cache is keyed on the URL and not on the Authorization
 * header, so a cached `/transactions` is one user's ledger served to the next
 * visitor. There is no "we only cache for a second" version of that bug worth
 * having.
 *
 * **Errors carry the status and the body.** A 409 from the budgets endpoint says
 * which months overlap, and a form that swallows it can only show "Conflict".
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /** The API's structured body, when it sent one. */
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A response that did not match its contract.
 *
 * Separate from `ApiError` because the two need different handling: an `ApiError`
 * is something to show the user ("that email is taken"), while this is a bug in
 * one of the two sides and belongs in the error boundary with the zod path
 * attached. Status 502 because from the browser's point of view the upstream
 * answered with something unusable.
 */
export class ContractError extends Error {
  constructor(
    public readonly path: string,
    public readonly issues: z.ZodIssue[],
  ) {
    super(
      `The API's response to ${path} does not match the shared contract: ` +
        issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; '),
    );
    this.name = 'ContractError';
  }
}

/** Extract the most useful message a failed response carries. */
async function errorFrom(path: string, response: Response): Promise<ApiError> {
  let message = response.statusText || `HTTP ${response.status}`;
  let body: unknown;
  try {
    body = await response.json();
    const record = body as { message?: unknown; error?: unknown };
    if (typeof record.message === 'string') {
      message = record.message;
    } else if (Array.isArray(record.message)) {
      // Nest's ValidationPipe answers a 400 with an array of strings, one per
      // failed field. Joining them is what turns "Bad Request" into something a
      // person can act on.
      message = record.message.filter((part) => typeof part === 'string').join(', ') || message;
    } else if (record.message && typeof record.message === 'object') {
      body = record.message;
      message = (record.message as { message?: string }).message ?? message;
    } else if (typeof record.error === 'string') {
      message = record.error;
    }
  } catch {
    // A non-JSON error body is not worth failing over; the status carries enough.
  }
  return new ApiError(response.status, `${message} (${path})`, body);
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** Sent as JSON. Use `raw` for anything that is not. */
  json?: unknown;
  /** Sent as-is, for the multipart upload on the import page. */
  raw?: BodyInit;
  /** Bearer token. Omitted for the two anonymous endpoints. */
  token?: string;
}

/**
 * One request, validated.
 *
 * `schema` is `null` for the endpoints that answer 204 with no body. Anything
 * else must declare what it expects.
 */
export async function apiRequest<T>(
  path: string,
  /**
   * The contract to parse the response with, or null for a 204.
   *
   * `z.ZodType<T, z.ZodTypeDef, unknown>`, not `z.ZodType<T>`. The short form
   * defaults the *input* type to `T` as well, which quietly excludes every schema
   * whose input and output differ -- and `calendarDaySchema` is one: it takes a
   * `string` and produces a branded `CalendarDay`. TypeScript cannot satisfy
   * `ZodType<T, Def, T>` with it, so it infers `T` from the input side instead
   * and every `dueOn` in the response comes back as a plain `string`. Nothing
   * fails: the value is right, the brand is gone, and the next function that
   * wants a `CalendarDay` demands a cast that puts the check back in a comment.
   */
  schema: z.ZodType<T, z.ZodTypeDef, unknown> | null,
  options: RequestOptions = {},
): Promise<T> {
  const { json, raw, token, headers, ...init } = options;

  const requestHeaders: Record<string, string> = { ...(headers as Record<string, string>) };
  // Only set for a JSON body. A multipart upload must be left alone so fetch can
  // write its own boundary parameter into the header; setting it by hand is the
  // classic way to make a working upload return 400.
  if (json !== undefined) requestHeaders['content-type'] = 'application/json';
  if (token) requestHeaders.authorization = `Bearer ${token}`;

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    headers: requestHeaders,
    body: json !== undefined ? JSON.stringify(json) : raw,
    // Authenticated data, every time. See the header comment.
    cache: 'no-store',
  });

  if (!response.ok) throw await errorFrom(path, response);

  if (schema === null || response.status === 204) return undefined as T;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(response.status, `The API answered ${path} with a body that is not JSON.`);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ContractError(path, parsed.error.issues);
  return parsed.data;
}
