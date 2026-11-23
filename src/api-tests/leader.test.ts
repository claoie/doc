import { target } from "./harness";
import { describeHandover } from "./harness/handover";

/**
 * Two copies of the server on one database, as during a rolling deploy. One of
 * them leads realtime: it holds a lease (the single row of `realtime_leader`),
 * and only it keeps sockets open and replaces page content. The tests run in
 * order and hand the lead from copy to copy. `mixed.test.ts` runs the same with
 * a Bun and a Rust copy.
 */
describeHandover("two copies of the server, one after the other leading realtime", [target, target, target]);
