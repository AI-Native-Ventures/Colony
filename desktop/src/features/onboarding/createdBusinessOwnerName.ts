/** Seed only a missing public name on the exact owner; never overwrite a target profile. */
export function createdBusinessOwnerName(
  ownerPubkey: string,
  capturedName: unknown,
  target: { pubkey: string; displayName: string | null },
): string | null {
  if (target.pubkey !== ownerPubkey)
    throw new Error("The account changed while preparing its public name.");
  if (target.displayName?.trim()) return null;
  if (typeof capturedName !== "string" || capturedName.length > 256)
    return null;
  return capturedName.trim() || null;
}
