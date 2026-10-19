pub mod document;
pub mod migration;
pub mod storage;
pub mod uninstall;

#[cfg(feature = "desktop")]
mod desktop;

#[cfg(feature = "desktop")]
pub use desktop::run;
