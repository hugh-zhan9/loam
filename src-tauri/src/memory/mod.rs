//! The memory layer.
//!
//! Two implementations live here at once during the migration to the mempal
//! engine: `legacy` is the Markdown-and-index memory this application shipped
//! with, re-exported wholesale so every existing caller keeps compiling, and
//! the modules beside it are the replacement being built up slice by slice.
//!
//! Only one of them is ever wired to the command surface. `legacy` is deleted
//! once the new engine owns that surface; see
//! `docs/loopx/plans/2026-08-17-memory-engine-adoption.md`.

pub mod api;
pub mod bundle;
pub mod capture;
pub mod config;
pub mod daemon;
pub mod embedder;
pub mod engine;
pub mod evidence;
pub mod import_legacy;
pub mod knowledge;
pub mod lark_export;
pub mod models;
pub mod retrieval;
pub mod wiki_promote;

#[cfg(test)]
mod engine_tests;
