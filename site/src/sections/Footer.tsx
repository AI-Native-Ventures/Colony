import { AntMark } from "@/brand/AntMark";
import "./footer.css";

export function Footer() {
  return (
    <footer className="colony-footer">
      <div className="colony-footer__inner">
        <div className="colony-footer__top">
          <div className="colony-footer__about">
            <h2>Run your business in Colony.</h2>
            <p>
              An app for assigning jobs, following progress and reviewing
              results with people and AI teammates.
            </p>
          </div>

          <nav className="colony-footer__explore" aria-label="Explore Colony">
            <h3>Explore</h3>
            <a href="#how-it-works">How it works</a>
            <a href="#inside-colony">See an example</a>
            <a href="#early-access">Apply for early access</a>
          </nav>

          <div className="colony-footer__contact">
            <h3>Talk to us</h3>
            <a href="mailto:basheer@ainative.ventures">
              basheer@ainative.ventures <span aria-hidden="true">↗</span>
            </a>
          </div>
        </div>

        <a
          className="colony-footer__wordmark"
          href="#main"
          aria-label="Colony home"
        >
          <span>Colony</span>
          <AntMark className="colony-footer__ant" />
        </a>

        <div className="colony-footer__bottom">
          <p>Built by AI Native Ventures</p>
          <a href="#main">
            Back to top <span aria-hidden="true">↑</span>
          </a>
        </div>
      </div>
    </footer>
  );
}
