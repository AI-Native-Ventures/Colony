const questions = [
  [
    "Do I need to have an agency already?",
    "No. You can apply if you’re planning to start one or already work with clients. You don’t need a business name or website to apply.",
  ],
  [
    "What is an AI assistant?",
    "It is software you can give instructions to in a conversation. In Colony, assistants use tools to make websites, pictures and writing. They are not people. You still need to give them the right information and check their work.",
  ],
  [
    "Can I use Colony today?",
    "Colony is not open to everyone yet. We’re building and testing it. Apply for early access and tell us what you want help with. Before you join, we’ll explain which features are available and what they cost.",
  ],
  [
    "Will Colony find paying clients for me?",
    "Colony’s discovery tools help you find potential clients across different industries. Finding a business does not mean it will buy your services. You decide who to contact and what to offer.",
  ],
  [
    "Can I use it for another kind of business?",
    "Colony is designed so you can adapt its AI assistants for other kinds of work. We’re starting with website and social media agencies. We plan to add ready-to-use teams for more types of business.",
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
