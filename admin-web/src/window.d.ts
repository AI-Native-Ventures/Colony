import type {
  SignedNip98Event,
  UnsignedNip98Event,
} from "./analytics/operatorAuth";

declare global {
  interface NostrWindowSigner {
    getPublicKey(): Promise<string>;
    signEvent(event: UnsignedNip98Event): Promise<SignedNip98Event>;
  }

  interface Window {
    nostr?: NostrWindowSigner;
    colonyOperatorSigner?: NostrWindowSigner;
  }
}
