import type { DiscoveryDataSource } from "./DiscoveryDataSource";

/**
 * A data source that reports its own writes.
 *
 * Discovery reads are cached per search, so a surface revisited after a write
 * would otherwise render the answer from before it. Every mutating method is
 * wrapped to call `onWrite` once it has settled, which is the signal to drop
 * the cached read models. The screen re-reads on its next render, exactly as
 * it did when every navigation refetched.
 *
 * Reads pass straight through. Discovery runs report when the run ends, not
 * when it starts: the leads they produce only exist once the events stop.
 */
export function withWriteInvalidation(
  source: DiscoveryDataSource,
  onWrite: () => void,
): DiscoveryDataSource {
  async function afterWrite<T>(work: Promise<T>): Promise<T> {
    try {
      return await work;
    } finally {
      onWrite();
    }
  }

  async function* afterRun(
    events: AsyncIterable<import("../types").DiscoveryEvent>,
  ): AsyncIterable<import("../types").DiscoveryEvent> {
    try {
      yield* events;
    } finally {
      onWrite();
    }
  }

  return {
    getEntitlement: () => source.getEntitlement(),
    getIndustries: () => source.getIndustries(),
    getVerticals: (industryId) => source.getVerticals(industryId),
    getVertical: (industryId, verticalId) =>
      source.getVertical(industryId, verticalId),
    getFields: () => source.getFields(),
    getRoles: (fieldId) => source.getRoles(fieldId),
    getRole: (fieldId, roleId) => source.getRole(fieldId, roleId),
    getCampaign: (campaignId) => source.getCampaign(campaignId),
    getLeads: (scope) => source.getLeads(scope),
    getPipelineColumns: () => source.getPipelineColumns(),
    getLeadCounts: () => source.getLeadCounts(),
    getLead: (leadId) => source.getLead(leadId),
    getOutreach: (campaignId) => source.getOutreach(campaignId),
    getConversations: (campaignId) => source.getConversations(campaignId),

    updateLead: (leadId, input) => afterWrite(source.updateLead(leadId, input)),
    createOutreach: (campaignId) =>
      afterWrite(source.createOutreach(campaignId)),
    updateOutreachStatus: (campaignId, outreachId, status) =>
      afterWrite(source.updateOutreachStatus(campaignId, outreachId, status)),
    markConversationRead: (campaignId, conversationId) =>
      afterWrite(source.markConversationRead(campaignId, conversationId)),
    sendConversationReply: (campaignId, conversationId, body) =>
      afterWrite(
        source.sendConversationReply(campaignId, conversationId, body),
      ),
    createCampaign: (input) => afterWrite(source.createCampaign(input)),
    updateSourceConfig: (campaignId, config) =>
      afterWrite(source.updateSourceConfig(campaignId, config)),
    cancelDiscovery: (campaignId) =>
      afterWrite(source.cancelDiscovery(campaignId)),
    startDiscovery: (campaignId) => afterRun(source.startDiscovery(campaignId)),
    retryDiscovery: (campaignId) => afterRun(source.retryDiscovery(campaignId)),
  };
}
