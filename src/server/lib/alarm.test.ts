import { afterEach, describe, expect, test } from "bun:test";
import { MAX_ALARMS_PER_WINDOW, admitAlarm, alarmBody, resetAlarms } from "./alarm";

afterEach(resetAlarms);

describe("admitAlarm", () => {
  test("admits one alarm a minute per message and ten a minute in all", () => {
    expect(admitAlarm("a", 0)).toBe(true);
    expect(admitAlarm("a", 59_999)).toBe(false);
    expect(admitAlarm("a", 60_000)).toBe(true);
    for (let i = 0; i < MAX_ALARMS_PER_WINDOW - 1; i++) expect(admitAlarm(`m${i}`, 60_001)).toBe(true);
    expect(admitAlarm("another", 60_002)).toBe(false);
    expect(admitAlarm("another", 120_001)).toBe(true);
  });
});

describe("alarmBody", () => {
  const at = new Date("2026-11-23T20:00:00Z");

  test("lists the fields one per line under the message", () => {
    expect(alarmBody("saving page content failed", { pageId: "p1", attempt: 2, skipped: undefined, error: "boom" }, at)).toEqual({
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: "doc: saving page content failed",
          description: "```\npageId: p1\nattempt: 2\nerror: boom\n```",
          color: 0xed4245,
          timestamp: "2026-11-23T20:00:00.000Z",
        },
      ],
    });
  });

  test("cuts a long title to 256 characters", () => {
    const title = alarmBody("é".repeat(300), {}, at).embeds[0]!.title;
    expect([...title]).toHaveLength(256);
    expect(title.endsWith("é…")).toBe(true);
  });
});
