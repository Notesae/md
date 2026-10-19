pub mod document;
pub mod migration;
pub mod storage;

#[cfg(feature = "desktop")]
mod desktop;

#[cfg(feature = "desktop")]
pub use desktop::run;
