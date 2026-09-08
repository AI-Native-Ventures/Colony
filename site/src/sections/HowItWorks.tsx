const steps = [
  [
    "Tell it what you need.",
    "Describe your client’s business and the work you want done. Add their pictures, prices or other details the assistant needs.",
  ],
  [
    "Look at the work.",
    "Open the website, pictures or writing the assistant has prepared. See what your client will receive.",
  ],
  [
    "Ask for changes.",
    "Say what to change, like ‘Use a different picture’ or ‘Make the writing shorter.’ Check the result before you use it.",
  ],
];

export function HowItWorks() {
  return (
    <section
      className="how-section"
      id="how-it-works"
      aria-labelledby="how-title"
    >
      <div className="wrap">
        <p className="eyebrow">How you work together</p>
        <h2 id="how-title">
          You explain. The AI creates.
          <br />
          <span>You check.</span>
        </h2>
        <div className="steps-grid">
          {steps.map(([title, description], index) => (
            <div className="step" key={title}>
              <span className="step-number">{index + 1}</span>
              <h3>{title}</h3>
              <p>{description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
