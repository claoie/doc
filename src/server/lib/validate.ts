import { isUuid } from "common/ids";
import { badRequest } from "./http";

interface StringRule {
  min?: number;
  max: number;
  trim?: boolean;
}

/** Typed, bounded accessors over an untrusted JSON object or query string. */
export class Input {
  constructor(private readonly data: Record<string, unknown>) {}

  static query(url: URL) {
    return new Input(Object.fromEntries(url.searchParams));
  }

  has(key: string): boolean {
    return this.data[key] !== undefined;
  }

  raw(key: string): unknown {
    return this.data[key];
  }

  private checkString(key: string, value: unknown, rule: StringRule): string {
    if (typeof value !== "string") throw badRequest(`${key} must be a string`);
    const s = rule.trim === false ? value : value.trim();
    const length = [...s].length;
    if (length < (rule.min ?? 1)) {
      throw badRequest(rule.min === undefined || rule.min === 1 ? `${key} is required` : `${key} is too short`);
    }
    if (length > rule.max) throw badRequest(`${key} must be at most ${rule.max} characters`);
    return s;
  }

  string(key: string, rule: StringRule): string {
    return this.checkString(key, this.data[key], rule);
  }

  optionalString(key: string, rule: StringRule): string | undefined {
    const value = this.data[key];
    return value === undefined ? undefined : this.checkString(key, value, rule);
  }

  /** `undefined` when absent, `null` when explicitly null or blank. */
  nullableString(key: string, rule: StringRule): string | null | undefined {
    const value = this.data[key];
    if (value === undefined) return undefined;
    if (value === null || (typeof value === "string" && value.trim() === "")) return null;
    return this.checkString(key, value, { ...rule, min: 0 });
  }

  boolean(key: string): boolean | undefined {
    const value = this.data[key];
    if (value === undefined) return undefined;
    if (typeof value === "boolean") return value;
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false" || value === "") return false;
    throw badRequest(`${key} must be a boolean`);
  }

  integer(key: string, min: number, max: number): number | undefined {
    const value = this.data[key];
    if (value === undefined || value === "") return undefined;
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
      throw badRequest(`${key} must be an integer between ${min} and ${max}`);
    }
    return n;
  }

  uuid(key: string): string {
    const value = this.data[key];
    if (!isUuid(value)) throw badRequest(`${key} must be a valid id`);
    return value.toLowerCase();
  }

  optionalUuid(key: string): string | null | undefined {
    const value = this.data[key];
    if (value === undefined) return undefined;
    if (value === null || value === "") return null;
    return this.uuid(key);
  }

  uuids(key: string, maxItems: number): string[] | undefined {
    const value = this.data[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > maxItems) {
      throw badRequest(`${key} must be a list of at most ${maxItems} ids`);
    }
    if (!value.every(isUuid)) throw badRequest(`${key} must contain valid ids`);
    return [...new Set(value.map((v) => v.toLowerCase()))];
  }

  strings(key: string, maxItems: number, rule: StringRule): string[] | undefined {
    const value = this.data[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > maxItems) {
      throw badRequest(`${key} must be a list of at most ${maxItems} items`);
    }
    return value.map((v) => this.checkString(key, v, rule));
  }

  oneOf<T extends string>(key: string, values: readonly T[]): T | undefined {
    const value = this.data[key];
    if (value === undefined) return undefined;
    if (!values.includes(value as T)) throw badRequest(`${key} must be one of ${values.join(", ")}`);
    return value as T;
  }

  object(key: string): Record<string, unknown> | undefined {
    const value = this.data[key];
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequest(`${key} must be an object`);
    return value as Record<string, unknown>;
  }
}

export const input = (data: Record<string, unknown>) => new Input(data);

export const NAME_RULE = { min: 1, max: 50 };
export const PASSWORD_RULE = { min: 8, max: 70, trim: false };
export const EMAIL_RULE = { min: 3, max: 254 };

const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export const normalizeEmail = (value: string): string => {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) throw badRequest("Invalid email address");
  return email;
};
