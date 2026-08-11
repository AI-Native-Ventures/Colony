export type SessionContext = {
  runId: string;
  relayWsUrl: string;
  relayHttpUrl: string;
  identityPubkey: string;
  /** Fixture channel created by the script. */
  channelId: string;
  /** Event id of the script's probe message. */
  messageId: string;
  /** created_at (epoch seconds) of the script's probe message. */
  messageCreatedAt: number;
  workflowId: string;
  teamId: string;
  templateId: string;
  /** Id of the template created by the duplicate step (teardown target). */
  duplicateTemplateId: string;
  personaId: string;
  /** WebSocket id of the script's own relay connection (push path). */
  relayWsId: number;
  /** Subscription id of the script's live channel REQ. */
  relaySubId: string;
  /** AUTH challenge from the relay, captured by the connect step's channel. */
  authChallenge: string;
  fixture(name: string): string;
};

export function makeFixture(runId: string, name: string): string {
  return `parity-oracle-${name}-${runId}`;
}
