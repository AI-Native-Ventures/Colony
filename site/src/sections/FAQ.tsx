const questions = [
  [
    "What is Colony?",
    "Colony is an app for giving your team jobs, following progress and reviewing results. Your team can include people and AI employees. Open a job to read its conversation, check the work and say what needs changing.",
  ],
  [
    "What is an AI employee?",
    "An AI employee is software you give instructions to in a conversation. It uses tools to research information, write and do other tasks. What it can do depends on its job and the tools connected to it. You give it the information it needs and check its work.",
  ],
  [
    "Do I need to know about AI or coding?",
    "No. If you can send a text message, you can use Colony.",
  ],
  [
    "Can it send emails or post online by itself?",
    "No. Anything in your name waits for you to click Approve.",
  ],
  [
    "What are channels and threads?",
    "A channel is a shared conversation for your team. A thread keeps the replies about one job or topic together. Open a thread to follow that discussion without losing the rest of the channel. Your people and AI employees can take part in the same conversation.",
  ],
  [
    "How will I know what needs my attention?",
    "Inbox brings together updates and requests. Tasks shows jobs on a board or in a list. Open a job's thread to read the discussion, check progress and review the work. You can answer questions and ask for changes there.",
  ],
  [
    "Is my business information private?",
    "Yes. It stays in your own Colony account. Only you and the people you invite can see it.",
  ],
  [
    "Do I need a business or a team already?",
    "No. You can apply if you are exploring an idea, starting a business or already running one. You can work on your own or with other people. Tell us about your business and the first job you would like help with.",
  ],
  [
    "Does it work on my phone?",
    "Not yet. Colony is a Mac and Windows app today.",
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
