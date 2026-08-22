/*
 * Colony onboarding prototype.
 *
 * Ten screens, both branches, every failure path, wired to the real Colony
 * component bundle on window.ColonyDS. Nothing here is app code: it exists to
 * be clicked through and argued with.
 *
 * Copy rule, from PRODUCT.md: plain words only. No CLI, no runtime, no
 * terminal, no key, no API key, and no assumption about what computer anyone
 * owns.
 */

const {
  ColonyProvider,
  Button,
  Input,
  Textarea,
  Checkbox,
  Progress,
} = window.ColonyDS;

const { useState, useEffect, useMemo, useRef, useCallback } = React;

/* ── Brand ─────────────────────────────────────────────────────────────── */

const HUE = {
  violet: "#8b5cf6",
  violetDeep: "#4c1d95",
  blue: "#3b82f6",
  pink: "#ec4899",
  pinkSoft: "#f9a8d4",
  amber: "#f59e0b",
  green: "#10b981",
  plum: "#6b1746",
  white: "#ffffff",
};

/*
 * One gradient per screen, drawn from the brand hues. The canvas shifts as the
 * flow advances, which is the progress indicator: no step counter appears
 * anywhere in the flow.
 */
const CANVAS = {
  account: {
    base: "#e9d9fb",
    ink: "dark",
    mesh: [
      [HUE.violet, "18%", "22%", "58%"],
      [HUE.pinkSoft, "78%", "72%", "62%"],
      [HUE.white, "50%", "45%", "40%"],
    ],
  },
  recovery: {
    base: "#c4b0f5",
    ink: "dark",
    mesh: [
      [HUE.violet, "30%", "70%", "66%"],
      [HUE.violetDeep, "82%", "24%", "48%"],
      [HUE.white, "44%", "40%", "30%"],
    ],
  },
  company: {
    base: "#f7d9c4",
    ink: "dark",
    mesh: [
      [HUE.pink, "22%", "18%", "56%"],
      [HUE.amber, "76%", "76%", "64%"],
      [HUE.white, "52%", "42%", "36%"],
    ],
  },
  probing: {
    base: "#cfe4f7",
    ink: "dark",
    mesh: [
      [HUE.blue, "24%", "26%", "62%"],
      [HUE.green, "80%", "74%", "58%"],
      [HUE.white, "48%", "46%", "38%"],
    ],
  },
  brains: {
    base: "#c9edda",
    ink: "dark",
    mesh: [
      [HUE.green, "26%", "30%", "62%"],
      [HUE.blue, "82%", "80%", "46%"],
      [HUE.white, "52%", "44%", "40%"],
    ],
  },
  install: {
    base: "#cbdcfa",
    ink: "dark",
    mesh: [
      [HUE.blue, "20%", "24%", "60%"],
      [HUE.violet, "80%", "76%", "58%"],
      [HUE.white, "50%", "46%", "36%"],
    ],
  },
  business: {
    base: "#f8dfb4",
    ink: "dark",
    mesh: [
      [HUE.amber, "24%", "72%", "62%"],
      [HUE.pinkSoft, "78%", "22%", "54%"],
      [HUE.white, "48%", "44%", "38%"],
    ],
  },
  reading: {
    base: "#c7e9e2",
    ink: "dark",
    mesh: [
      [HUE.green, "22%", "24%", "60%"],
      [HUE.blue, "78%", "72%", "60%"],
      [HUE.white, "50%", "48%", "36%"],
    ],
  },
  description: {
    base: "#f6e2ee",
    ink: "dark",
    mesh: [
      [HUE.white, "40%", "34%", "52%"],
      [HUE.pink, "80%", "76%", "56%"],
      [HUE.violet, "16%", "78%", "44%"],
    ],
  },
  credits: {
    base: "#3d0a2a",
    ink: "light",
    mesh: [
      [HUE.plum, "28%", "30%", "66%"],
      [HUE.violetDeep, "78%", "74%", "62%"],
      [HUE.pink, "62%", "18%", "34%"],
    ],
  },
  invite: {
    base: "#e6dafb",
    ink: "dark",
    mesh: [
      [HUE.violet, "22%", "26%", "58%"],
      [HUE.pink, "80%", "74%", "56%"],
      [HUE.white, "50%", "50%", "40%"],
    ],
  },
};

const GRAIN =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180">
      <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3"/></filter>
      <rect width="180" height="180" filter="url(#n)" opacity="0.5"/>
    </svg>`,
  );

/* ── The ant ───────────────────────────────────────────────────────────────
 * Geometry verbatim from docs/BRAND.md. Leg tripods are HTML-level layers so
 * their transforms run on the compositor: a transform on an SVG child freezes
 * whenever the main thread is busy, which is exactly when a loading state is
 * on screen.
 */

const LEG_STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 14,
  strokeLinecap: "round",
};

function AntBody({ maskId }) {
  return (
    <svg viewBox="0 0 466 309" fill="currentColor" aria-hidden="true">
      <defs>
        <mask
          id={maskId}
          x="-80"
          y="-80"
          width="626"
          height="469"
          maskUnits="userSpaceOnUse"
          maskContentUnits="userSpaceOnUse"
        >
          <rect x="-80" y="-80" width="626" height="469" fill="#fff" />
          <circle cx="335" cy="136" r="11" fill="#000" />
        </mask>
      </defs>
      <g {...LEG_STROKE}>
        <path d="M327 114 Q345 64 397 50" />
        <path d="M343 126 Q377 86 427 80" />
      </g>
      <g mask={`url(#${maskId})`}>
        <circle cx="104" cy="172" r="80" />
        <circle cx="226" cy="164" r="52" />
        <circle cx="313" cy="148" r="46" />
      </g>
    </svg>
  );
}

let markSeq = 0;

/** Static mark. Used wherever the ant is a signature, not an actor. */
function AntMark({ className, style }) {
  const maskId = useMemo(() => `ant-static-${++markSeq}`, []);
  return (
    <div
      className={`ob-sprite-wrap ${className || ""}`}
      style={style}
      aria-hidden="true"
    >
      <div className="ant-body-layer" style={{ animation: "none" }}>
        <AntBody maskId={maskId} />
      </div>
    </div>
  );
}

/** Walking mark. Used wherever something is actually happening. */
function WalkingAnt({ className, style }) {
  const maskId = useMemo(() => `ant-walk-${++markSeq}`, []);
  return (
    <div
      className={`ob-sprite-wrap ant-sprite ${className || ""}`}
      style={style}
      aria-hidden="true"
    >
      <div className="ant-leg-layer ant-leg-layer-a">
        <svg viewBox="0 0 466 309" aria-hidden="true">
          <g {...LEG_STROKE}>
            <path d="M257 198 L336 282" />
            <path d="M220 210 L196 298" />
            <path d="M164 215 L112 272" />
          </g>
        </svg>
      </div>
      <div className="ant-leg-layer ant-leg-layer-b">
        <svg viewBox="0 0 466 309" aria-hidden="true">
          <g {...LEG_STROKE}>
            <path d="M247 205 L294 294" />
            <path d="M235 209 L246 300" />
            <path d="M202 203 L136 292" />
          </g>
        </svg>
      </div>
      <div className="ant-body-layer">
        <AntBody maskId={maskId} />
      </div>
    </div>
  );
}

/* ── Foot: the pheromone trail carries progress ───────────────────────── */

function Foot({ step, total }) {
  const width = 520;
  const nodes = Array.from({ length: total }, (_, i) => ({
    x: 14 + (i * (width - 28)) / (total - 1),
    done: i <= step,
  }));
  const d = `M14 13 ${nodes.map((n) => `L${n.x} 13`).join(" ")}`;
  return (
    <div className="ob-foot">
      <svg
        className="ob-trail"
        viewBox={`0 0 ${width} 26`}
        fill="none"
        aria-hidden="true"
      >
        <path
          d={d}
          stroke="currentColor"
          strokeOpacity="0.28"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray="3 9"
          className="ob-trail__path"
        />
        {nodes.map((n, i) => (
          <circle
            key={i}
            className="ob-trail__node"
            cx={n.x}
            cy={13}
            r={n.done ? (i === step ? 5.5 : 3.5) : 2}
            fill="currentColor"
            opacity={n.done ? (i === step ? 1 : 0.55) : 0.18}
          />
        ))}
      </svg>
      <AntMark className="ob-mark" />
    </div>
  );
}

/* ── Shared pieces ─────────────────────────────────────────────────────── */

function Screen({ children, wide, solo, phase }) {
  return (
    <div
      className="ob-screen"
      data-wide={wide ? "true" : "false"}
      data-solo={solo ? "true" : "false"}
      data-phase={phase}
    >
      {children}
    </div>
  );
}

function Head({ eyebrow, title, sub }) {
  return (
    <div className="ob-col-head">
      {eyebrow ? <p className="ob-eyebrow">{eyebrow}</p> : null}
      <h1 className="ob-headline">{title}</h1>
      {sub ? <p className="ob-sub">{sub}</p> : null}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="ob-field">
      <span className="ob-label">{label}</span>
      {children}
    </label>
  );
}

/* Validation. Deliberately loose: these exist to catch a typo, not to argue
   with anyone about what a valid address looks like. */
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test((v || "").trim());
const isWebsite = (v) =>
  /^([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(
    (v || "").trim().replace(/^https?:\/\//i, "").replace(/\/$/, ""),
  );

/** Back control. Absent on screens where going back has no meaning. */
function Back({ onClick }) {
  return (
    <button type="button" className="ob-quiet-action" onClick={onClick}>
      Back
    </button>
  );
}

function useTimedSequence(lines, interval, active) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    setIndex(0);
    const id = setInterval(
      () => setIndex((i) => Math.min(i + 1, lines.length - 1)),
      interval,
    );
    return () => clearInterval(id);
  }, [active, interval, lines.length]);
  return lines[index];
}

/* ── 1. Account ────────────────────────────────────────────────────────── */

function AccountScreen({ data, set, next, phase }) {
  const [touchedEmail, setTouchedEmail] = useState(false);
  const filled =
    [data.name, data.email, data.password].filter(
      (v) => v && v.trim().length > 0,
    ).length / 3;

  /*
   * Kept to the margins on purpose. The first pass scattered these across the
   * whole viewport and they crawled over the headline and the fields, which
   * read as noise rather than as a colony gathering.
   */
  const ants = useMemo(
    () =>
      Array.from({ length: 10 }, (_, i) => {
        const left = i % 2 === 0;
        return {
          id: i,
          x: left ? 2 + ((i * 13) % 16) : 84 + ((i * 11) % 14),
          y: 6 + ((i * 41) % 88),
          drift: ((i % 5) - 2) * 26,
          rot: (i * 47) % 360,
        };
      }),
    [],
  );

  const strong = (data.password || "").length >= 10;
  const ready = Boolean(data.name) && isEmail(data.email) && strong;

  // Enter should move the flow on. Requiring the mouse on a four-field form is
  // friction for no reason.
  const onKeyDown = (e) => {
    if (e.key === "Enter" && ready) next();
  };

  return (
    <>
      <div className="ob-scatter" aria-hidden="true">
        {ants.map((a) => (
          <AntMark
            key={a.id}
            className="ob-scatter__ant"
            style={{
              left: `${a.x}%`,
              top: `${a.y}%`,
              opacity: 0.2 + filled * 0.35,
              transform: `translate3d(${a.drift * (1 - filled)}px, ${
                a.drift * 0.4 * (1 - filled)
              }px, 0) rotate(${a.rot * (1 - filled) + 0}deg) scale(${
                0.8 + filled * 0.25
              })`,
            }}
          />
        ))}
      </div>
      <Screen phase={phase}>
        <Head
          title="Welcome to the colony."
          sub="A few quick questions and your workspace is ready."
        />
        <div className="ob-panel" onKeyDown={onKeyDown}>
          <Field label="Your name">
            <Input
              value={data.name}
              placeholder="Aisha Bello"
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={data.email}
              placeholder="you@company.com"
              onChange={(e) => set({ email: e.target.value })}
              onBlur={() => setTouchedEmail(true)}
            />
            {touchedEmail && data.email && !isEmail(data.email) ? (
              <p className="ob-note ob-note--warn">
                That does not look like an email address.
              </p>
            ) : null}
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={data.password}
              placeholder="At least 10 characters"
              onChange={(e) => set({ password: e.target.value })}
            />
            <Progress
              value={Math.min(100, (data.password || "").length * 10)}
            />
            {/* Never leave someone staring at a dead button wondering why. */}
            <p className="ob-note">
              {strong
                ? "Strong enough."
                : `${10 - (data.password || "").length} more characters`}
            </p>
          </Field>
          <Field label="City">
            <Input
              value={data.city}
              onChange={(e) => set({ city: e.target.value })}
            />
            <p className="ob-note">Change it if we got it wrong.</p>
          </Field>
        </div>
        <div className="ob-actions">
          <Button size="lg" disabled={!ready} onClick={next}>
            Continue
          </Button>
        </div>
      </Screen>
    </>
  );
}

/* ── 2. Recovery code ──────────────────────────────────────────────────── */

function RecoveryScreen({ data, set, next, phase }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(data.recoveryCode);
    } catch {
      // Clipboard can be blocked. Selecting the text still works, so say so
      // rather than failing silently.
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2200);
  };

  const save = () => {
    const blob = new Blob(
      [`Colony recovery code\n\n${data.recoveryCode}\n\nKeep this somewhere safe.\n`],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "colony-recovery-code.txt";
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  return (
    <Screen phase={phase}>
      <Head
        title="Keep this code somewhere safe."
        sub="If you ever forget your password, this code is the only way back into your account. We cannot reset it for you."
      />
      <div className="ob-panel">
        <div
          className="ob-card"
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: "1.35rem",
            letterSpacing: "0.08em",
            textAlign: "center",
            fontWeight: 600,
          }}
        >
          {data.recoveryCode}
        </div>
        <div className="ob-row">
          <Button variant="outline" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="outline" onClick={save}>
            {saved ? "Saved" : "Save as file"}
          </Button>
        </div>
        <label
          className="ob-field"
          style={{ flexDirection: "row", alignItems: "center", gap: "0.6rem" }}
        >
          <Checkbox
            checked={data.savedCode}
            onCheckedChange={(v) => set({ savedCode: Boolean(v) })}
          />
          <span className="ob-label">I have saved my code</span>
        </label>
      </div>
      <div className="ob-actions">
        <Button size="lg" disabled={!data.savedCode} onClick={next}>
          Continue
        </Button>
      </div>
    </Screen>
  );
}

/* ── 3. Company ────────────────────────────────────────────────────────── */

function CompanyScreen({ data, set, next, back, phase }) {
  const ready = Boolean((data.company || "").trim());
  return (
    <Screen phase={phase}>
      <Head
        title="Now, your company."
        sub="This becomes your workspace. You can change the name later."
      />
      <div className="ob-panel">
        <Field label="Company name">
          <Input
            value={data.company}
            placeholder="Rosebank Auto Care"
            onChange={(e) => set({ company: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && ready) next();
            }}
          />
        </Field>
      </div>
      <div className="ob-actions">
        <Button size="lg" disabled={!ready} onClick={next}>
          Create workspace
        </Button>
        <Back onClick={back} />
      </div>
    </Screen>
  );
}

/* ── 4. Probing ────────────────────────────────────────────────────────────
 * The hero moment. Ants run out, search, and come back. The copy says exactly
 * what is happening: this step reads the person's computer, so pretending it
 * is doing something else would be a lie the product would have to keep.
 */

const PROBE_LINES = [
  "Building your workspace",
  "Checking what is already on your computer",
  "Getting your agents ready",
];

function ProbingScreen({ reduced, onDone, phase }) {
  const line = useTimedSequence(PROBE_LINES, 1150, true);

  useEffect(() => {
    const id = setTimeout(onDone, reduced ? 900 : 3600);
    return () => clearTimeout(id);
  }, [onDone, reduced]);

  const ants = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const angle = (i / 7) * Math.PI * 2 + 0.4;
        return {
          id: i,
          dx: Math.cos(angle) * 150,
          dy: Math.sin(angle) * 78,
          delay: i * 0.17,
          rot: (angle * 180) / Math.PI,
        };
      }),
    [],
  );

  return (
    <Screen solo phase={phase}>
      <Head title="Getting things ready." />
      <div className="ob-search" aria-hidden="true">
        {ants.map((a) => (
          <WalkingAnt
            key={a.id}
            className="ob-search__ant"
            style={{
              "--dx": `${a.dx}px`,
              "--dy": `${a.dy}px`,
              animationDelay: `${a.delay}s`,
              rotate: `${a.rot}deg`,
            }}
          />
        ))}
      </div>
      <div className="ob-status">
        <span className="ob-status__line" key={line}>
          {line}
        </span>
      </div>
    </Screen>
  );
}

/* ── 5a. Found ─────────────────────────────────────────────────────────── */

const FOUND = [
  { id: "claude", name: "Claude Code", meta: "Ready" },
  { id: "codex", name: "Codex", meta: "Ready" },
  { id: "opencode", name: "OpenCode", meta: "Ready" },
];

function BrainsScreen({ data, set, next, phase }) {
  return (
    <Screen phase={phase}>
      <Head
        title="You are already set up."
        sub="We found these on your computer. Pick the one your agents should think with. You can change it any time."
      />
      <div className="ob-options">
        {FOUND.map((f) => (
          <button
            type="button"
            key={f.id}
            className="ob-option"
            data-selected={data.brain === f.id}
            onClick={() => set({ brain: f.id })}
          >
            <span className="ob-pulse" />
            <span>
              <span className="ob-option__title">{f.name}</span>
              <span className="ob-option__meta">{f.meta}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="ob-actions">
        <Button size="lg" onClick={next}>
          Continue
        </Button>
      </div>
    </Screen>
  );
}

/* ── 5b. Colony agent install ──────────────────────────────────────────── */

const INSTALL_LINES = [
  "Setting up your agent",
  "Teaching it about your company",
  "Almost there",
];

function InstallScreen({ reduced, failing, onDone, phase }) {
  const [failed, setFailed] = useState(false);
  const line = useTimedSequence(INSTALL_LINES, 1100, !failed);

  useEffect(() => {
    if (failed) return undefined;
    const id = setTimeout(
      () => (failing ? setFailed(true) : onDone()),
      reduced ? 900 : 3400,
    );
    return () => clearTimeout(id);
  }, [failed, failing, onDone, reduced]);

  if (failed) {
    return (
      <Screen phase={phase}>
        <Head
          title="That did not work."
          sub="We could not finish setting up your agent. Check your internet connection and try again."
        />
        <div className="ob-actions">
          <Button size="lg" onClick={() => setFailed(false)}>
            Try again
          </Button>
          <button type="button" className="ob-quiet-action" onClick={onDone}>
            Continue without it for now
          </button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen solo phase={phase}>
      <Head
        title="Setting up your agent."
        sub="Colony is putting an agent to work for you. Nothing for you to do."
      />
      <div style={{ marginTop: "2.5rem", width: "13rem" }}>
        <WalkingAnt style={{ width: "84px", margin: "0 auto 1.5rem" }} />
        <Progress value={null} />
      </div>
      <div className="ob-status" style={{ marginTop: "1.25rem" }}>
        <span className="ob-status__line" key={line}>
          {line}
        </span>
      </div>
    </Screen>
  );
}

/* ── 6. Business ───────────────────────────────────────────────────────── */

function BusinessScreen({ data, set, next, back, phase }) {
  const [touchedSite, setTouchedSite] = useState(false);
  const siteOk = isWebsite(data.website);
  const ready = Boolean(
    data.stage && (data.hasSite === false || (data.hasSite && siteOk)),
  );
  return (
    <Screen phase={phase}>
      <Head title="Tell us about the work." />
      {/* Both question groups share one grid slot, otherwise they land in the
          same cell and overlap. */}
      <div className="ob-stack">
      <div className="ob-options">
        <p className="ob-label">Is your company up and running?</p>
        {[
          { id: "live", label: "Yes, we are open and making money" },
          { id: "building", label: "Not yet, we are still building" },
        ].map((o) => (
          <button
            type="button"
            key={o.id}
            className="ob-option"
            data-selected={data.stage === o.id}
            onClick={() => set({ stage: o.id })}
          >
            <span className="ob-option__title">{o.label}</span>
          </button>
        ))}
      </div>
      <div className="ob-options" style={{ marginTop: "1.5rem" }}>
        <p className="ob-label">Do you have a website?</p>
        <div className="ob-row">
          <button
            type="button"
            className="ob-option"
            data-selected={data.hasSite === true}
            onClick={() => set({ hasSite: true })}
          >
            <span className="ob-option__title">Yes</span>
          </button>
          <button
            type="button"
            className="ob-option"
            data-selected={data.hasSite === false}
            onClick={() => set({ hasSite: false, website: "" })}
          >
            <span className="ob-option__title">No</span>
          </button>
        </div>
        {data.hasSite ? (
          <div className="ob-field">
            <Input
              value={data.website}
              placeholder="rosebankautocare.co.za"
              onChange={(e) => set({ website: e.target.value })}
              onBlur={() => setTouchedSite(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && ready) next();
              }}
            />
            {touchedSite && data.website && !siteOk ? (
              <p className="ob-note ob-note--warn">
                That does not look like a web address. It should look like
                rosebankautocare.co.za
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      </div>
      <div className="ob-actions">
        <Button size="lg" disabled={!ready} onClick={next}>
          Continue
        </Button>
        <Back onClick={back} />
      </div>
    </Screen>
  );
}

/* ── 7. Reading the site ───────────────────────────────────────────────── */

const PAGES = ["Home", "Services", "About", "Contact"];

function ReadingScreen({ reduced, failing, onDone, phase }) {
  const [read, setRead] = useState(0);

  useEffect(() => {
    if (reduced) {
      const id = setTimeout(() => onDone(failing ? "failed" : "ok"), 900);
      return () => clearTimeout(id);
    }
    if (read >= PAGES.length) {
      const id = setTimeout(() => onDone(failing ? "failed" : "ok"), 700);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => setRead((r) => r + 1), 800);
    return () => clearTimeout(id);
  }, [read, reduced, failing, onDone]);

  const trail = `M20 12 L120 12 L220 12 L320 12 L420 12`;

  return (
    <Screen wide solo phase={phase}>
      <Head
        title="Reading your website."
        sub="Give us a moment. We are working out what your business does."
      />
      <div className="ob-window">
        <div className="ob-window__bar">
          <span className="ob-window__dot" style={{ background: "#ff5f57" }} />
          <span className="ob-window__dot" style={{ background: "#febc2e" }} />
          <span className="ob-window__dot" style={{ background: "#28c840" }} />
        </div>
        <div style={{ position: "relative" }}>
          <svg
            viewBox="0 0 440 24"
            preserveAspectRatio="none"
            aria-hidden="true"
            style={{
              position: "absolute",
              inset: "0 0 auto 0",
              height: 24,
              width: "100%",
            }}
          >
            <path
              d={trail}
              stroke={HUE.green}
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="3 9"
              fill="none"
              className="ob-trail__path"
              opacity="0.8"
            />
          </svg>
          <div className="ob-pages">
            {PAGES.map((p, i) => (
              <div key={p} className="ob-page" data-read={i < read}>
                <div className="ob-page__name">{p}</div>
                <div className="ob-skel" style={{ width: "80%" }} />
                <div className="ob-skel" style={{ width: "95%" }} />
                <div className="ob-skel" style={{ width: "60%" }} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Screen>
  );
}

/* ── 8. Description ────────────────────────────────────────────────────── */

const GENERATED =
  "Rosebank Auto Care is an independent vehicle workshop in Johannesburg. " +
  "You handle servicing, diagnostics and repairs for private owners and small " +
  "fleets, with a 48 hour turnaround on most jobs and Saturday bookings.";

function DescriptionScreen({ data, set, next, back, reduced, phase }) {
  // Two separate reasons the generated text is absent: the scrape failed, or
  // there was never a website to read. Both must stop the app claiming it
  // found something, which it did while only the first was handled.
  const noSite = data.hasSite === false;
  const failed = data.scrapeFailed || noSite;
  const [typed, setTyped] = useState(failed || reduced ? GENERATED.length : 0);
  const done = failed || typed >= GENERATED.length;
  const length = (data.description || "").trim().length;

  useEffect(() => {
    if (failed || reduced || typed >= GENERATED.length) return undefined;
    const id = setTimeout(() => setTyped((t) => t + 2), 12);
    return () => clearTimeout(id);
  }, [typed, failed, reduced]);

  useEffect(() => {
    if (done && !failed && !data.description) set({ description: GENERATED });
  }, [done, failed, data.description, set]);

  return (
    <Screen phase={phase}>
      <Head
        title={failed ? "Tell us what you do." : "Here is what we found."}
        sub={
          noSite
            ? "A line or two is enough. Your agents work from this."
            : failed
              ? "We could not reach that website. Write a line or two about your business instead."
              : "Change anything we got wrong. Your agents work from this."
        }
      />
      <div className="ob-panel">
        {done ? (
          <div className="ob-field">
            <Textarea
              rows={5}
              value={data.description}
              placeholder="We repair and service cars in Johannesburg."
              onChange={(e) => set({ description: e.target.value })}
            />
            {/* Same trap as the password field: a minimum nobody can see. */}
            <p className="ob-note">
              {length >= 20
                ? `${length} characters`
                : `${20 - length} more characters`}
            </p>
          </div>
        ) : (
          <div className="ob-card">
            <span className="ob-caret">{GENERATED.slice(0, typed)}</span>
          </div>
        )}
      </div>
      <div className="ob-actions">
        <Button size="lg" disabled={!done || length < 20} onClick={next}>
          Looks right
        </Button>
        <Back onClick={back} />
      </div>
    </Screen>
  );
}

/* ── 9. Credits ───────────────────────────────────────────────────────────
 * Payment is handed to Paystack, so Colony never sees a card number and never
 * carries PCI scope. This screen only picks an amount and hands over.
 *
 * Everything is USD, end to end: agent spend is metered in USD, credits are
 * denominated in USD, and Paystack charges in USD. No conversion anywhere.
 */

const AMOUNTS = [5, 10, 25];
const MIN_USD = 5;

function CreditsScreen({ data, set, next, back, branch, declining, phase }) {
  const [state, setState] = useState("idle");
  const [custom, setCustom] = useState(false);
  const [customValue, setCustomValue] = useState("");

  const amount = custom ? Number(customValue || 0) : data.amount;
  const amountValid = amount >= MIN_USD;

  const pay = () => {
    setState("leaving");
    // Stands in for the Paystack checkout and the return trip back.
    setTimeout(() => {
      if (declining) setState("abandoned");
      else next();
    }, 1800);
  };

  return (
    <Screen phase={phase}>
      <Head
        title="Put your colony to work."
        sub={
          branch === "colony"
            ? "Credits are what your agents run on: finding customers, reaching out, research, and work that carries on while you sleep. Your agent runs on Colony, so credits keep it working."
            : "Credits pay for the work your agents do out in the world: finding customers, reaching out, and research."
        }
      />
      <div className="ob-amounts">
        {AMOUNTS.map((a) => (
          <button
            type="button"
            key={a}
            className="ob-amount"
            data-selected={!custom && data.amount === a}
            onClick={() => {
              setCustom(false);
              set({ amount: a });
            }}
          >
            ${a}
          </button>
        ))}
        {custom ? (
          <span className="ob-amount ob-amount--custom" data-selected="true">
            <span className="ob-amount__currency">$</span>
            <input
              autoFocus
              inputMode="numeric"
              value={customValue}
              placeholder="50"
              aria-label="Custom amount in dollars"
              style={{ width: `${Math.max(2, customValue.length || 2)}ch` }}
              onChange={(e) =>
                setCustomValue(e.target.value.replace(/\D/g, "").slice(0, 5))
              }
            />
          </span>
        ) : (
          <button
            type="button"
            className="ob-amount"
            onClick={() => setCustom(true)}
          >
            Other
          </button>
        )}
      </div>

      <div className="ob-panel">
        <div className="ob-handoff">
          <p className="ob-handoff__title">
            You will pay with Paystack, then come straight back here.
          </p>
          <p className="ob-handoff__methods">
            Card or instant EFT. Colony never sees your card details.
          </p>
        </div>
        {state === "abandoned" ? (
          <p className="ob-note ob-note--warn">
            That payment was not completed. Nothing has been charged.
          </p>
        ) : (
          <p className="ob-note">
            {custom && customValue && !amountValid
              ? `The minimum is $${MIN_USD}.`
              : `$${MIN_USD} minimum. Reading your website cost 4 cents, and that comes off this first payment.`}
          </p>
        )}
      </div>

      <div className="ob-actions">
        <Button
          size="lg"
          onClick={pay}
          disabled={state === "leaving" || !amountValid}
        >
          {state === "leaving"
            ? "Taking you to Paystack"
            : state === "abandoned"
              ? "Try again"
              : `Pay $${amountValid ? amount : MIN_USD}`}
        </Button>
        {branch === "byo" ? (
          <button type="button" className="ob-quiet-action" onClick={next}>
            I will use my own agent for now
          </button>
        ) : null}
        <Back onClick={back} />
      </div>
    </Screen>
  );
}


function InviteScreen({ data, set, next, back, phase }) {
  const [draft, setDraft] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [problem, setProblem] = useState("");

  const add = () => {
    const raw = draft.trim();
    if (!raw) return;
    // Pasting a list is the normal way people do this. Split on commas,
    // semicolons and spaces before judging any of it.
    const parts = raw.split(/[\s,;]+/).filter(Boolean);
    if (parts.length > 1) {
      const seen = new Set(data.invites.map((e) => e.toLowerCase()));
      const good = [];
      const bad = [];
      for (const part of parts) {
        if (!isEmail(part)) bad.push(part);
        else if (seen.has(part.toLowerCase())) continue;
        else {
          seen.add(part.toLowerCase());
          good.push(part);
        }
      }
      if (good.length) set({ invites: [...data.invites, ...good] });
      setDraft(bad.join(" "));
      setProblem(bad.length ? `Could not read: ${bad.join(", ")}` : "");
      return;
    }
    const value = parts[0];
    if (!isEmail(value)) {
      // Previously this rejected silently and left the text sitting there,
      // which reads as the app being broken.
      setProblem("That does not look like an email address.");
      return;
    }
    if (data.invites.some((e) => e.toLowerCase() === value.toLowerCase())) {
      setProblem("You already added that one.");
      setDraft("");
      return;
    }
    setProblem("");
    set({ invites: [...data.invites, value] });
    setDraft("");
  };

  const send = () => {
    setLeaving(true);
    setTimeout(next, 760);
  };

  return (
    <Screen phase={phase}>
      <Head
        title="Who else is coming?"
        sub="They get an email with a link that brings them straight into your workspace."
      />
      <div className="ob-panel">
        {data.invites.length ? (
          <div className="ob-pills">
            {data.invites.map((e) => (
              <span key={e} className="ob-pill" data-leaving={leaving}>
                {e}
                <button
                  type="button"
                  className="ob-pill__x"
                  onClick={() =>
                    set({ invites: data.invites.filter((x) => x !== e) })
                  }
                  aria-label={`Remove ${e}`}
                >
                  x
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <Input
          value={draft}
          placeholder="name@company.com"
          onChange={(e) => {
            setDraft(e.target.value);
            if (problem) setProblem("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
        <p className={`ob-note${problem ? " ob-note--warn" : ""}`}>
          {problem || "Press enter after each address."}
        </p>
      </div>
      <div className="ob-actions">
        <Button size="lg" disabled={!data.invites.length} onClick={send}>
          Send invites
        </Button>
        <button type="button" className="ob-quiet-action" onClick={next}>
          It is just me for now
        </button>
        <Back onClick={back} />
      </div>
    </Screen>
  );
}

/* ── Arrival ───────────────────────────────────────────────────────────────
 * The violet drains to the app surface. The colour change is the arrival, so
 * no congratulations screen is needed.
 */

function Arrival({ data, restart }) {
  return (
    <div className="ob-arrival">
      <div className="ob-arrival__inner" style={{ color: "hsl(234 16% 35%)" }}>
        <AntMark style={{ width: 44, margin: "0 auto 1.5rem" }} />
        <h1 className="ob-headline" style={{ color: "hsl(234 16% 35%)" }}>
          {data.company || "Your colony"} is live.
        </h1>
        <p className="ob-sub">Your workspace is ready.</p>
        <div className="ob-actions">
          <Button size="lg" onClick={restart}>
            Run it again
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Flow ──────────────────────────────────────────────────────────────── */

const ORDER = [
  "account",
  "recovery",
  "company",
  "probing",
  "brain",
  "business",
  "reading",
  "description",
  "credits",
  "invite",
];

function App() {
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState("in");
  const [arrived, setArrived] = useState(false);
  const [branch, setBranch] = useState("colony");
  const [failScrape, setFailScrape] = useState(false);
  const [failInstall, setFailInstall] = useState(false);
  const [declineCard, setDeclineCard] = useState(false);

  const [data, setData] = useState({
    name: "",
    email: "",
    password: "",
    city: "Johannesburg",
    recoveryCode: "TRAIL-9F2K-4QD8-MZ71",
    savedCode: false,
    company: "",
    brain: "claude",
    stage: null,
    hasSite: null,
    website: "",
    description: "",
    scrapeFailed: false,
    amount: 5,
    invites: [],
  });

  const set = useCallback(
    (patch) => setData((d) => ({ ...d, ...patch })),
    [],
  );

  const reduced = useMemo(
    () =>
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const go = useCallback((delta) => {
    setPhase("out");
    setTimeout(() => {
      setIndex((i) => {
        const nextIndex = i + delta;
        if (nextIndex >= ORDER.length) {
          setArrived(true);
          return i;
        }
        return Math.max(0, nextIndex);
      });
      setPhase("in");
    }, 200);
  }, []);

  const next = useCallback(() => go(1), [go]);

  /*
   * Back skips the screens that do work on entry. Landing back on "reading
   * your website" would re-run the scrape, and on the install screen it would
   * re-install. Both would spend something to show the user a screen they were
   * trying to leave.
   */
  const BACK_TARGET = { 2: 0, 5: 2, 7: 5, 8: 7, 9: 8 };
  const back = useCallback(() => {
    setPhase("out");
    setTimeout(() => {
      setIndex((i) => BACK_TARGET[i] ?? Math.max(0, i - 1));
      setPhase("in");
    }, 200);
  }, []);

  const screen = ORDER[index];

  // Screens 6 and 7 are skipped when there is no website to read.
  const onBusinessNext = useCallback(() => {
    if (data.hasSite) next();
    else {
      setPhase("out");
      setTimeout(() => {
        setIndex(ORDER.indexOf("description"));
        setPhase("in");
      }, 200);
    }
  }, [data.hasSite, next]);

  const canvasKey =
    screen === "brain"
      ? branch === "byo"
        ? "brains"
        : "install"
      : screen === "description"
        ? "description"
        : screen;
  const canvas = CANVAS[canvasKey] || CANVAS.account;

  const body = (() => {
    switch (screen) {
      case "account":
        return <AccountScreen {...{ data, set, next, phase }} />;
      case "recovery":
        return <RecoveryScreen {...{ data, set, next, phase }} />;
      case "company":
        return <CompanyScreen {...{ data, set, next, back, phase }} />;
      case "probing":
        return <ProbingScreen reduced={reduced} onDone={next} phase={phase} />;
      case "brain":
        return branch === "byo" ? (
          <BrainsScreen {...{ data, set, next, phase }} />
        ) : (
          <InstallScreen
            reduced={reduced}
            failing={failInstall}
            onDone={next}
            phase={phase}
          />
        );
      case "business":
        return (
          <BusinessScreen
            data={data}
            set={set}
            next={onBusinessNext}
            back={back}
            phase={phase}
          />
        );
      case "reading":
        return (
          <ReadingScreen
            reduced={reduced}
            failing={failScrape}
            phase={phase}
            onDone={(result) => {
              set({ scrapeFailed: result === "failed" });
              next();
            }}
          />
        );
      case "description":
        return (
          <DescriptionScreen {...{ data, set, next, back, reduced, phase }} />
        );
      case "credits":
        return (
          <CreditsScreen
            {...{ data, set, next, back, branch, phase }}
            declining={declineCard}
          />
        );
      case "invite":
        return <InviteScreen {...{ data, set, next, back, phase }} />;
      default:
        return null;
    }
  })();

  return (
    <ColonyProvider>
      <div
        className={`ob-canvas ${canvas.ink === "light" ? "dark" : ""}`}
        data-ink={canvas.ink}
        style={{ background: canvas.base }}
      >
        <div
          className="ob-mesh"
          style={{
            background: canvas.mesh
              .map(
                ([c, x, y, r]) =>
                  `radial-gradient(circle at ${x} ${y}, ${c} 0%, transparent ${r})`,
              )
              .join(","),
          }}
        />
        <div className="ob-streak" />
        <div
          className="ob-grain"
          style={{ backgroundImage: `url("${GRAIN}")` }}
        />
        <div className="ob-step">
          {String(index + 1).padStart(2, "0")} / {ORDER.length}
        </div>
        <div className="ob-stage">
          {body}
          <Foot step={index} total={ORDER.length} />
        </div>
      </div>

      {arrived ? (
        <Arrival
          data={data}
          restart={() => {
            setArrived(false);
            setIndex(0);
          }}
        />
      ) : null}

      <details className="ob-dev">
        <summary>Prototype controls</summary>
        <label>
          <input
            type="radio"
            checked={branch === "colony"}
            onChange={() => setBranch("colony")}
          />
          No agent found (non-technical)
        </label>
        <label>
          <input
            type="radio"
            checked={branch === "byo"}
            onChange={() => setBranch("byo")}
          />
          Agent found (technical)
        </label>
        <label>
          <input
            type="checkbox"
            checked={failScrape}
            onChange={(e) => setFailScrape(e.target.checked)}
          />
          Website unreachable
        </label>
        <label>
          <input
            type="checkbox"
            checked={failInstall}
            onChange={(e) => setFailInstall(e.target.checked)}
          />
          Agent setup fails
        </label>
        <label>
          <input
            type="checkbox"
            checked={declineCard}
            onChange={(e) => setDeclineCard(e.target.checked)}
          />
          Payment not completed
        </label>
        <select
          value={index}
          onChange={(e) => {
            setArrived(false);
            setIndex(Number(e.target.value));
          }}
        >
          {ORDER.map((s, i) => (
            <option key={s} value={i}>
              {i + 1}. {s}
            </option>
          ))}
        </select>
      </details>
    </ColonyProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
