//! Bounded, SSRF-safe evidence collection from a company's public website.
//!
//! Collects *evidence*, never conclusions: pages, structured data, brand
//! assets and explicit gaps. Inferring what a business sells is the Chief of
//! Staff's job, and it must be able to show its sources.

pub mod brand_kit;
pub mod extract;
pub mod fetch;
pub mod sitemap;
pub mod url_guard;
