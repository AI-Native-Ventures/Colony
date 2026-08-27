import { getCanvas, setCanvas } from "@/shared/api/tauri";
import {
  STARTER_PERSONA_IDS,
  starterPersonaName,
} from "@/shared/constants/starterPersonas";

const GUIDE_NAME = starterPersonaName(STARTER_PERSONA_IDS.fizz);

export const WELCOME_CANVAS_CONTENT = `# Welcome to Colony

This private channel is your home base. ${GUIDE_NAME}, your Chief of Staff, will learn how
the business works and propose the smallest useful team to run it.

## Address your team

- \`@${GUIDE_NAME.toLowerCase()}\` reaches an employee by name.
- \`@chief-of-staff\` reaches whoever currently holds that role.
- \`@marketing\` reaches every member of a team at once.

Roles and names are separate, so renaming someone never breaks earlier messages.

## Decisions live in the conversation

Briefs, questions, and approvals arrive as blocks in this channel. They stay put,
stay referenceable, and keep their state if you close the app mid-review.

## Nothing happens without your approval

Colony will not create the company or hire the rest of the roster until you
approve the blueprint. Until then your Chief of Staff is the only one here:
nobody else is set up, switched on, or billed to you.

Ask the team a question here, or read the [Colony user guide](https://github.com/AI-Native-Ventures/colony-releases#readme).
`;

type WelcomeCanvasClient = {
  getCanvas: typeof getCanvas;
  setCanvas: typeof setCanvas;
};

/** Seed the Welcome canvas without overwriting anything the user has written. */
export async function ensureWelcomeCanvas(
  channelId: string,
  client: WelcomeCanvasClient = { getCanvas, setCanvas },
) {
  const existing = await client.getCanvas(channelId);
  // Nullish (not `!== null`) so an absent field can never masquerade as an
  // existing canvas — that exact mismatch silently skipped seeding before.
  if (existing.updatedAt != null || existing.author != null) {
    return false;
  }

  await client.setCanvas({ channelId, content: WELCOME_CANVAS_CONTENT });
  return true;
}
