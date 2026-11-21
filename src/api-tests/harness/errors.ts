/**
 * The body of a failed API call, for comparing with `toEqual`. Typed loosely
 * because the client's `body` type always has `data`, which an error lacks.
 */
export const apiError = (code: string, message: string): any => ({ error: { code, message } });
