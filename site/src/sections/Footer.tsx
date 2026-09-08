import { AntMark } from "@/brand/AntMark";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap footer-inner">
        <a className="brand" href="#main" aria-label="Colony home">
          <AntMark className="brand-ant" />
          <span>Colony</span>
        </a>
        <p>Built by AI Native Ventures</p>
        <a href="mailto:basheer@ainative.ventures">
          Contact us <span aria-hidden="true">↗</span>
        </a>
      </div>
    </footer>
  );
}
