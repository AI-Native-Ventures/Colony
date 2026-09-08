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
            How to ask Colony
            <br />
            for work.
          </h2>
        </div>
        <div className="steps-grid">
          <article>
            <span className="step-number">01</span>
            <h3>Give it the details.</h3>
            <p>
              Tell Colony about the business. Add the pictures, prices, opening
              hours and other information it should use.
            </p>
            <div className="step-example">
              “Here’s my client’s menu and a few photos.”
            </div>
          </article>
          <article>
            <span className="step-number">02</span>
            <h3>Ask for the work.</h3>
            <p>
              Send a message saying what to make. The AI assistants use your
              instructions to build the website or create the post.
            </p>
            <div className="step-example">
              “Make a page for their new cake menu.”
            </div>
          </article>
          <article>
            <span className="step-number">03</span>
            <h3>Check it. Ask for changes.</h3>
            <p>
              Look at the result. Tell Colony what to change, in your own words.
              Review the work before you use it for your client.
            </p>
            <div className="step-example">
              “Use this photo instead and make the text shorter.”
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
            <p className="eyebrow">The work you can offer</p>
            <h2 id="work-title">
              New websites. Fresh posts.
              <br />
              Help with the next update, too.
            </h2>
          </div>
          <div className="work-grid">
            <article className="work-card website-work">
              <div className="work-icon">
                <AntMark />
              </div>
              <p className="work-type">Website assistant</p>
              <h3>
                Build and look after
                <br />
                client websites.
              </h3>
              <p>
                Ask for a new website, then return when your client needs to
                change a page, add pictures or update prices.
              </p>
              <ul>
                <li>Make a new business website</li>
                <li>Change text, pictures and prices</li>
                <li>Add pages for new products or services</li>
              </ul>
              <div className="request-chip">
                “Add my client’s new catering service to the website.”
              </div>
            </article>
            <article className="work-card social-work">
              <div className="work-icon">
                <AntMark />
              </div>
              <p className="work-type">Social media assistant</p>
              <h3>
                Create pictures and
                <br />
                words for social media.
              </h3>
              <p>
                Tell Colony what your client wants to promote. Ask for pictures
                and words for posts, then review and change them.
              </p>
              <ul>
                <li>Design images for posts</li>
                <li>Write the words for each post</li>
                <li>Make posts for offers and events</li>
              </ul>
              <div className="request-chip">
                “Make three posts about my client’s weekend special.”
              </div>
            </article>
          </div>
          <p className="work-availability">
            These are the jobs we’re building and testing first. Early access
            will include a limited set of tools.
          </p>
        </div>
      </section>
      <section
        className="discovery-section section-wrap"
        aria-labelledby="discovery-title"
      >
        <div className="discovery-copy">
          <p className="eyebrow">Need clients to work with?</p>
          <h2 id="discovery-title">
            Find businesses
            <br />
            you could help.
          </h2>
          <p>
            Tell Colony the kind of business you want to work with. Colony helps
            you find businesses you could research and contact.
          </p>
          <p>You choose who to approach and what service to offer.</p>
          <a className="text-link" href="#early-access">
            Apply for early access <span aria-hidden="true">↗</span>
          </a>
        </div>
        <div className="discovery-example">
          <div className="discovery-request">
            <AntMark />
            <p>“Find bakeries I could offer a website to.”</p>
          </div>
          <div className="prospect-list">
            <span className="prospect-label">
              Illustrative results · fictional businesses
            </span>
            {[
              ["G", "Green Street Bakery", "Bakery"],
              ["S", "Sunrise Bakes", "Bakery"],
              ["T", "The Daily Loaf", "Bakery"],
            ].map(([letter, name, type]) => (
              <div className="prospect" key={name}>
                <span>{letter}</span>
                <div>
                  <strong>{name}</strong>
                  <small>{type} · Business to research</small>
                </div>
                <span aria-hidden="true">↗</span>
              </div>
            ))}
          </div>
          <p>Finding a business does not mean it will buy your services.</p>
        </div>
      </section>
      <section className="audience-section">
        <div className="section-wrap audience-inner">
          <AntParade />
          <h2>
            Your first client.
            <br />
            Or the clients you already have.
          </h2>
          <div className="audience-grid">
            <div>
              <h3>Want to start an agency?</h3>
              <p>
                An agency does work for other businesses. You can offer website
                or social media services, then use Colony to help create the
                work you sell.
              </p>
            </div>
            <div>
              <h3>Already run an agency?</h3>
              <p>
                Use Colony to help with your clients’ websites, updates and
                social media posts. You give the instructions and check what
                gets delivered.
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
