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
    "When you get access, create your account, save the code that helps you recover access and describe your business. Colony opens a Welcome conversation with a suggested first job. Edit the brief, which is the set of instructions for the job, then choose Start this job. You can explore the app before starting any work.",
  ],
  [
    "What are channels and threads?",
    "A channel is a shared conversation for your team. A thread keeps the replies about one job or topic together. Open a thread to follow that discussion without losing the rest of the channel. Your people and AI teammates can take part in the same conversation.",
  ],
  [
    "How will I know what needs my attention?",
    "Inbox brings together updates and requests. Tasks shows jobs on a board or in a list. Open a job’s thread to read the discussion, check progress and review the work. You can answer questions and ask for changes there.",
  ],
  [
    "What do I need before an AI job can start?",
    "You need an available AI teammate with the right tools, the information for the job and credits to pay for AI work. Colony checks your team and credits when you choose Start this job. If something is missing, it tells you. Creating an account or adding credits does not start a job automatically.",
  ],
  [
    "Do I need a business or a team already?",
    "No. You can apply if you are exploring an idea, starting a business or already running one. You can work on your own or with other people. Tell us about your business and the first job you would like help with.",
  ],
  [
    "Can I use Colony today?",
    "Colony is being built and tested, and early access is limited. Apply to tell us about your business and what you need help with. Applying does not give you access straight away. We’ll explain the available teammates, tools and costs before you join.",
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
