import type { Member, User, UserPreferences, UserRef, WorkspaceRole } from "common/api-types";
import { config } from "server/config";
import { sql } from "server/db";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  avatar: string | null;
  role: WorkspaceRole;
  locale: string | null;
  timezone: string | null;
  preferences: UserPreferences;
  created_at: Date;
  last_login_at: Date | null;
  deactivated_at: Date | null;
  /** The identity provider's subject, once the user has signed in with single sign-on. */
  auth_sub: string | null;
  /** The email is the one the identity provider verified at the last sign-in, so the provider manages it. */
  email_from_provider: boolean;
  /** On rows read whole; null for people single sign-on created. Never sent to a browser. */
  password_hash?: string | null;
}

export const iso = (value: Date | string | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString();

export const imageUrl = (name: string | null | undefined): string | null => (name ? `/api/images/${name}` : null);

export const toUser = (row: UserRow, viewerId?: string): User => ({
  id: row.id,
  email: row.email,
  name: row.name,
  avatarUrl: imageUrl(row.avatar),
  role: row.role,
  locale: row.locale,
  timezone: row.timezone,
  preferences: viewerId === undefined || viewerId === row.id ? (row.preferences ?? {}) : {},
  createdAt: iso(row.created_at)!,
  lastLoginAt: iso(row.last_login_at),
});

/** `ssoManaged` and `ssoManagedEmail`, while single sign-on is on; nothing otherwise, so answers without it are unchanged. */
export const ssoManagedField = (
  row: Pick<UserRow, "auth_sub" | "email_from_provider">,
): Pick<User, "ssoManaged" | "ssoManagedEmail"> =>
  config.sso ? { ssoManaged: row.auth_sub !== null, ssoManagedEmail: row.auth_sub !== null && row.email_from_provider } : {};

/**
 * For the current user only: `ssoManagedField`, and whether they have a
 * password here, while single sign-on is on. Never in the member list.
 */
export const ownSsoFields = (
  row: Pick<UserRow, "auth_sub" | "email_from_provider" | "password_hash">,
): Pick<User, "ssoManaged" | "ssoManagedEmail" | "hasPassword"> =>
  config.sso ? { ...ssoManagedField(row), hasPassword: row.password_hash != null } : {};

export const toMember = (row: UserRow, viewerId: string): Member => ({
  ...toUser(row, viewerId),
  deactivatedAt: iso(row.deactivated_at),
});

/** SQL expression building a `UserRef` JSON object (or null) from a users row alias. */
export const userRefJson = (alias: string) =>
  `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE json_build_object('id', ${alias}.id, 'name', ${alias}.name, 'avatarUrl', CASE WHEN ${alias}.avatar IS NULL THEN NULL ELSE '/api/images/' || ${alias}.avatar END) END`;

export const toUserRef = (row: Pick<UserRow, "id" | "name" | "avatar">): UserRef => ({
  id: row.id,
  name: row.name,
  avatarUrl: imageUrl(row.avatar),
});

export const findUserById = async (id: string): Promise<UserRow | null> => {
  const [row] = await sql`SELECT * FROM users WHERE id = ${id}`;
  return (row as UserRow | undefined) ?? null;
};

/** User refs for a list of ids, in the given order, skipping unknown ids. */
export const userRefs = async (ids: readonly string[]): Promise<UserRef[]> => {
  if (ids.length === 0) return [];
  const rows: UserRow[] = await sql`SELECT id, name, avatar FROM users WHERE id = ANY(${sql.array([...ids], "uuid")})`;
  const byId = new Map(rows.map((row) => [row.id, toUserRef(row)]));
  return ids.flatMap((id) => byId.get(id) ?? []);
};

const ARGON2 = { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 } as const;
let dummyHash: Promise<string> | null = null;

/** argon2id with a 19 MiB memory cost keeps concurrent hashing inside a small container. */
export const hashPassword = (password: string) => Bun.password.hash(password, ARGON2);

export const verifyPassword = async (password: string, hash: string | null): Promise<boolean> => {
  if (!hash) {
    dummyHash ??= hashPassword("timing-equalizer");
    await Bun.password.verify(password, await dummyHash).catch(() => false);
    return false;
  }
  return Bun.password.verify(password, hash).catch(() => false);
};
