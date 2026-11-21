//! Ports of `src/server/realtime`: the socket registry, collaborative page
//! sessions, the realtime leader lease and the WebSocket endpoint.

pub mod collab;
pub mod hub;
pub mod leader;
pub mod ws;
