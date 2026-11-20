import { afterEach, describe, expect, test } from "bun:test";
import { config } from "server/config";
import { parseLinkUsers, ssoMode, ssoProblems, workspaceRole } from "./sso";

const NAMES = [
  "AUTH_ISSUER",
  "AUTH_CLIENT_ID",
  "AUTH_CLIENT_SECRET",
  "AUTH_REDIRECT_URI",
  "AUTH_BACKCHANNEL_URL",
  "AUTH_AUDIENCE",
  "AUTH_LOCAL_LOGIN",
  "AUTH_LINK_USERS",
];
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
const savedAppUrl = process.env.APP_URL;

const setEnv = (vars: Record<string, string | undefined>) => {
  for (const name of NAMES) delete process.env[name];
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
};

const VALID = { AUTH_ISSUER: "https://auth.example.com", AUTH_CLIENT_ID: "doc", AUTH_CLIENT_SECRET: "s3cret" };

afterEach(() => {
  setEnv(saved);
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
});

describe("single sign-on settings", () => {
  test("are off, with nothing to report, unless AUTH_ISSUER is set", () => {
    setEnv({ AUTH_CLIENT_ID: "doc", AUTH_LINK_USERS: "not a pair", AUTH_ISSUER: "" });
    expect(config.sso).toBeNull();
    expect(config.localLogin).toBe(true);
    expect(ssoProblems()).toEqual([]);
    expect(ssoMode()).toEqual({ enabled: false, localLogin: true });
  });

  test("accept a complete configuration and default the redirect URI to the app's URL", () => {
    process.env.APP_URL = "https://docs.example.com/";
    setEnv(VALID);
    expect(ssoProblems()).toEqual([]);
    expect(config.sso?.redirectUri).toBe("https://docs.example.com/api/auth/callback");
    expect(ssoMode()).toEqual({ enabled: true, localLogin: false });
    setEnv({ ...VALID, AUTH_REDIRECT_URI: "https://wiki.example.com/api/auth/callback", AUTH_LOCAL_LOGIN: "true" });
    expect(config.sso?.redirectUri).toBe("https://wiki.example.com/api/auth/callback");
    expect(ssoMode()).toEqual({ enabled: true, localLogin: true });
    setEnv({ ...VALID, AUTH_LOCAL_LOGIN: "1" });
    expect(config.localLogin).toBe(true);
    setEnv({ ...VALID, AUTH_LOCAL_LOGIN: "false" });
    expect(config.localLogin).toBe(false);
  });

  test("allow plain http only for an issuer on this machine", () => {
    setEnv({ ...VALID, AUTH_ISSUER: "http://localhost:4000", AUTH_BACKCHANNEL_URL: "http://auth.internal:4000" });
    expect(ssoProblems()).toEqual([]);
    setEnv({ ...VALID, AUTH_ISSUER: "http://auth.example.com" });
    expect(ssoProblems()).toEqual(["AUTH_ISSUER must be an https URL (http only for localhost), without a query or fragment"]);
  });

  test("list every problem at once", () => {
    setEnv({
      AUTH_ISSUER: "auth.example.com",
      AUTH_REDIRECT_URI: "/api/auth/callback",
      AUTH_BACKCHANNEL_URL: "ftp://auth.internal",
      AUTH_LINK_USERS: "alice@example.com=alice,bob,=carol,dave@example.com=,erin@example.com=alice,alice@example.com=al ice",
    });
    expect(ssoProblems()).toEqual([
      "AUTH_CLIENT_ID is required when AUTH_ISSUER is set",
      "AUTH_CLIENT_SECRET is required when AUTH_ISSUER is set",
      "AUTH_ISSUER must be an https URL (http only for localhost), without a query or fragment",
      "AUTH_BACKCHANNEL_URL must be an http or https URL, without a query or fragment",
      "AUTH_REDIRECT_URI must be an absolute http or https URL (it defaults to APP_URL/api/auth/callback)",
      'AUTH_LINK_USERS: "bob" is not <email>=<username>',
      'AUTH_LINK_USERS: "=carol" is not <email>=<username>',
      'AUTH_LINK_USERS: "dave@example.com=" is not <email>=<username>',
      "AUTH_LINK_USERS: alice is listed more than once",
      'AUTH_LINK_USERS: "alice@example.com=al ice" is not <email>=<username>',
    ]);
  });

  test("report an issuer with a query", () => {
    setEnv({ ...VALID, AUTH_ISSUER: "https://auth.example.com/?tenant=1" });
    expect(ssoProblems()).toHaveLength(1);
  });
});

describe("AUTH_LINK_USERS", () => {
  test("maps provider usernames to local emails, normalizing the emails", () => {
    const { links, problems } = parseLinkUsers(" Alice@Example.com=alice , bob@example.com=bob ,");
    expect(problems).toEqual([]);
    expect([...links]).toEqual([
      ["alice", "alice@example.com"],
      ["bob", "bob@example.com"],
    ]);
  });

  test("refuses one local account listed for two usernames", () => {
    expect(parseLinkUsers("alice@example.com=alice,alice@example.com=al").problems).toEqual([
      "AUTH_LINK_USERS: alice@example.com is listed more than once",
    ]);
  });
});

describe("workspaceRole", () => {
  test("keeps owner, admin and member, and makes any other role a member", () => {
    expect(["owner", "admin", "member", "editor", "Owner", ""].map(workspaceRole)).toEqual(["owner", "admin", "member", "member", "member", "member"]);
  });
});
