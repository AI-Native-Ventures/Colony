import * as React from "react";

let loggedWebsiteAttachmentFailure = false;

type WebsiteAttachmentBoundaryState = { failed: boolean };

/**
 * Local error boundary for the website projection inside a message row.
 *
 * A defect in the website attachment must degrade to "nothing rendered" for
 * that row instead of taking the whole timeline into the app error boundary.
 * The first failure is logged once; later rows stay silent.
 */
export class WebsiteAttachmentBoundary extends React.Component<
  { children: React.ReactNode },
  WebsiteAttachmentBoundaryState
> {
  state: WebsiteAttachmentBoundaryState = { failed: false };

  static getDerivedStateFromError(): WebsiteAttachmentBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    if (loggedWebsiteAttachmentFailure) return;
    loggedWebsiteAttachmentFailure = true;
    console.error("Website attachment projection failed to render", error);
  }

  render(): React.ReactNode {
    if (this.state.failed) return null;
    return this.props.children;
  }
}
