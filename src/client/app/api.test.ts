import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Node } from "common/editor/model";
import { api, ApiError } from "./api";

const content = { type: "doc", content: [] } as unknown as Node;
const notLeader = () => Response.json({ error: { code: "not_leader", message: "Try again" } }, { status: 503 });
const saved = () => Response.json({ data: { page: { id: "p" } } });

/** Answers each request with the next response, repeating the last one. */
const answer = (...responses: (() => Response)[]) => {
  let call = 0;
  return spyOn(globalThis, "fetch").mockImplementation((async () => responses[Math.min(call++, responses.length - 1)]!()) as never);
};

describe("setPageContent", () => {
  const realSetTimeout = globalThis.setTimeout;
  let waits: number[];

  beforeEach(() => {
    waits = [];
    spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, ms: number) => {
      waits.push(ms);
      return realSetTimeout(run, 0);
    }) as never);
  });

  afterEach(() => {
    mock.restore();
  });

  test("retries a copy that isn't the leader until the leader answers", async () => {
    const fetch = answer(notLeader, notLeader, saved);
    expect(await api.setPageContent("p", content)).toEqual({ page: { id: "p" } } as never);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([500, 500]);
  });

  test("gives up after about ten seconds", async () => {
    const fetch = answer(notLeader);
    const failed = await api.setPageContent("p", content).catch((error) => error);
    expect(failed).toBeInstanceOf(ApiError);
    expect(failed.code).toBe("not_leader");
    expect(fetch).toHaveBeenCalledTimes(20);
    expect(waits).toHaveLength(19);
  });

  test("doesn't retry any other failure", async () => {
    const fetch = answer(() => Response.json({ error: { code: "forbidden", message: "No" } }, { status: 403 }));
    const failed = await api.setPageContent("p", content).catch((error) => error);
    expect(failed.code).toBe("forbidden");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });
});
