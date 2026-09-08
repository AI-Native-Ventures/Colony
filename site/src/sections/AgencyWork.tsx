const jobs = [
  {
    number: "01",
    title: "Find potential clients.",
    description:
      "Choose the kind of business you want to work with, such as bakeries or guest houses. Find businesses to research and contact about your services.",
    example: "“Find bakeries I could offer a website to.”",
    label: "Client discovery",
  },
  {
    number: "02",
    title: "Build and look after websites.",
    description:
      "Ask an AI assistant to create a client’s website or update its pages, pictures and prices. Check the changes before they go live.",
    example: "“Add the new menu to my client’s website.”",
    label: "Website Manager",
  },
  {
    number: "03",
    title: "Create social media posts.",
    description:
      "Ask an AI assistant to design pictures and write posts for each client. Tell it what to promote and what needs changing.",
    example: "“Prepare next week’s posts for my client’s bakery.”",
    label: "Social Media Manager",
  },
];

export function AgencyWork() {
  return (
    <section
      className="work-section"
      id="what-you-can-do"
      aria-labelledby="work-title"
    >
      <div className="wrap">
        <div className="section-intro">
          <p className="eyebrow">What we’re building</p>
          <h2 id="work-title">
            Find businesses to work with.
            <br />
            Make the work they need.
          </h2>
          <p>
            AI assistants with specific jobs, ready for you to give them
            instructions.
          </p>
        </div>
        <div className="jobs-grid">
          {jobs.map((job) => (
            <article className="job" key={job.number}>
              <span className="job-number">{job.number}</span>
              <h3>{job.title}</h3>
              <p>{job.description}</p>
              <blockquote>{job.example}</blockquote>
              <span className="job-label">{job.label}</span>
            </article>
          ))}
        </div>
        <p className="scope-note">
          We’re building and testing these tools. Early access will start with a
          limited set of features. We’ll explain what you can use before you
          join.
        </p>
      </div>
    </section>
  );
}
