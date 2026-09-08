const questions = [
  [
    "What is Colony?",
    "Colony is an app for giving your team jobs, following progress and reviewing results. Your team can include people and AI teammates. Open a job to read its conversation, check the work and say what needs changing.",
  ],
  [
    "What is an AI teammate?",
    "An AI teammate is software you give instructions to in a conversation. It uses tools to research information, write and do other tasks. What it can do depends on its job and the tools connected to it. You give it the information it needs and check its work.",
  ],
  [
    "How do I get started?",
    "The planned early-access setup will guide you through describing your business and choosing a teammate with the tools needed for your first job. Then tell it what you need, add the relevant details or files, and check what it produces.",
  ],
  [
    "How will I know what needs my attention?",
    "The planned daily view brings together jobs in progress, finished work and questions waiting for your answer. Open a job to check the result, answer a question or ask for changes.",
  ],
  [
    "Do I need a business or a team already?",
    "No. You can apply if you are exploring an idea, starting a business or already running one. You can work on your own or with other people. Tell us about your business and the first job you would like help with.",
  ],
  [
    "Can I use Colony today?",
    "Colony is being built and tested, and early access is limited. The guided setup and daily view described here are planned for early access. Applying does not give you access straight away. Available jobs, tools and costs will be explained before you join.",
  ],
];

export function FAQ() {
  return (
    <section className="faq-section" aria-labelledby="faq-title">
      <div className="wrap faq-grid">
        <div>
          <p className="eyebrow">A few useful answers</p>
          <h2 id="faq-title">
            New to Colony?
            <br />
            Start here.
          </h2>
        </div>
        <div className="faq-list">
          {questions.map(([question, answer]) => (
            <details key={question}>
              <summary>
                {question}
                <span aria-hidden="true">+</span>
              </summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
