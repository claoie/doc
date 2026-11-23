const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
};

const intEnv = (name: string, fallback: number): number => {
  const value = Number(env(name));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

const boolEnv = (name: string): boolean => /^(1|true|yes|on)$/i.test(env(name) ?? "");

/** Environment-driven settings, read on access so tests can set variables before use. */
export const config = {
  get port() {
    return intEnv("PORT", 3000);
  },
  get appUrl() {
    return (env("APP_URL") ?? `http://localhost:${this.port}`).replace(/\/+$/, "");
  },
  get secureCookies() {
    return this.appUrl.startsWith("https://");
  },
  get databaseUrl() {
    return env("DATABASE_URL") ?? "postgres://localhost:5432/doc";
  },
  get databasePoolMax() {
    return intEnv("DATABASE_POOL_MAX", 5);
  },
  get trustProxy() {
    return boolEnv("TRUST_PROXY");
  },
  get fileSizeLimit() {
    return intEnv("FILE_SIZE_LIMIT", 50 * 1024 * 1024);
  },
  get storageDriver(): "local" | "s3" {
    return env("STORAGE_DRIVER") === "s3" ? "s3" : "local";
  },
  get storagePath() {
    return env("STORAGE_PATH") ?? "./data/storage";
  },
  get s3() {
    return {
      bucket: env("S3_BUCKET"),
      region: env("S3_REGION"),
      endpoint: env("S3_ENDPOINT"),
      accessKeyId: env("S3_ACCESS_KEY_ID"),
      secretAccessKey: env("S3_SECRET_ACCESS_KEY"),
      forcePathStyle: boolEnv("S3_FORCE_PATH_STYLE"),
    };
  },
  get mail() {
    return {
      driver: env("MAIL_DRIVER") === "smtp" ? ("smtp" as const) : ("log" as const),
      host: env("SMTP_HOST") ?? "localhost",
      port: intEnv("SMTP_PORT", boolEnv("SMTP_SECURE") ? 465 : 587),
      username: env("SMTP_USERNAME"),
      password: env("SMTP_PASSWORD"),
      secure: boolEnv("SMTP_SECURE"),
      ignoreTls: boolEnv("SMTP_IGNORETLS"),
      fromAddress: env("MAIL_FROM_ADDRESS") ?? "noreply@localhost",
      fromName: env("MAIL_FROM_NAME") ?? "Doc",
    };
  },
  get logRequests() {
    return env("LOG_REQUESTS") !== "0";
  },
  /** Discord webhook that error log lines are posted to (lib/alarm.ts), or undefined to post none. */
  get alarmWebhook() {
    return env("DISCORD_ALARM_WEBHOOK");
  },
  /**
   * Single sign-on through an OpenID Connect provider, or null when
   * `AUTH_ISSUER` is unset. Checked at start by `ssoProblems` (lib/sso.ts).
   */
  get sso() {
    const issuer = env("AUTH_ISSUER");
    if (!issuer) return null;
    return {
      issuer,
      clientId: env("AUTH_CLIENT_ID"),
      clientSecret: env("AUTH_CLIENT_SECRET"),
      redirectUri: env("AUTH_REDIRECT_URI") ?? `${this.appUrl}/api/auth/callback`,
      backChannelUrl: env("AUTH_BACKCHANNEL_URL"),
      audience: env("AUTH_AUDIENCE"),
      localLogin: boolEnv("AUTH_LOCAL_LOGIN"),
      linkUsers: env("AUTH_LINK_USERS"),
    };
  },
  /** Password sign-in, setup, invitations and resets: always without SSO, and with it only when `AUTH_LOCAL_LOGIN` is on. */
  get localLogin() {
    return this.sso?.localLogin ?? true;
  },
};
