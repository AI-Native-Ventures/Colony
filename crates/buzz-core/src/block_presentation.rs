//! Closed presentation choices for native Blocks; never arbitrary styles or code.
use serde::{Deserialize, Serialize};

/// Native section hierarchy.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SectionPresentation {
    /// Leading title and supporting copy.
    Lead,
    /// Normal body content.
    Body,
    /// A supporting callout.
    Callout,
}

/// Native card grouping.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CardPresentation {
    /// A framed surface.
    Surface,
    /// A compact content row.
    Row,
    /// Content with a quiet accent rail.
    Rail,
}

/// Native repeated-card grouping.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CardListPresentation {
    /// Rows separated by rules.
    Separated,
    /// An ordered sequence with visible numbers.
    Numbered,
}

/// Native layout of a repeated-card collection.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CardListMode {
    /// Stacked content rows.
    List,
    /// Columns that adapt to the containing message width.
    Grid,
    /// A navigable horizontal collection.
    Carousel,
}

/// Native details disclosure.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DetailsPresentation {
    /// Always-visible fact rows.
    Rows,
    /// Collapsed supporting facts.
    Disclosure,
}

/// Literal formats supported by native fact rows.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DetailValueFormat {
    /// Literal text.
    Text,
    /// Date or timestamp.
    Date,
    /// Yes/no display.
    Boolean,
}

/// Literal formats supported by native table cells.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TableValueFormat {
    /// Literal text.
    Text,
    /// A formatted number.
    Number,
    /// A currency amount.
    Currency,
    /// A date.
    Date,
    /// Yes/no display.
    Boolean,
}
