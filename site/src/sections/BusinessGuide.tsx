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
          <p className="eyebrow">How you use Colony</p>
          <h2 id="guide-title">
            Start with your business.
            <br />
            Then give your team a job.
          </h2>
          <p>
            Set up your account, describe your business and choose your first
            job. Keep the instructions, questions and results together.
          </p>
        </div>
        <div className="guide-sequence">
          <article>
            <div className="guide-explanation">
              <span className="step-number">01</span>
              <h3>Set up your business in Colony.</h3>
              <p>
                Create your account and save the code that helps you recover
                access. Then name your business and explain what it does. You
                can describe a business idea if you are just starting out.
              </p>
            </div>
            <div className="guide-message">
              <span>You tell Colony</span>
              <blockquote>
                “We help small teams learn new skills through practical training
                sessions.”
              </blockquote>
            </div>
          </article>
          <article>
            <div className="guide-explanation">
              <span className="step-number">02</span>
              <h3>Choose when to start your first job.</h3>
              <p>
                Colony opens a Welcome conversation with a suggested job. Edit
                the instructions to say what you need, then choose “Start this
                job.” You can also explore the app first.
              </p>
            </div>
            <div className="guide-message">
              <span>You write the instructions</span>
              <blockquote>
                “Use these meeting notes to list the training topics the client
                asked for. Point out any details we still need.”
              </blockquote>
              <div className="guide-assignment">
                <AntMark />
                <span>
                  You review the instructions before starting the job.
                </span>
              </div>
            </div>
          </article>
          <article>
            <div className="guide-explanation">
              <span className="step-number">03</span>
              <h3>Check the result. Say what comes next.</h3>
              <p>
                Follow the job in its thread, where the replies stay together.
                Answer questions, read the work and ask for changes. You decide
                how to use the result.
              </p>
            </div>
            <div className="guide-message">
              <span>You review the work</span>
              <blockquote>
                “Add teamwork to the list. We also need to ask how many people
                will attend.”
              </blockquote>
              <div className="guide-assignment">
                <AntMark />
                <span>Your feedback becomes the next instruction.</span>
              </div>
            </div>
          </article>
        </div>
        <p className="guide-availability">
          Early access is limited. AI work needs credits and an available
          employee with the right tools. We’ll explain what is available before
          you join.
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
