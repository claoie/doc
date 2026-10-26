import { describe, expect, test } from "bun:test";
import { Schema } from "./schema";
import { Authority, CollabClient } from "./collab";
import { applyTransaction, createState, Transaction, type EditorState } from "./state";
import type { Node } from "./model";

const schema = new Schema(
  {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
  },
  { bold: {} },
);

const p = (text: string): Node => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] });
const doc = (...content: Node[]): Node => ({ type: "doc", content });

class Peer {
  state: EditorState;
  client: CollabClient;
  constructor(id: string, d: Node, readonly server: Authority) {
    this.state = createState(schema, d);
    this.client = new CollabClient(id, server.version);
  }
  edit(fn: (tr: Transaction) => void) {
    const tr = new Transaction(this.state);
    fn(tr);
    this.state = applyTransaction(this.state, tr);
    this.client.addLocal(tr);
  }
  /** Sends pending steps; on rejection catches up and retries. */
  sync(peers: Peer[]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const out = this.client.sendable();
      if (!out) return;
      const accepted = this.server.receive(out.version, out.steps, this.client.clientId);
      if (accepted) {
        for (const peer of peers) peer.pull();
        return;
      }
      this.pull();
    }
    throw new Error("did not converge");
  }
  pull() {
    const missed = this.server.stepsSince(this.client.version)!;
    const tr = this.client.receive(this.state, missed.steps, missed.clientIds);
    if (tr) this.state = applyTransaction(this.state, tr);
  }
}

describe("collab", () => {
  test("concurrent edits converge", () => {
    const base = doc(p("hello world"));
    const server = new Authority(schema, base);
    const a = new Peer("a", base, server);
    const b = new Peer("b", base, server);
    a.edit((tr) => tr.insertText("A", 1));
    a.edit((tr) => tr.insertText("B", 2));
    b.edit((tr) => tr.insertText("!", 12));
    b.edit((tr) => tr.addMark(7, 12, { type: "bold" }));
    a.sync([a, b]);
    b.sync([a, b]);
    expect(a.state.doc).toEqual(server.doc);
    expect(b.state.doc).toEqual(server.doc);
    expect(server.doc).toEqual(
      doc({
        type: "paragraph",
        content: [
          { type: "text", text: "ABhello " },
          { type: "text", text: "world", marks: [{ type: "bold" }] },
          { type: "text", text: "!" },
        ],
      }),
    );
  });

  test("own multi-char insert survives rebase with a typed char inside it", () => {
    const base = doc(p("xy"));
    const server = new Authority(schema, base);
    const a = new Peer("a", base, server);
    const b = new Peer("b", base, server);
    a.edit((tr) => tr.insertText("12", 2));
    a.edit((tr) => tr.insertText("-", 3));
    b.edit((tr) => tr.insertText("Z", 1));
    b.sync([a, b]);
    a.sync([a, b]);
    expect(server.doc).toEqual(doc(p("Zx1-2y")));
    expect(a.state.doc).toEqual(server.doc);
    expect(b.state.doc).toEqual(server.doc);
  });

  test("split paragraph concurrently with typing", () => {
    const base = doc(p("abcd"));
    const server = new Authority(schema, base);
    const a = new Peer("a", base, server);
    const b = new Peer("b", base, server);
    a.edit((tr) => tr.replace(3, 3, [{ c: 1 }, { o: "paragraph" }]));
    b.edit((tr) => tr.insertText("X", 4));
    a.sync([a, b]);
    b.sync([a, b]);
    expect(server.doc).toEqual(doc(p("ab"), p("cXd")));
    expect(b.state.doc).toEqual(server.doc);
  });

  test("history is capped by size and old versions must reload", () => {
    const server = new Authority(schema, doc(p("")), 0, { maxHistoryBytes: 400 });
    for (let i = 0; i < 20; i++) {
      expect(server.receive(i, [{ stepType: "replace", from: 1 + i, to: 1 + i, slice: [{ t: "x" }] }], "a")).not.toBeNull();
    }
    expect(server.stepsSince(19)?.steps).toHaveLength(1);
    expect(server.stepsSince(0)).toBeNull();
  });

  test("a batch that would make the document too large is refused", () => {
    const server = new Authority(schema, doc(p("abc")), 0, { maxDocSize: 10 });
    expect(server.receive(0, [{ stepType: "replace", from: 4, to: 4, slice: [{ t: "def" }] }], "a")).not.toBeNull();
    expect(server.receive(1, [{ stepType: "replace", from: 7, to: 7, slice: [{ t: "ghij" }] }], "a")).toBeNull();
    expect(server.rejection).toBe("too-large");
    expect(server.version).toBe(1);
  });

  test("a document over the size limit can still shrink", () => {
    const server = new Authority(schema, doc(p("abcdefghijklmnop")), 0, { maxDocSize: 10 });
    expect(server.receive(0, [{ stepType: "replace", from: 1, to: 11, slice: [] }], "a")).not.toBeNull();
  });
});
