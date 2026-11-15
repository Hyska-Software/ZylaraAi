//! Tauri command surface. Commands are grouped by concern; each file in this
//! module is owned by one subsystem.

pub mod agents;
pub mod agent_hooks;
pub mod browser;
pub mod channels;
pub mod computer;
pub mod diagnostics;
pub mod inbox;
pub mod routines;
pub mod tasks;
pub mod artifacts;
pub mod attachments;
pub mod cache;
pub mod code;
pub mod conversations;
pub mod docker;
pub mod git;
pub mod github;
pub mod models;
pub mod notifications;
pub mod oauth;
pub mod plugins;
pub mod settings;
pub mod skills;
pub mod terminal;
pub mod themes;
pub mod turn;
pub mod update;
pub mod workspace;
