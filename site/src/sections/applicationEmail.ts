/** The address authorised to receive Colony early-access applications. */
export const APPLICATION_RECIPIENT = "basheer@ainative.ventures";

const APPLICATION_SUBJECT = "Colony early access application";

/** The answers collected before a visitor opens their own email app. */
export interface EarlyAccessApplication {
  name: string;
  email: string;
  stage: "starting" | "existing";
  service: "websites" | "social" | "both";
  note: string;
}

const stages: Record<EarlyAccessApplication["stage"], string> = {
  starting: "I'm starting an agency",
  existing: "I already run an agency",
};

const services: Record<EarlyAccessApplication["service"], string> = {
  websites: "Websites",
  social: "Social media",
  both: "Websites and social media",
};

/** Prepare an email without sending it or placing visitor data in headers. */
export function buildApplicationEmail(application: EarlyAccessApplication) {
  const note = application.note.trim();
  const body = [
    "I'd like to apply for early access to Colony.",
    "",
    `Name: ${application.name.trim()}`,
    `Email: ${application.email.trim()}`,
    `My agency: ${stages[application.stage]}`,
    `I'm interested in: ${services[application.service]}`,
    ...(note ? ["", "What I'd like help with:", note] : []),
  ].join("\r\n");

  return {
    recipient: APPLICATION_RECIPIENT,
    subject: APPLICATION_SUBJECT,
    body,
    mailto: `mailto:${APPLICATION_RECIPIENT}?subject=${encodeURIComponent(APPLICATION_SUBJECT)}&body=${encodeURIComponent(body)}`,
    clipboardText: `To: ${APPLICATION_RECIPIENT}\nSubject: ${APPLICATION_SUBJECT}\n\n${body}`,
  };
}
