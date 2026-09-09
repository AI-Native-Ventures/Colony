import { AntMark } from "@/brand/AntMark";
import { AntParade } from "@/brand/BrandField";
import "./business-guide.css";

export function BusinessGuide() {
  return (
    <>
      <section
        id="how-it-works"
        className="business-guide section-wrap"
        aria-labelledby="guide-title"
      >
        <div className="section-heading">
          <p className="eyebrow">How it works</p>
          <h2 id="guide-title">Up and running in about ten minutes.</h2>
          <p>Four steps. No coding, nothing to set up.</p>
        </div>
        <div className="guide-sequence">
          <article>
            <div className="guide-explanation">
              <span className="step-number">01</span>
              <h3>Tell Colony what your business does.</h3>
              <p>
                Type a few sentences, like “I run a plumbing company in Cape
                Town.” Or paste your website address and Colony reads it.
              </p>
            </div>
            <div className="guide-message">
              <span>You tell Colony</span>
              <blockquote>
                “I run a plumbing company in Cape Town. We do emergency
                call-outs and bathroom fittings.”
              </blockquote>
            </div>
          </article>
          <article>
            <div className="guide-explanation">
              <span className="step-number">02</span>
              <h3>Meet your team.</h3>
              <p>
                Colony suggests the AI employees a business like yours needs.
                For a plumber: one to find new customers, one to write quotes
                and emails, one to manage the others. You choose which to keep.
              </p>
            </div>
            <div className="guide-message">
              <span>Colony suggests</span>
              <blockquote>
                “Three employees for your plumbing company: one to find new
                customers, one to write quotes and emails, one to manage the
                others. Keep all three?”
              </blockquote>
              <div className="guide-assignment">
                <AntMark />
                <span>You choose which employees to keep.</span>
              </div>
            </div>
          </article>
          <article>
            <div className="guide-explanation">
              <span className="step-number">03</span>
              <h3>Give them work.</h3>
              <p>Type a job the way you would text a staff member.</p>
            </div>
            <div className="guide-message">
              <span>You write the job</span>
              <blockquote>
                “Find 20 offices in Sandton that might need a plumber, and write
                a short email to each one.”
              </blockquote>
              <div className="guide-assignment">
                <AntMark />
                <span>
                  You can change the instructions before the job starts.
                </span>
              </div>
            </div>
          </article>
          <article>
            <div className="guide-explanation">
              <span className="step-number">04</span>
              <h3>Check and approve.</h3>
              <p>
                The finished work comes back in the chat. Anything going out in
                your name, like an email or a post, shows an Approve button
                first. Nothing is sent until you click it.
              </p>
            </div>
            <div className="guide-message">
              <span>Your employee reports</span>
              <blockquote>
                “Done: 20 offices found, with a contact name for each. 20 emails
                drafted. Send them?”
              </blockquote>
              <div className="guide-assignment">
                <AntMark />
                <span>Nothing is sent until you click Approve.</span>
              </div>
            </div>
          </article>
        </div>
        <p className="guide-availability">
          Early access is limited. We’ll explain what is available and what it
          costs before you join.
        </p>
      </section>
      <section className="business-control" aria-labelledby="control-title">
        <div className="section-wrap control-layout">
          <div>
            <AntParade />
            <p className="eyebrow">Your role in the business</p>
            <h2 id="control-title">
              You set the direction.
              <br />
              Your team handles the work.
            </h2>
            <p>
              Give your team clear instructions and keep the discussion in one
              place. An AI lead can coordinate a job with other AI employees.
              You review the work and decide what comes next.
            </p>
          </div>
          <div className="control-responsibilities">
            <article>
              <span className="control-number">You</span>
              <div>
                <h3>Choose what matters.</h3>
                <p>
                  Set priorities, explain what a good result looks like and make
                  the decisions your team needs.
                </p>
              </div>
            </article>
            <article>
              <span className="control-number">
                <AntMark />
              </span>
              <div>
                <h3>AI employees carry out the jobs.</h3>
                <p>
                  They research, write and use the tools available for their
                  work. The jobs they can take on depend on those tools and how
                  your team is set up.
                </p>
              </div>
            </article>
            <article>
              <span className="control-number">+</span>
              <div>
                <h3>Your people can work here too.</h3>
                <p>
                  Invite colleagues, share the same information and follow jobs
                  together. You can also start on your own.
                </p>
              </div>
            </article>
          </div>
        </div>
      </section>
      <section
        className="business-fit section-wrap"
        aria-labelledby="fit-title"
      >
        <div className="section-heading">
          <p className="eyebrow">Built around your business</p>
          <h2 id="fit-title">
            Start something new.
            <br />
            Or bring the business you already run.
          </h2>
        </div>
        <div className="business-fit-grid">
          <article>
            <span className="fit-label">Starting out</span>
            <h3>Turn your idea into work you can act on.</h3>
            <p>
              Use Colony to keep your research, plans and first jobs together.
              Give your AI team one clear piece of work at a time.
            </p>
            <blockquote>
              “Compare these three business ideas. Tell me who the customers
              would be and what I still need to find out.”
            </blockquote>
          </article>
          <article>
            <span className="fit-label">Already in business</span>
            <h3>Bring your team and ongoing work together.</h3>
            <p>
              Share updates, keep job details with their conversation and check
              the work before acting on it.
            </p>
            <blockquote>
              “Here are the notes from our client meeting. List the decisions
              and the work we need to do next.”
            </blockquote>
          </article>
        </div>
      </section>
    </>
  );
}
