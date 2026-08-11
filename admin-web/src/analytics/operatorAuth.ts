export type UnsignedNip98Event = {
  kind: 27235;
  created_at: number;
  tags: string[][];
  content: "";
};

export type SignedNip98Event = UnsignedNip98Event & {
  id: string;
  pubkey: string;
  sig: string;
};

export interface OperatorSigner {
  readonly source: "nip07" | "nip46";
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedNip98Event): Promise<SignedNip98Event>;
}

export class OperatorSignerUnavailable extends Error {
  readonly code = "operator_signer_unavailable" as const;

  constructor() {
    super("Connect an allowlisted operator signer to view analytics.");
    this.name = "OperatorSignerUnavailable";
  }
}

export class OperatorAuthFailure extends Error {
  readonly code = "operator_auth_failed" as const;

  constructor(
    public readonly status: number,
    message = "The operator signer was not accepted.",
  ) {
    super(message);
    this.name = "OperatorAuthFailure";
  }
}

export function selectOperatorSigner(
  target: Pick<Window, "nostr" | "colonyOperatorSigner"> = window,
): OperatorSigner {
  const source = target.nostr ?? target.colonyOperatorSigner;
  if (!source) throw new OperatorSignerUnavailable();
  const kind = target.nostr ? "nip07" : "nip46";
  return {
    source: kind,
    getPublicKey: () => source.getPublicKey(),
    signEvent: (event) => source.signEvent(event),
  };
}

export function freshNonce(): string {
  return crypto.randomUUID();
}

export function createNip98Event(
  url: string,
  method: string,
): UnsignedNip98Event {
  return {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["u", url],
      ["method", method.toUpperCase()],
      ["nonce", freshNonce()],
    ],
    content: "",
  };
}

export function encodeSignedEvent(event: SignedNip98Event): string {
  const compact = JSON.stringify(event);
  const bytes = new TextEncoder().encode(compact);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
