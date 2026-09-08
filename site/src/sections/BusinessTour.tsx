import { useRef, useState } from "react";
import { AntMark } from "@/brand/AntMark";
import "./business-tour.css";

const views = [
  { name: "Inbox", hint: "Decisions & results", symbol: "↳" },
  { name: "Work", hint: "Jobs & progress", symbol: "▤" },
  { name: "Clients", hint: "Customer information", symbol: "◎" },
  { name: "Team", hint: "People & AI teammates", symbol: "✳" },
] as const;
type View = (typeof views)[number]["name"];

export function BusinessTour() {
  const [view, setView] = useState<View>("Work");
  const [days, setDays] = useState<1 | 2 | null>(null);
  const panel = useRef<HTMLElement>(null);

  function openInbox() {
    setView("Inbox");
    requestAnimationFrame(() => panel.current?.focus());
  }

  return (
    <section
      className="business-tour section-wrap"
      id="inside-colony"
      aria-labelledby="tour-title"
    >
      <div className="tour-introduction">
        <div>
          <p className="eyebrow">Take a look inside</p>
          <h2 id="tour-title">A place for the day-to-day work.</h2>
        </div>
        <p>
          Explore the four sections below.
          <br />
          This illustrates the planned app, using a fictional business.
        </p>
      </div>
      <div className="tour-window">
        <div className="tour-topbar">
          <span className="tour-business">
            <AntMark />
            Brightside Training
          </span>
          <span className="tour-sample">Example business</span>
        </div>
        <div className="tour-layout">
          <nav className="tour-navigation" aria-label="Explore the planned app">
            {views.map(({ name, hint, symbol }) => (
              <button
                key={name}
                type="button"
                aria-pressed={view === name}
                aria-controls="tour-panel"
                onClick={() => setView(name)}
              >
                <span className="tour-nav-symbol" aria-hidden="true">
                  {symbol}
                </span>
                <span>
                  <strong>{name}</strong>
                  <small>{hint}</small>
                </span>
                {name === "Inbox" && (
                  <span className="tour-count">{days ? "1" : "2"}</span>
                )}
              </button>
            ))}
            <div className="tour-sidebar-note">
              <AntMark />
              <p>
                Your business.
                <br />
                Your people.
                <br />
                Your AI team.
              </p>
            </div>
          </nav>
          <section
            className="tour-panel"
            id="tour-panel"
            ref={panel}
            tabIndex={-1}
            aria-label={`${view} example`}
          >
            {view === "Work" && (
              <>
                <div className="tour-panel-heading">
                  <p>Work</p>
                  <h3>Who is doing what?</h3>
                  <span>
                    See the job, who is responsible and how it is going.
                  </span>
                </div>
                <div className="tour-work-list">
                  <article className="tour-work-row">
                    <span className="tour-job-icon violet">
                      <AntMark />
                    </span>
                    <div>
                      <h4>Prepare Oak Studio’s training proposal</h4>
                      <p>AI team lead · Due Thursday</p>
                    </div>
                    <span
                      className={`tour-status ${days ? "status-running" : "status-waiting"}`}
                    >
                      {days ? "In progress" : "Needs your answer"}
                    </span>
                  </article>
                  <article className="tour-work-row">
                    <span className="tour-job-icon blue">
                      <AntMark />
                    </span>
                    <div>
                      <h4>Research venues for the workshop</h4>
                      <p>Research teammate · Due Wednesday</p>
                    </div>
                    <span className="tour-status status-running">
                      In progress
                    </span>
                  </article>
                  <article className="tour-work-row">
                    <span className="tour-person">J</span>
                    <div>
                      <h4>Confirm who will attend</h4>
                      <p>Jamie · Your colleague · Due Wednesday</p>
                    </div>
                    <span className="tour-status status-running">
                      In progress
                    </span>
                  </article>
                  <article className="tour-work-row">
                    <span className="tour-job-icon green">
                      <AntMark />
                    </span>
                    <div>
                      <h4>Summarise the client meeting</h4>
                      <p>Writing teammate · Draft ready</p>
                    </div>
                    <span className="tour-status status-review">
                      Ready to review
                    </span>
                  </article>
                </div>
                <div className="tour-bottom-note">
                  <span aria-hidden="true">↳</span>
                  <p>
                    Each job keeps its conversation, files and progress
                    together.
                  </p>
                  <button type="button" onClick={openInbox}>
                    See what needs you <span aria-hidden="true">→</span>
                  </button>
                </div>
              </>
            )}
            {view === "Inbox" && (
              <>
                <div className="tour-panel-heading">
                  <p>Inbox</p>
                  <h3>What needs your attention?</h3>
                  <span>
                    Answer a question or open work that is ready to check.
                  </span>
                </div>
                <div className="tour-question">
                  <div className="tour-card-label">
                    <AntMark />
                    <span>AI team lead · Training proposal</span>
                  </div>
                  <h4>Should the workshop last one day or two?</h4>
                  <p>
                    The client’s notes mention both. I need your answer to
                    finish the plan.
                  </p>
                  <div className="tour-choice-buttons">
                    <button
                      type="button"
                      aria-pressed={days === 1}
                      onClick={() => setDays(1)}
                    >
                      One day
                    </button>
                    <button
                      type="button"
                      aria-pressed={days === 2}
                      onClick={() => setDays(2)}
                    >
                      Two days
                    </button>
                  </div>
                  {days && (
                    <p className="tour-answer" role="status">
                      Example answer saved:{" "}
                      {days === 1 ? "one day" : "two days"}. The proposal now
                      shows “In progress” in Work.
                    </p>
                  )}
                </div>
                <details className="tour-result">
                  <summary>
                    <span>
                      <strong>Client meeting summary</strong>
                      <small>Writing teammate · Ready to review</small>
                    </span>
                    <span className="tour-open-label">
                      Open draft <span aria-hidden="true">↗</span>
                    </span>
                  </summary>
                  <div className="tour-document">
                    <p className="tour-document-label">
                      Example draft · Oak Studio
                    </p>
                    <h4>What the client needs</h4>
                    <ul>
                      <li>Training for 12 new team members.</li>
                      <li>Practical exercises on speaking with customers.</li>
                      <li>A proposal with the session plan and price.</li>
                    </ul>
                    <p>
                      <strong>Still to confirm:</strong>{" "}
                      {days
                        ? `${days === 1 ? "One day" : "Two days"} selected. The workshop date is still needed.`
                        : "The workshop length and date."}
                    </p>
                  </div>
                </details>
              </>
            )}
            {view === "Clients" && (
              <>
                <div className="tour-panel-heading">
                  <p>Clients</p>
                  <h3>Keep the customer’s information with their work.</h3>
                  <span>
                    Find the instructions, ongoing jobs and files in the same
                    place.
                  </span>
                </div>
                <div className="tour-client">
                  <span className="tour-client-avatar">O</span>
                  <div>
                    <h4>Oak Studio</h4>
                    <p>Staff training · Contact: Alex</p>
                  </div>
                  <span
                    className={`tour-status ${days ? "status-running" : "status-waiting"}`}
                  >
                    {days ? "Proposal in progress" : "Needs your answer"}
                  </span>
                </div>
                <div className="tour-client-columns">
                  <div>
                    <h4>What they need</h4>
                    <p>
                      Help 12 new team members feel confident speaking with
                      customers.
                    </p>
                    <h4>Useful information</h4>
                    <ul>
                      <li>Notes from the first meeting</li>
                      <li>Your training services and prices</li>
                      <li>The client’s questions</li>
                    </ul>
                  </div>
                  <div>
                    <h4>Work for this client</h4>
                    <p>
                      Training proposal
                      <br />
                      <small>
                        {days
                          ? `${days === 1 ? "One-day" : "Two-day"} workshop · In progress`
                          : "Workshop length needs your answer"}
                      </small>
                    </p>
                    <p>
                      Client meeting summary
                      <br />
                      <small>Draft ready to review</small>
                    </p>
                    <div className="tour-client-note">
                      The team can use this information when you give it another
                      job.
                    </div>
                  </div>
                </div>
              </>
            )}
            {view === "Team" && (
              <>
                <div className="tour-panel-heading">
                  <p>Team</p>
                  <h3>Know who you can ask.</h3>
                  <span>
                    People and AI teammates work on the same business.
                  </span>
                </div>
                <div className="tour-team-lead">
                  <span className="tour-job-icon violet">
                    <AntMark />
                  </span>
                  <div>
                    <h4>Your AI team lead</h4>
                    <p>
                      Organises the job, gives work to other AI teammates and
                      checks what they produce.
                    </p>
                  </div>
                </div>
                <div className="tour-team-grid">
                  <article>
                    <AntMark className="blue" />
                    <span>AI teammate</span>
                    <h4>Research</h4>
                    <p>Finds information and compares options for the job.</p>
                  </article>
                  <article>
                    <AntMark className="pink" />
                    <span>AI teammate</span>
                    <h4>Writing</h4>
                    <p>Prepares drafts from the information you provide.</p>
                  </article>
                  <article>
                    <span className="tour-person">J</span>
                    <span>Your colleague</span>
                    <h4>Jamie</h4>
                    <p>Works alongside the AI team and shares updates.</p>
                  </article>
                </div>
                <p className="tour-team-note">
                  You choose the priorities. Your team brings back progress,
                  questions and work to review.
                </p>
              </>
            )}
          </section>
        </div>
        <div className="tour-caption">
          <span className="tour-caption-dot" />
          Interactive illustration. These sample jobs and answers are not live
          work.
        </div>
      </div>
    </section>
  );
}
