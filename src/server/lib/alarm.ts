import { config } from "server/config";

const WINDOW_MS = 60_000;

/**
 * Alarms a minute across all messages. An outage logs many different errors at
 * once, and Discord accepts about thirty posts a minute to one webhook.
 */
export const MAX_ALARMS_PER_WINDOW = 10;

const TITLE_MAX = 256;
const DESCRIPTION_MAX = 4000;
const COLOR = 0xed4245;

const lastByMessage = new Map<string, number>();
let recent: number[] = [];

/**
 * Whether an alarm for `message` may be sent at `now`, counting it if so: one a
 * minute for each message, and `MAX_ALARMS_PER_WINDOW` a minute in all.
 */
export const admitAlarm = (message: string, now: number): boolean => {
  recent = recent.filter((at) => now - at < WINDOW_MS);
  for (const [key, at] of lastByMessage) if (now - at >= WINDOW_MS) lastByMessage.delete(key);
  if (lastByMessage.has(message) || recent.length >= MAX_ALARMS_PER_WINDOW) return false;
  lastByMessage.set(message, now);
  recent.push(now);
  return true;
};

export const resetAlarms = () => {
  lastByMessage.clear();
  recent = [];
};

const cut = (text: string, max: number): string => {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
};

/** Keeps text from closing the code block it is posted in: no two backticks stay adjacent. */
const defuseFences = (text: string) => text.replace(/`(?=`)/g, "`\u200b");

/** The webhook message for an error log line: its message as the title, its other fields one per line. */
export const alarmBody = (message: string, fields: Record<string, unknown>, at: Date) => {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return {
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: cut(`doc: ${message}`, TITLE_MAX),
        description: `\`\`\`\n${cut(defuseFences(lines.join("\n")), DESCRIPTION_MAX)}\n\`\`\``,
        color: COLOR,
        timestamp: at.toISOString(),
      },
    ],
  };
};

/**
 * Posts an error log line to `DISCORD_ALARM_WEBHOOK` when it is set and the
 * limits admit it. Rejects when the webhook can't be reached or doesn't take it.
 */
export const sendAlarm = async (message: string, fields: Record<string, unknown>): Promise<void> => {
  const webhook = config.alarmWebhook;
  if (!webhook) return;
  const at = new Date();
  if (!admitAlarm(message, at.getTime())) return;
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(alarmBody(message, fields, at)),
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`the webhook answered ${response.status}`);
};
