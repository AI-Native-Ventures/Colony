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
            You explain what you need in a conversation. The team works on it
            and brings back questions and results.
          </p>
        </div>
        <div className="guide-sequence">
          <article>
            <div className="guide-explanation">
              <span className="step-number">01</span>
              <h3>Tell Colony about your business.</h3>
              <p>
                Explain what you do, who you help and what matters to you. Add
                the documents and information your team should use.
              </p>
            </div>
            <div className="guide-message">
              <span>You tell Colony</span>
              <blockquote>
                “We train small teams. Here are our services, prices and notes
                from our latest client meeting.”
              </blockquote>
              <div className="guide-files">
                <span>Services and prices.pdf</span>
                <span>Meeting notes.docx</span>
              </div>
            </div>
          </article>
          <article>
            <div className="guide-explanation">
              <span className="step-number">02</span>
              <h3>Say what needs to be done.</h3>
              <p>
                Tell your AI team the result you want and when you need it. It
                can ask for missing information as the work goes along.
              </p>
            </div>
            <div className="guide-message">
              <span>You give the job</span>
              <blockquote>
                “Prepare a training proposal for Oak Studio by Thursday. Use the
                meeting notes and our prices. Show me a draft first.”
              </blockquote>
              <div className="guide-assignment">
                <AntMark />
                <span>
                  One clear job, with a deadline and a result to check.
                </span>
              </div>
            </div>
          </article>
          <article>
            <div className="guide-explanation">
              <span className="step-number">03</span>
              <h3>Check the result. Say what comes next.</h3>
              <p>
                Open the work your team brings back. Ask for changes, answer
                questions and decide whether it is ready. The conversation stays
                with the job.
              </p>
            </div>
            <div className="guide-message">
              <span>You review the work</span>
              <blockquote>
                “Make the first session shorter and add more practice time. Show
                me the revised proposal.”
              </blockquote>
              <div className="guide-assignment">
                <AntMark />
                <span>Your feedback becomes the next instruction.</span>
              </div>
            </div>
          </article>
        </div>
        <p className="guide-availability">
          This is the experience we’re building. The jobs available in early
          access will depend on the teammates and tools ready for you.
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
              Give your AI team lead a job. It organises the other AI teammates,
              checks their work and brings questions and results back to you.
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
                <h3>AI teammates carry out the jobs.</h3>
                <p>
                  They research, write and use the tools available for their
                  work. Their lead checks the results and asks for corrections.
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
              Keep customer information with the jobs it belongs to. See who is
              responsible, what is waiting and what is ready for you.
            </p>
            <blockquote>
              “Here are this week’s priorities. What is waiting on me, and which
              jobs are at risk of being late?”
            </blockquote>
          </article>
        </div>
      </section>
    </>
  );
}
