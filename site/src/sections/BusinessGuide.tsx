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
      <section id="team" className="business-team" aria-labelledby="team-title">
        <div className="section-heading">
          <p className="eyebrow">What they can do</p>
          <h2 id="team-title">The jobs your AI employees can do today.</h2>
        </div>
        <div className="team-grid">
          <article>
            <h3>Find customers</h3>
            <p>
              Tell it who buys from you. It searches the web, finds real
              businesses and the people who run them, and hands you a list with
              names, contact details and why each one is a good fit.
            </p>
          </article>
          <article>
            <h3>Write for you</h3>
            <p>
              Website pages, emails to customers, quotes, social media posts.
              You read it, change what you like, and approve it.
            </p>
          </article>
          <article>
            <h3>Manage the team</h3>
            <p>
              Your first employee is a manager. It learns your business,
              suggests who to hire next, and tells you only what needs your
              attention, so you do not have to read everything.
            </p>
          </article>
        </div>
        <p className="guide-availability">
          More jobs are added over time. Every new employee joins the same team
          and the same chat.
        </p>
      </section>
      <section className="business-control" aria-labelledby="control-title">
        <div className="section-wrap control-layout">
          <div>
            <AntParade />
            <p className="eyebrow">You stay in charge</p>
            <h2 id="control-title">
              You are the boss. They ask before they act.
            </h2>
            <p>
              Your employees do the work. Every decision that matters comes back
              to you first.
            </p>
            <div
              className="approval-card"
              role="img"
              aria-label="Example: an email waits for your approval"
            >
              <span className="approval-tag">WAITING FOR YOUR OK</span>
              <p className="approval-question">
                <strong>
                  Send an intro email to the 5 car repair shops on the list?
                </strong>
              </p>
              <p className="approval-fine">
                It would be sent from your email address. You can read each
                email before it goes.
              </p>
              <div className="approval-row">
                <span className="approval-pill approval-yes">
                  Approve and send
                </span>
                <span className="approval-pill">Read them first</span>
                <span className="approval-pill">Not now</span>
              </div>
            </div>
          </div>
          <div className="control-responsibilities">
            <article>
              <span className="control-number">1</span>
              <div>
                <h3>Nothing goes out without your OK.</h3>
                <p>
                  Every email, post or message sent in your name shows up first
                  with an Approve button.
                </p>
              </div>
            </article>
            <article>
              <span className="control-number">2</span>
              <div>
                <h3>Each employee has its own login, not yours.</h3>
                <p>
                  If one makes a mistake, it cannot touch the others’ work or
                  your accounts.
                </p>
              </div>
            </article>
            <article>
              <span className="control-number">3</span>
              <div>
                <h3>You see what every job cost.</h3>
                <p>
                  In rands or dollars, per employee, per job. No surprise bills.
                </p>
              </div>
            </article>
            <article>
              <span className="control-number">4</span>
              <div>
                <h3>Hire or let go any time.</h3>
                <p>
                  Add a new employee or remove one in a click. No notice period.
                </p>
              </div>
            </article>
          </div>
        </div>
      </section>
      <section
        id="ai-bill"
        className="business-bill"
        aria-labelledby="bill-title"
      >
        <div className="section-heading">
          <p className="eyebrow">The AI bill</p>
          <h2 id="bill-title">
            Already pay for ChatGPT or Claude? Use it here.
          </h2>
          <p>
            AI employees think using an AI service such as ChatGPT or Claude. If
            you already pay for one, Colony can use it, so you pay nothing extra
            for the AI. If you do not, Colony can supply the AI and you pay for
            what your employees use.
          </p>
        </div>
      </section>
      <section
        className="business-fit section-wrap"
        aria-labelledby="fit-title"
      >
        <div className="section-heading">
          <p className="eyebrow">Three ways in</p>
          <h2 id="fit-title">
            Starting out, already busy, or running things for clients.
          </h2>
        </div>
        <div className="business-fit-grid">
          <article>
            <span className="fit-label">Starting out</span>
            <h3>Starting a business</h3>
            <p>
              You have an idea and no staff. Your AI team finds your first
              customers and writes your website before you spend a cent on
              salaries.
            </p>
            <blockquote>
              “Compare these three business ideas. Tell me who the customers
              would be and what I still need to find out.”
            </blockquote>
          </article>
          <article>
            <span className="fit-label">Already in business</span>
            <h3>Already running one</h3>
            <p>
              You have customers and no spare hours. Hand over the repeat work:
              follow-up emails, quotes, posts, finding new leads. Grow without
              hiring.
            </p>
            <blockquote>
              “Here are the notes from our client meeting. List the decisions
              and the work we need to do next.”
            </blockquote>
          </article>
          <article>
            <span className="fit-label">Agencies</span>
            <h3>An agency with clients</h3>
            <p>
              Give each client their own team, under your name. One bill comes
              to you, and you decide what to charge them.
            </p>
            <blockquote>
              “Set up a team for our new client, a bakery in Durban. First job:
              find 20 offices nearby that order catering.”
            </blockquote>
          </article>
        </div>
      </section>
    </>
  );
}
