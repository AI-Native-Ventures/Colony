// Design-system barrel for /design-sync. Not part of the app build.
// Re-exports the core primitives from src/shared/ui so the converter can
// bundle them without pulling in the whole application graph.
// Dialog/Sheet overlays read `isDark` from the theme context, so the provider
// has to be exported for previews (and designs) to render them at all.
export { ThemeProvider } from "./src/shared/theme/ThemeProvider";
export { ColonyProvider } from "./ds-provider";
export * from "./src/shared/ui/alert";
export * from "./src/shared/ui/alert-dialog";
export * from "./src/shared/ui/avatar";
export * from "./src/shared/ui/badge";
export * from "./src/shared/ui/button";
export * from "./src/shared/ui/card";
export * from "./src/shared/ui/carousel";
export * from "./src/shared/ui/checkbox";
export * from "./src/shared/ui/context-menu";
export * from "./src/shared/ui/dialog";
export * from "./src/shared/ui/dropdown-menu";
export * from "./src/shared/ui/input";
export * from "./src/shared/ui/PageHeader";
export * from "./src/shared/ui/popover";
export * from "./src/shared/ui/progress";
export * from "./src/shared/ui/separator";
export * from "./src/shared/ui/sheet";
export * from "./src/shared/ui/skeleton";
export * from "./src/shared/ui/spinner";
export * from "./src/shared/ui/step-progress";
export * from "./src/shared/ui/switch";
export * from "./src/shared/ui/tabs";
export * from "./src/shared/ui/textarea";
export * from "./src/shared/ui/toggle";
export * from "./src/shared/ui/tooltip";
