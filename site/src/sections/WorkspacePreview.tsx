import { type ReactNode, useRef, useState } from "react";
import wordmark from "@/assets/colony-wordmark.svg";
import { AntMark } from "@/brand/AntMark";
import "./workspace-preview.css";

const icons = {
  inbox: "M3 4h14l3 10v5H2v-5L3 4Zm-1 10h5l2 3h6l2-3h3",
  tasks: "m2 5 2 2 4-4M11 5h9M2 13h5v5H2zM11 13h9M11 18h6",
  employees: "M8 5h8v3H8zM12 2v3M5 8h14v12H5zM2 12v4M22 12v4M9 12v3M15 12v3",
  billing: "M5 3h14v18H5zM15 7h-5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H8M12 5v12",
  search: "M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  settings: "M3 6h5m4 0h9M3 17h10m4 0h4M8 3v6M13 14v6",
  hash: "M9 3 6 21M18 3l-3 18M3 8h18M2 16h18",
  chevron: "m9 5 7 7-7 7",
  down: "m5 9 7 7 7-7",
  back: "m14 5-7 7 7 7M7 12h14",
  close: "m6 6 12 12M6 18 18 6",
  plus: "M12 4v16M4 12h16",
  attach: "m8 12 7-7a4 4 0 0 1 6 6L10 22a6 6 0 0 1-8-8L13 3M6 16l10-10",
  up: "M12 20V4M5 11l7-7 7 7",
  panel: "M3 4h18v16H3zM9 4v16",
} as const;

function Icon({ name }: { name: keyof typeof icons }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={icons[name]} />
    </svg>
  );
}

function Person({
  name,
  jobTitle,
  children,
}: {
  name: "You" | "Mira" | "Scout";
  jobTitle?: string;
  children: ReactNode;
}) {
  return (
    <div className={`preview-message preview-message--${name.toLowerCase()}`}>
      <span className="preview-avatar" aria-hidden="true">
        {name[0]}
      </span>
      <div className="preview-message__body">
        <div className="preview-message__author">
          <strong>{name}</strong>
        </div>
        {jobTitle && (
          <p className="preview-message__role">{jobTitle} · AI employee</p>
        )}
        <div className="preview-message__prose">{children}</div>
      </div>
    </div>
  );
}

function JobRequest() {
  return (
    <p>
      Compare these two quotes for 100 folders. Show me the price and payment
      differences.
    </p>
  );
}

function SupplierQuotes() {
  return (
    <details className="preview-quotes">
      <summary>2 supplier quotes</summary>
      <dl>
        <div>
          <dt>Option A</dt>
          <dd>100 folders · R2,400 · Pay now</dd>
        </div>
        <div>
          <dt>Option B</dt>
          <dd>100 folders · R2,700 · Pay in 30 days</dd>
        </div>
      </dl>
    </details>
  );
}

function Composer({ thread = false }: { thread?: boolean }) {
  const label = thread ? "Reply in thread to You" : "Message #general";
  return (
    <div className="preview-composer">
      <textarea
        disabled
        rows={1}
        aria-label={`${label} (preview only)`}
        placeholder={label}
      />
      <div className="preview-composer__tools" aria-hidden="true">
        <span>@</span>
        <Icon name="attach" />
        <span>☺</span>
        <span className="preview-composer__send">
          <Icon name="up" />
        </span>
      </div>
    </div>
  );
}

/** Source-aligned app layout, with fictional content and local viewing controls only. */
export function WorkspacePreview() {
  const [threadOpen, setThreadOpen] = useState(true);
  const repliesButton = useRef<HTMLButtonElement>(null);
  const threadHeading = useRef<HTMLHeadingElement>(null);

  function showThread(open: boolean) {
    setThreadOpen(open);
    requestAnimationFrame(() => {
      if (open) threadHeading.current?.focus({ preventScroll: true });
      else repliesButton.current?.focus({ preventScroll: true });
    });
  }

  return (
    <section
      className="workspace-example section-wrap"
      id="inside-colony"
      aria-labelledby="inside-colony-title"
    >
      <div className="workspace-example__intro">
        <div>
          <p className="eyebrow">Inside Colony</p>
          <h2 id="inside-colony-title">
            Your team talks.
            <br />
            The work stays with the conversation.
          </h2>
        </div>
        <p>
          Give a job to your AI employee in a shared conversation. Open its
          replies to discuss the details and review the result, all in the same
          place.
        </p>
      </div>
      <p className="workspace-example__label">
        <span className="workspace-example__dot" aria-hidden="true" />
        App preview <span aria-hidden="true">·</span> Sample business, messages
        and prices
      </p>

      <section
        className="workspace-preview"
        data-thread-open={threadOpen}
        aria-label="Example of the Colony app"
      >
        <div className="preview-rail" aria-hidden="true">
          <span className="preview-rail__business">YC</span>
          <span className="preview-rail__add">
            <Icon name="plus" />
          </span>
        </div>
        <aside className="preview-sidebar" aria-label="Example app navigation">
          <div className="preview-sidebar__history" aria-hidden="true">
            <Icon name="panel" />
            <Icon name="back" />
            <Icon name="chevron" />
          </div>
          <img className="preview-wordmark" src={wordmark} alt="Colony" />
          <div className="preview-business">
            <AntMark />
            <strong>Your company</strong>
            <Icon name="down" />
          </div>
          <p className="preview-sidebar__subtitle">Your business</p>
          <div className="preview-search">
            <Icon name="search" />
            <span>Search everything</span>
          </div>
          <ul className="preview-nav">
            {(
              [
                ["inbox", "Inbox"],
                ["tasks", "Tasks"],
                ["employees", "Employees"],
                ["billing", "Billing"],
              ] as const
            ).map(([icon, label]) => (
              <li key={label}>
                <Icon name={icon} />
                {label}
              </li>
            ))}
            <li>
              <span className="preview-more" aria-hidden="true">
                ···
              </span>
              More
              <Icon name="chevron" />
            </li>
          </ul>
          <div className="preview-channel-list">
            <p>Channels</p>
            <div className="preview-channel-list__selected">
              <Icon name="hash" />
              general
            </div>
            <div>
              <Icon name="hash" />
              Welcome
            </div>
          </div>
          <p className="preview-dm-label">Direct messages</p>
          <div className="preview-sidebar__bottom">
            <div className="preview-sidebar__ants">
              <AntMark />
              <AntMark />
              <AntMark />
            </div>
            <div className="preview-profile">
              <span className="preview-avatar">Y</span>
              <div>
                <strong>You</strong>
                <span>Your company</span>
              </div>
            </div>
            <div className="preview-settings">
              <Icon name="settings" />
              Settings
            </div>
          </div>
        </aside>

        <div className="preview-panes">
          <section
            className="preview-pane preview-channel"
            aria-labelledby="preview-channel-title"
          >
            <header className="preview-pane__header">
              <div>
                <h3 id="preview-channel-title">
                  <Icon name="hash" />
                  general
                </h3>
                <p>Company-wide updates</p>
              </div>
            </header>
            <section
              className="preview-pane__messages"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: This scroll region needs keyboard focus for Arrow and Page keys.
              tabIndex={0}
              aria-label="Sample channel messages"
            >
              <div className="preview-divider">
                <span>Today</span>
              </div>
              <Person name="Mira">
                <p>We need 100 folders for the next training session.</p>
              </Person>
              <div
                className={`preview-job${threadOpen ? " preview-job--selected" : ""}`}
              >
                <Person name="You">
                  <JobRequest />
                  <SupplierQuotes />
                  <button
                    ref={repliesButton}
                    className="preview-replies"
                    type="button"
                    onClick={() => showThread(true)}
                    aria-controls="preview-job-thread"
                    aria-expanded={threadOpen}
                  >
                    <span className="preview-reply-avatars" aria-hidden="true">
                      <span>M</span>
                      <span>S</span>
                    </span>
                    2 replies{" "}
                    <span className="preview-replies__hint">· Open thread</span>
                    <Icon name="chevron" />
                  </button>
                </Person>
              </div>
            </section>
            <Composer />
          </section>

          {threadOpen && (
            <section
              className="preview-pane preview-thread"
              id="preview-job-thread"
              aria-labelledby="preview-thread-title"
            >
              <header className="preview-pane__header">
                <div>
                  <h3
                    ref={threadHeading}
                    tabIndex={-1}
                    id="preview-thread-title"
                  >
                    Thread
                  </h3>
                  <p>#general</p>
                </div>
                <button
                  className="preview-close"
                  type="button"
                  onClick={() => showThread(false)}
                  aria-label="Close thread and return to general"
                >
                  <span className="preview-close__desktop">
                    <Icon name="close" />
                  </span>
                  <span className="preview-close__mobile">
                    <Icon name="back" />
                    Back
                  </span>
                </button>
              </header>
              <section
                className="preview-pane__messages"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: This scroll region needs keyboard focus for Arrow and Page keys.
                tabIndex={0}
                aria-label="Sample replies for the folder comparison"
              >
                <Person name="You">
                  <JobRequest />
                  <SupplierQuotes />
                </Person>
                <div className="preview-divider">
                  <span>Replies</span>
                </div>
                <Person name="Mira">
                  <p>We can pay now. Keeping the cost down matters more.</p>
                </Person>
                <Person name="Scout" jobTitle="Chief of Staff">
                  <p>Here’s the comparison.</p>
                  <article
                    className="preview-result"
                    aria-labelledby="preview-result-title"
                  >
                    <h4 id="preview-result-title">Folder price comparison</h4>
                    <table>
                      <caption className="sr-only">
                        Comparison of the two sample supplier quotes
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Quote</th>
                          <th scope="col">Total</th>
                          <th scope="col">Payment</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <th scope="row">Option A</th>
                          <td>R2,400</td>
                          <td>Now</td>
                        </tr>
                        <tr>
                          <th scope="row">Option B</th>
                          <td>R2,700</td>
                          <td>In 30 days</td>
                        </tr>
                      </tbody>
                    </table>
                    <p>
                      Option A costs <strong>R300 less</strong>. Option B gives
                      you more time to pay.
                    </p>
                  </article>
                  <p>Check the quotes before choosing a supplier.</p>
                </Person>
              </section>
              <Composer thread />
            </section>
          )}
        </div>
      </section>

      <div className="workspace-example__guide">
        <div>
          <span>01</span>
          <p>
            <strong>A place for your business.</strong>Find your conversations,
            jobs and AI employees in the sidebar.
          </p>
        </div>
        <div>
          <span>02</span>
          <p>
            <strong>A shared conversation.</strong>Give instructions and keep
            your people and AI employees in the loop.
          </p>
        </div>
        <div>
          <span>03</span>
          <p>
            <strong>The replies for one job.</strong>Open a thread to follow the
            discussion and check the work. Try closing and reopening this one.
          </p>
        </div>
      </div>
    </section>
  );
}
