//! The doc backend in Rust.
//!
//! It serves the same HTTP API and WebSocket protocol as the Bun server in
//! `src/server`, on the same database, and is tested by the same suite
//! (`src/api-tests`). Modules keep the names of the TypeScript files they
//! port, so the two can be read side by side.

pub mod app;
pub mod auth;
pub mod auth_client;
pub mod bases;
pub mod common;
pub mod config;
pub mod content;
pub mod db;
pub mod duplicate;
pub mod emails;
pub mod export;
pub mod files;
pub mod http;
pub mod jsutil;
pub mod logger;
pub mod mail;
pub mod notifications;
pub mod pages;
pub mod permissions;
pub mod ratelimit;
pub mod realtime;
pub mod routes;
pub mod search;
pub mod shares;
pub mod smtp;
pub mod spaces;
pub mod sso;
pub mod static_files;
pub mod storage;
pub mod storage_s3;
pub mod users;
pub mod validate;
pub mod zip;
