import type {
  CampaignDetail,
  ConversationThread,
  Lead,
  OutreachDraft,
} from "../types";

/**
 * Outreach drafts and conversation threads seeded onto a fixture Campaign.
 *
 * Lifted out of `FixtureDiscoveryDataSource` to keep that file under the
 * desktop file-size ratchet; the seeds themselves are unchanged.
 */
export function seedOutreach(
  campaign: CampaignDetail,
  leads: readonly Lead[],
): OutreachDraft[] {
  return leads.slice(0, 5).map((lead, index) => {
    const channel =
      index % 3 === 0 ? "Email" : index % 3 === 1 ? "LinkedIn" : "WhatsApp";
    const person =
      lead.personName ?? lead.contactName ?? `Team at ${lead.companyName}`;
    const company = lead.currentCompany ?? lead.companyName;
    return {
      id: `${campaign.id}-${lead.id}`,
      campaignId: campaign.id,
      leadId: lead.id,
      lead: person,
      company,
      channel,
      subject: `A quick idea for ${company}`,
      body: `Hi ${person.split(" ")[0]}, I noticed ${company} while researching ${campaign.verticalName.toLowerCase()} teams in ${campaign.location}. I have a specific idea that could help—would a short conversation this week be useful?`,
      status: index === 0 ? "Approved" : index === 1 ? "Scheduled" : "Draft",
    };
  });
}

export function seedConversations(
  campaign: CampaignDetail,
  leads: readonly Lead[],
): ConversationThread[] {
  return leads.slice(0, 4).map((lead, index) => ({
    id: `${campaign.id}-conversation-${lead.id}`,
    campaignId: campaign.id,
    leadId: lead.id,
    name: lead.personName ?? lead.contactName ?? lead.companyName,
    company: lead.currentCompany ?? lead.companyName,
    channel: index % 2 === 0 ? "Email" : "WhatsApp",
    unread: index < 2,
    messages: [
      {
        id: `${campaign.id}-${lead.id}-message-1`,
        direction: "inbound",
        body:
          index === 0
            ? "Hi — thanks for reaching out. The idea sounds relevant."
            : "Thanks for the note.",
        sentAt: "2026-08-01T09:20:00.000Z",
      },
      {
        id: `${campaign.id}-${lead.id}-message-2`,
        direction: "inbound",
        body:
          index === 0
            ? "Can you send over two examples before we book time?"
            : "What would the first week look like?",
        sentAt: "2026-08-01T09:25:00.000Z",
      },
    ],
  }));
}
