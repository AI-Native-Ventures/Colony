/** A prompt suggestion only; selecting it does not grant access or start work. */
export type FirstJobStarter = {
  readonly id: "instagram-drafts" | "potential-clients";
  readonly label: string;
  readonly brief: string;
  readonly outputs: readonly string[];
};

/** Reusable first-job prompts using the business context already in the thread. */
export function firstJobStarters(
  businessName: string,
): readonly [FirstJobStarter, FirstJobStarter] {
  // Quote the name as plain prompt data, including embedded quotes/newlines.
  // The UI renders these strings as text, never as HTML or executable actions.
  const business = JSON.stringify(businessName.trim() || "your business");
  return [
    {
      id: "instagram-drafts",
      label: "Draft Instagram captions",
      brief: `Draft five Instagram captions and five matching visual briefs for ${business}. Use the business context shared in this thread. Keep them ready for my review; do not create images or publish posts.`,
      outputs: [
        "5 Instagram caption drafts",
        "5 matching visual briefs",
        "Ready for your review",
      ],
    },
    {
      id: "potential-clients",
      label: "Find potential clients",
      brief: `Find ten potential clients for ${business}, using the business context shared in this thread. For each, include why they may be a good fit and available business contact options. Keep the list ready for my review; do not contact anyone.`,
      outputs: [
        "10 potential clients",
        "Fit notes and available business contact options",
        "Ready for your review",
      ],
    },
  ];
}

/** Custom or edited briefs must not inherit a starter's promised outputs. */
export function firstJobStarterForBrief(
  businessName: string,
  brief: string,
): FirstJobStarter | undefined {
  return firstJobStarters(businessName).find(
    (starter) => starter.brief === brief,
  );
}
