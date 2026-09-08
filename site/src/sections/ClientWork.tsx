import "./client-work.css";
import { AntMark } from "@/brand/AntMark";
import { AntParade } from "@/brand/BrandField";

export function ClientWork() {
  return (
    <>
      <section
        className="owner-steps section-wrap"
        id="how-it-works"
        aria-labelledby="steps-title"
      >
        <div className="section-heading">
          <p className="eyebrow">How you use Colony</p>
          <h2 id="steps-title">
            Bring in your work.
            <br />
            Build a team to help you do it.
          </h2>
        </div>
        <div className="steps-grid">
          <article>
            <span className="step-number">01</span>
            <h3>Keep the work together.</h3>
            <p>
              Create a space for your business. Keep conversations, files and
              tasks together. Invite the people you work with.
            </p>
            <div className="step-example">
              “Here’s the plan for our new product.”
            </div>
          </article>
          <article>
            <span className="step-number">02</span>
            <h3>Give AI assistants jobs.</h3>
            <p>
              Describe what needs doing. Share the information the assistant
              should use. It uses its tools to do the work.
            </p>
            <div className="step-example">
              “Research these businesses and summarise what they offer.”
            </div>
          </article>
          <article>
            <span className="step-number">03</span>
            <h3>Check the work. Guide the team.</h3>
            <p>
              Follow the tasks, open the results and answer questions. Ask for
              changes when something needs to be different.
            </p>
            <div className="step-example">
              “Add the prices and make the summary shorter.”
            </div>
          </article>
        </div>
      </section>
      <section
        className="work-section"
        id="what-you-can-do"
        aria-labelledby="work-title"
      >
        <div className="section-wrap">
          <div className="section-heading">
            <p className="eyebrow">Our first examples</p>
            <h2 id="work-title">
              Website and social media work.
              <br />
              Two examples to get you started.
            </h2>
          </div>
          <div className="work-grid">
            <article className="work-card website-work">
              <div className="work-icon">
                <AntMark />
              </div>
              <p className="work-type">Example 1 · Website assistant</p>
              <h3>
                Build and look after
                <br />a business website.
              </h3>
              <p>
                Give the assistant your business details and ask for a website.
                Come back when you need to change a page, add pictures or update
                prices.
              </p>
              <ul>
                <li>Make a new business website</li>
                <li>Change text, pictures and prices</li>
                <li>Add pages for new products or services</li>
              </ul>
              <div className="request-chip">
                “Add our new catering service to the website.”
              </div>
            </article>
            <article className="work-card social-work">
              <div className="work-icon">
                <AntMark />
              </div>
              <p className="work-type">Example 2 · Social media assistant</p>
              <h3>
                Create pictures and
                <br />
                words for social media.
              </h3>
              <p>
                Tell the assistant what your business wants to promote. Ask for
                pictures and words for posts, then review and change them.
              </p>
              <ul>
                <li>Design images for posts</li>
                <li>Write the words for each post</li>
                <li>Make posts for offers and events</li>
              </ul>
              <div className="request-chip">
                “Make three posts about our weekend special.”
              </div>
            </article>
          </div>
          <p className="work-availability">
            We’re using these jobs to test Colony and build the first examples
            you can start with. We’ll add more examples for other kinds of work
            over time. Early-access features will be confirmed before you join.
          </p>
        </div>
      </section>
      <section
        className="discovery-section section-wrap"
        aria-labelledby="discovery-title"
      >
        <div className="discovery-copy">
          <p className="eyebrow">A shared place to work</p>
          <h2 id="discovery-title">
            Your people. Your AI assistants.
            <br />
            Working together.
          </h2>
          <p>
            Talk with people and AI assistants in the same conversations. Keep
            the tasks, documents and results with the work they belong to.
          </p>
          <p>
            Start on your own or invite your team. You decide what to work on
            and check what gets done.
          </p>
          <a className="text-link" href="#early-access">
            Apply for early access <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="discovery-example">
          <div className="discovery-request">
            <AntMark />
            <p>“Let’s plan next week’s work.”</p>
          </div>
          <div className="prospect-list">
            <span className="prospect-label">
              An example business workspace
            </span>
            {[
              ["P", "Product launch", "Conversations and tasks"],
              ["R", "Business research", "Information and findings"],
              ["W", "Website update", "Work to review"],
            ].map(([letter, name, detail]) => (
              <div className="prospect" key={name}>
                <span>{letter}</span>
                <div>
                  <strong>{name}</strong>
                  <small>{detail}</small>
                </div>
                <span aria-hidden="true">↗</span>
              </div>
            ))}
          </div>
          <p>Keep the conversation and the work it leads to in one place.</p>
        </div>
      </section>
      <section className="audience-section">
        <div className="section-wrap audience-inner">
          <AntParade />
          <h2>
            Your business has its own work to do.
            <br />
            Make Colony fit that work.
          </h2>
          <div className="audience-grid">
            <div>
              <h3>Starting a business?</h3>
              <p>
                Bring your idea and the work you need to get started. Set up a
                place to plan, keep information and work with AI assistants,
                even before you have a team.
              </p>
            </div>
            <div>
              <h3>Already running one?</h3>
              <p>
                Bring your team and the jobs you do every day. Set up assistants
                for the work you want help with. Websites and social media are
                examples, not the only kinds of work Colony is designed for.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
