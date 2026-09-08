import { useId, useState } from "react";
import cakePhoto from "@/assets/examples/chocolate-cake.jpg";

/** Illustrates two kinds of client work; it does not simulate a live AI run. */
export function WorkExample() {
  const [example, setExample] = useState<"website" | "social">("website");
  const panelId = useId();
  return (
    <div className="example" id="example">
      <div className="example-heading">
        <span className="eyebrow">See the kind of work you can ask for</span>
        <span className="example-label">Illustrative example</span>
      </div>
      <fieldset className="example-switch" aria-label="Choose an example">
        <button
          type="button"
          aria-pressed={example === "website"}
          aria-controls={panelId}
          onClick={() => setExample("website")}
        >
          A client’s website
        </button>
        <button
          type="button"
          aria-pressed={example === "social"}
          aria-controls={panelId}
          onClick={() => setExample("social")}
        >
          A social media post
        </button>
      </fieldset>
      <div className="example-panel" id={panelId}>
        {example === "website" ? (
          <div className="bakery-website">
            <div className="preview-browser">
              <span aria-hidden="true">● ● ●</span>
              <span>Website example</span>
            </div>
            <div className="bakery-name">
              GREEN STREET <span>BAKERY</span>
            </div>
            <div className="bakery-intro">
              <p>
                A little joy.
                <br />
                <em>By the slice.</em>
              </p>
              <span>
                Made with care.
                <br />
                Shared with love.
              </span>
            </div>
            <img
              src={cakePhoto}
              width={1254}
              height={1254}
              alt="Two slices of chocolate cake on a cream plate, in an example bakery website"
              fetchPriority="high"
            />
            <div className="bakery-bottom">
              <span>Your new favourite cake.</span>
              <span aria-hidden="true">↗</span>
            </div>
          </div>
        ) : (
          <div className="bakery-social">
            <div className="social-identity">
              <span className="bakery-avatar" aria-hidden="true">
                g.
              </span>
              <span>
                Green Street Bakery<small>Example Instagram post</small>
              </span>
            </div>
            <div className="social-photo">
              <img
                src={cakePhoto}
                width={1254}
                height={1254}
                alt="Chocolate cake photograph used in an example social media post"
              />
              <p>
                Save room
                <br />
                <em>for cake.</em>
              </p>
            </div>
            <p className="social-caption">
              Meet your afternoon pick-me-up. Our chocolate cake is here, with
              rich layers and a little extra frosting. Who would you share a
              slice with?
            </p>
          </div>
        )}
      </div>
      <div className="example-request">
        <span className="you-label">You ask</span>
        <p>
          {example === "website"
            ? "“Build a website for my client’s bakery.”"
            : "“Make an Instagram post about my client’s chocolate cake.”"}
        </p>
      </div>
      <p className="example-note">
        Example designs for a fictional business, not a live product demo.
      </p>
    </div>
  );
}
