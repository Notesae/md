pub mod document;
pub mod migration;
pub mod storage;
pub mod uninstall;
pub mod update;

#[cfg(feature = "desktop")]
mod update_service;

#[cfg(feature = "desktop")]
mod desktop;

#[cfg(feature = "desktop")]
pub use desktop::run;
