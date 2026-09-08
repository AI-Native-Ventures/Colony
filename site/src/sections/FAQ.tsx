const questions = [
  [
    "What is Colony?",
    "Colony is an app for working with your team and AI assistants. You can talk about the work, share files, keep track of tasks and give assistants jobs to do. You check their work and tell them what needs changing.",
  ],
  [
    "What is an AI assistant?",
    "It is software you can give instructions to in a conversation. It uses tools to do work, such as researching information, writing or making a website. What it can do depends on the tools it has. You give it the information it needs and check the result.",
  ],
  [
    "Is Colony only for websites and social media?",
    "No. Colony is a general place to work, designed for different kinds of business. Websites and social media are the first examples we’re building and testing. You can set up assistants for other jobs, and we’ll add more examples over time.",
  ],
  [
    "Do I need a business or a team already?",
    "No. You can start with an idea and work on your own, or bring an existing business and invite your team. Tell us what you want to do when you apply.",
  ],
  [
    "Can I use Colony today?",
    "Colony is not open to everyone yet. We’re building and testing it. Apply for early access and tell us about your business. Before you join, we’ll explain which features are available and what they cost.",
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
