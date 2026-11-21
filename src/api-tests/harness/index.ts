/**
 * The harness of the API suite. The suite talks to a server it starts as a
 * separate process, over HTTP and WebSocket only, so the same tests run
 * against the Bun server (`src/server`) and the Rust server (`src/server-rs`):
 *
 *   bun test src/api-tests                          # the Bun server
 *   API_TEST_SERVER=rust bun test src/api-tests     # the Rust server (cargo build --release first)
 *
 * Tests may read and arrange state in the database directly (`server.sql`),
 * but never import the server's own code.
 */
export { Client, uniqueIp, type ApiResponse, type ClientOptions } from "./client";
export { databaseUrl, doc, sql, startServer, STATIC_FILES, target, until, type StartOptions, type Target, type TestServer } from "./server";
export { startFakeSmtp, type FakeSmtp, type FakeSmtpOptions, type ReceivedMail } from "./smtp";
export { connect, type ConnectOptions, type Message, type Socket } from "./ws";
