import "./example-job.css";
import { useState } from "react";
import cakePhoto from "@/assets/examples/chocolate-cake.jpg";
import { AntMark } from "@/brand/AntMark";

/** An explicitly illustrative interaction, with no AI request or external write. */
export function ExampleJob() {
  const [revised, setRevised] = useState(false);
  return (
    <div className="example-shell" id="example">
      <div className="example-caption">
        <span>
          <span className="tiny-dot" /> A client job, from request to result
        </span>
        <span>Interactive illustration</span>
      </div>
      <div className="job-window">
        <div className="job-topbar">
          <div className="job-client">
            <span className="client-icon">G</span>
            <div>
              <strong>Green Street Bakery</strong>
              <span>A fictional client</span>
            </div>
          </div>
          <span className="job-label">Website + social media</span>
        </div>
        <div className="job-layout">
          <div className="job-conversation">
            <div className="panel-title">
              <span className="step-pill">1</span>
              <h2>You tell Colony what to do</h2>
            </div>
            <p className="scenario">
              Imagine a bakery hires you to make its website and Instagram
              posts.
            </p>
            <div className="message from-you">
              <span className="message-author">You</span>
              <p>
                Make a website for Green Street Bakery and an Instagram post
                about their chocolate cake.
              </p>
              <p>
                They’re open Tuesday to Saturday, 8 am to 4 pm. Use these photos
                and their menu.
              </p>
              <div className="attachments">
                <span>▧ Bakery photos</span>
                <span>▤ Menu & prices</span>
              </div>
            </div>
            <div className="message from-colony">
              <span className="assistant-icon">
                <AntMark />
              </span>
              <div>
                <span className="message-author">Colony</span>
                <p>
                  Here’s the website and post. Have a look and tell me what
                  you’d like to change.
                </p>
              </div>
            </div>
            <div className={`change-request ${revised ? "is-revised" : ""}`}>
              <span className="message-author">Then ask for a change</span>
              <p>
                “They close at 2 pm on Saturdays. Make the words for the
                Instagram post shorter, too.”
              </p>
              <button
                className="example-change"
                type="button"
                aria-controls="example-results"
                onClick={() => setRevised(!revised)}
              >
                {revised ? "Reset the example" : "Show this example change"}
                <span aria-hidden="true">{revised ? "↺" : "→"}</span>
              </button>
            </div>
          </div>
          <div className="job-results" id="example-results">
            <div className="panel-title">
              <span className="step-pill green">2</span>
              <h2>You look at the work</h2>
            </div>
            <div className="deliverables">
              <article className="website-result">
                <div className="result-label">
                  <span aria-hidden="true">▣</span> A website for your client
                </div>
                <div className="bakery-page">
                  <div className="bakery-nav">
                    <strong>
                      green street<span>BAKERY</span>
                    </strong>
                    <span>Menu · Visit us</span>
                  </div>
                  <div className="bakery-heading">
                    <span>BAKED FRESH. SHARED DAILY.</span>
                    <h3>
                      A little joy.
                      <br />
                      <em>By the slice.</em>
                    </h3>
                  </div>
                  <img
                    src={cakePhoto}
                    width={1254}
                    height={1254}
                    alt="Chocolate cake in an example bakery website"
                    fetchPriority="high"
                  />
                  <div className="bakery-hours">
                    <span>Come say hello.</span>
                    <p>
                      Tue–Fri: 8 am–4 pm
                      <br />
                      <strong className={revised ? "highlight-change" : ""}>
                        Saturday: 8 am–{revised ? "2" : "4"} pm
                      </strong>
                    </p>
                  </div>
                </div>
              </article>
              <article className="social-result">
                <div className="result-label">
                  <span aria-hidden="true">◎</span> An Instagram post
                </div>
                <div className="social-post">
                  <div className="social-name">
                    <span>g.</span>
                    <strong>greenstreetbakery</strong>
                  </div>
                  <div className="post-photo">
                    <img
                      src={cakePhoto}
                      width={1254}
                      height={1254}
                      alt="Chocolate cake used in an example Instagram post"
                    />
                    <h3>
                      Save room
                      <br />
                      <em>for cake.</em>
                    </h3>
                  </div>
                  <div className="post-caption">
                    <span aria-hidden="true">♡　⌁　↗</span>
                    <p className={revised ? "highlight-change" : ""}>
                      {revised
                        ? "Chocolate cake. Fresh today. Come grab a slice!"
                        : "Fresh chocolate cake, made for your afternoon break. Bring a friend and share a slice at Green Street Bakery."}
                    </p>
                  </div>
                </div>
              </article>
            </div>
            <div className="result-status" role="status">
              {revised
                ? "Example updated: Saturday hours and the words for the post have changed."
                : "You review both pieces of work and decide what needs changing."}
            </div>
          </div>
        </div>
      </div>
      <p className="example-disclosure">
        Illustration for a fictional business, not a recording of Colony doing
        this job. Early-access features will be confirmed before you join.
      </p>
    </div>
  );
}
