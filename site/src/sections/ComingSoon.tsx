import { type FormEvent, useRef, useState } from "react";
import { AntMark } from "@/brand/AntMark";
import {
  APPLICATION_RECIPIENT,
  buildApplicationEmail,
  type EarlyAccessApplication,
} from "./applicationEmail";
import "./early-access.css";

export function ComingSoon() {
  const [draft, setDraft] = useState<ReturnType<
    typeof buildApplicationEmail
  > | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const draftPanel = useRef<HTMLElement>(null);
  const applicationText = useRef<HTMLTextAreaElement>(null);
  const workInput = useRef<HTMLTextAreaElement>(null);

  function validateWork() {
    const field = workInput.current;
    if (!field) return;
    field.setCustomValidity(
      field.value.trim() ? "" : "Tell us what you’d like to do in Colony.",
    );
  }

  function prepareApplication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    validateWork();
    if (!form.reportValidity()) return;

    const answers = new FormData(form);
    const application: EarlyAccessApplication = {
      name: String(answers.get("name") ?? ""),
      email: String(answers.get("email") ?? ""),
      stage: answers.get("stage") as EarlyAccessApplication["stage"],
      work: String(answers.get("work") ?? ""),
    };
    setDraft(buildApplicationEmail(application));
    setCopyState("idle");
    requestAnimationFrame(() => draftPanel.current?.focus());
  }

  function clearDraft() {
    setDraft(null);
    setCopyState("idle");
  }

  async function copyApplication() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft.clipboardText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
      applicationText.current?.focus();
      applicationText.current?.select();
    }
  }

  return (
    <section
      id="early-access"
      className="early-access"
      aria-labelledby="early-access-title"
    >
      <div className="early-access__inner">
        <div className="early-access__intro">
          <div className="early-access__ants" aria-hidden="true">
            <AntMark className="early-access__ant early-access__ant--first" />
            <AntMark className="early-access__ant early-access__ant--second" />
            <AntMark className="early-access__ant early-access__ant--third" />
          </div>
          <p className="early-access__eyebrow">Apply for early access</p>
          <h2 id="early-access-title">Bring your business to Colony.</h2>
          <p>
            Starting a business, already running one, or exploring an idea? Tell
            us about the work you want to do in Colony.
          </p>
          <p className="early-access__explanation">
            Colony is still being built and tested. Early access is limited.
            Applying does not give you access straight away.
          </p>
          <div className="early-access__delivery">
            <h3>Your application goes by email.</h3>
            <p>
              First, fill in this form. Next, check your application and open it
              in your email app. Nothing is sent until you send that email.
            </p>
            <p>
              Send it to <strong>{APPLICATION_RECIPIENT}</strong>.
            </p>
          </div>
        </div>

        <div className="early-access__application">
          <form onSubmit={prepareApplication} onChange={clearDraft}>
            <p className="early-access__required">All fields are required.</p>
            <div className="early-access__field">
              <label htmlFor="application-name">Your name</label>
              <input
                id="application-name"
                name="name"
                type="text"
                autoComplete="name"
                pattern={".*\\S.*"}
                title="Please enter your name."
                maxLength={80}
                required
              />
            </div>
            <div className="early-access__field">
              <label htmlFor="application-email">Your email address</label>
              <input
                id="application-email"
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                required
              />
            </div>
            <div className="early-access__field">
              <label htmlFor="application-stage">Which describes you?</label>
              <select
                id="application-stage"
                name="stage"
                defaultValue=""
                required
              >
                <option value="" disabled>
                  Choose one
                </option>
                <option value="starting">I’m starting a business</option>
                <option value="existing">I already run a business</option>
                <option value="exploring">I’m exploring an idea</option>
              </select>
            </div>
            <div className="early-access__field">
              <label htmlFor="work">What would you like to do in Colony?</label>
              <textarea
                id="work"
                name="work"
                ref={workInput}
                rows={4}
                maxLength={600}
                onChange={validateWork}
                aria-describedby="application-work-hint"
                required
              />
              <p id="application-work-hint" className="early-access__hint">
                Tell us about your business and the work you want help with.
              </p>
            </div>
            <button className="early-access__primary" type="submit">
              Continue in email <span aria-hidden="true">↗</span>
            </button>
            <p className="early-access__hint early-access__form-note">
              You’ll check the draft next. This button does not send it.
            </p>
          </form>

          {draft && (
            <section
              className="early-access__draft"
              aria-labelledby="application-draft-title"
              ref={draftPanel}
              tabIndex={-1}
            >
              <p className="early-access__eyebrow">
                Your email is ready to check
              </p>
              <h3 id="application-draft-title">Nothing has been sent yet.</h3>
              <p>
                Check the details below. Open your email app, then send the
                application to <strong>{draft.recipient}</strong>.
              </p>
              <label htmlFor="application-draft">Your application</label>
              <textarea
                id="application-draft"
                ref={applicationText}
                className="early-access__draft-text"
                readOnly
                rows={11}
                value={draft.clipboardText}
              />
              <p className="early-access__hint">
                To change an answer, edit the form above and continue again.
              </p>
              <div className="early-access__actions">
                <a className="early-access__primary" href={draft.mailto}>
                  Open email app <span aria-hidden="true">↗</span>
                </a>
                <button
                  className="early-access__secondary"
                  type="button"
                  onClick={copyApplication}
                >
                  Copy application
                </button>
              </div>
              <p className="early-access__hint">
                Email app didn’t open? Copy the application, paste it into a new
                email and send it to {draft.recipient}.
              </p>
              <p className="early-access__copy-status" role="status">
                {copyState === "copied" &&
                  "Copied. Paste it into your email app. You still need to send it."}
                {copyState === "failed" &&
                  "Copy didn’t work. Select and copy the text above, then paste it into your email app."}
              </p>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
