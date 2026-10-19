pub mod document;
pub mod storage;

#[cfg(feature = "desktop")]
mod desktop;

#[cfg(feature = "desktop")]
pub use desktop::run;
