// Writes schema.json: what the TypeScript document schema says about every
// node and mark type, for tests/schema.rs to hold the Rust port to.
//
//   bun src/server-rs/tests/fixtures/gen-schema.ts
import path from "node:path";
import { marks, nodes, schema } from "common/editor/doc-schema";

const names = Object.keys(nodes);
const markNames = Object.keys(marks);

const fixture = {
  nodes: names.map((name) => ({
    name,
    spec: nodes[name],
    isLeaf: schema.isLeaf(name),
    isInline: schema.isInline(name),
    isTextblock: schema.isTextblock(name),
    allowedMarks: markNames.filter((mark) => schema.allowsMark(name, mark)),
    validChildren: names.filter((child) => schema.validContent(name, [{ type: child }])),
    validEmpty: schema.validContent(name, []),
  })),
  marks: markNames.map((name) => ({ name, spec: marks[name] })),
  groups: Object.fromEntries(["block", "inline", "list"].map((group) => [group, schema.groupMembers(group)])),
};

await Bun.write(path.join(import.meta.dir, "schema.json"), JSON.stringify(fixture, null, 1) + "\n");
