import { AntMark } from "@/brand/AntMark";
import "./work-conversation.css";

/** Explain a job discussion without imitating application screens or execution. */
export function WorkConversation() {
  return (
    <section
      className="work-example section-wrap"
      id="inside-colony"
      aria-labelledby="work-example-title"
    >
      <div className="work-example__intro">
        <div>
          <p className="eyebrow">People and AI, working together</p>
          <h2 id="work-example-title">A job starts with a conversation.</h2>
        </div>
        <p>
          Give your AI teammate a job. Discuss the details with your team. Open
          the work and ask for changes.
        </p>
      </div>

      <p className="work-example__label">
        Illustrated example <span aria-hidden="true">·</span> Sample messages
        and prices
      </p>

      <div className="work-example__layout">
        <div className="work-discussion">
          <h3 className="work-example__caption">The conversation</h3>
          <ol className="work-discussion__messages">
            <li className="work-message work-message--owner">
              <span className="work-message__avatar" aria-hidden="true">
                Y
              </span>
              <div>
                <h4>You</h4>
                <p>
                  Compare these two quotes for 100 folders. Show me the price
                  and payment differences.
                </p>
                <details className="work-example__quotes">
                  <summary>See the example quotes</summary>
                  <dl>
                    <div>
                      <dt>Option A</dt>
                      <dd>100 folders. R2,400 total. Payment now.</dd>
                    </div>
                    <div>
                      <dt>Option B</dt>
                      <dd>100 folders. R2,700 total. Payment in 30 days.</dd>
                    </div>
                  </dl>
                </details>
              </div>
            </li>
            <li className="work-message work-message--ai">
              <span className="work-message__avatar" aria-hidden="true">
                <AntMark />
              </span>
              <div>
                <h4>AI teammate</h4>
                <p>
                  Is paying later important, or would you rather spend less?
                </p>
              </div>
            </li>
            <li className="work-message work-message--colleague">
              <span className="work-message__avatar" aria-hidden="true">
                C
              </span>
              <div>
                <h4>Your colleague</h4>
                <p>We can pay now. Keeping the cost down matters more.</p>
              </div>
            </li>
          </ol>
          <p className="work-discussion__note">
            Your instructions, questions and replies stay with the work.
          </p>
        </div>

        <div className="work-output">
          <h3 className="work-example__caption">
            The work you open and review
          </h3>
          <article className="work-document" aria-labelledby="comparison-title">
            <div className="work-document__byline">
              <AntMark />
              <span>Example result from your AI teammate</span>
            </div>
            <h4 id="comparison-title">Folder price comparison</h4>
            <p className="work-document__summary">
              Both quotes are for 100 folders. Here is what differs.
            </p>
            <table>
              <caption className="sr-only">
                The two sample supplier quotes
              </caption>
              <thead>
                <tr>
                  <th scope="col">Details</th>
                  <th scope="col">Option A</th>
                  <th scope="col">Option B</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Total price</th>
                  <td>R2,400</td>
                  <td>R2,700</td>
                </tr>
                <tr>
                  <th scope="row">Payment</th>
                  <td>Now</td>
                  <td>In 30 days</td>
                </tr>
              </tbody>
            </table>
            <div className="work-document__finding">
              <h5>The difference</h5>
              <p>
                Option A costs <strong>R300 less</strong>. Option B gives you 30
                days to pay. Your team said it can pay now and wants to spend
                less.
              </p>
            </div>
            <p className="work-document__decision">
              You check the comparison and decide which option to choose.
            </p>
          </article>
          <p className="work-output__note">
            Open the result beside its conversation, with the instructions and
            discussion still in reach.
          </p>
        </div>
      </div>
    </section>
  );
}
