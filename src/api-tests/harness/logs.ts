import { expect } from "bun:test";

/** The timestamp format of log lines and of the API. */
export const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

/**
 * An error log entry as tests compare it: `error` is the failure's message,
 * whatever its wording, and the stack trace, which not every failure and not
 * every server has, is left out after checking that it is text.
 */
export const errorEntry = (entry: Record<string, any> | undefined): Record<string, any> | undefined => {
  if (!entry) return entry;
  const { stack, error, ...rest } = entry;
  if (stack !== undefined) expect(typeof stack).toBe("string");
  expect(typeof error).toBe("string");
  expect(error).not.toBe("");
  return rest;
};
