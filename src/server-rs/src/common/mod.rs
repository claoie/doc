//! Ports of the parts of `src/common` the server uses.

pub mod bases;
pub mod editor;
pub mod formula;
pub mod ids;
pub mod jsdate;
pub mod jsnum;
pub mod positions;
pub mod text;

/// Where the diagram renderer is loaded from; the app's script policy allows exactly this path.
pub const MERMAID_BASE: &str = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/";
