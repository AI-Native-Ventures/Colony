/** The address authorised to receive Colony early-access applications. */
export const APPLICATION_RECIPIENT = "basheer@ainative.ventures";

const APPLICATION_SUBJECT = "Colony early access application";

/** The answers collected before a visitor opens their own email app. */
export interface EarlyAccessApplication {
  name: string;
  email: string;
  stage: "starting" | "existing" | "exploring";
  work: string;
}

const stages: Record<EarlyAccessApplication["stage"], string> = {
  starting: "I'm starting a business",
  existing: "I already run a business",
  exploring: "I'm exploring an idea",
};

/** Prepare an email without sending it or placing visitor data in headers. */
export function buildApplicationEmail(application: EarlyAccessApplication) {
  const body = [
    "I'd like to apply for early access to Colony.",
    "",
    `Name: ${application.name.trim()}`,
    `Email: ${application.email.trim()}`,
    `My business: ${stages[application.stage]}`,
    "",
    "What I'd like to do in Colony:",
    application.work.trim(),
  ].join("\r\n");

  return {
    recipient: APPLICATION_RECIPIENT,
    subject: APPLICATION_SUBJECT,
    body,
    mailto: `mailto:${APPLICATION_RECIPIENT}?subject=${encodeURIComponent(APPLICATION_SUBJECT)}&body=${encodeURIComponent(body)}`,
    clipboardText: `To: ${APPLICATION_RECIPIENT}\nSubject: ${APPLICATION_SUBJECT}\n\n${body}`,
  };
}
