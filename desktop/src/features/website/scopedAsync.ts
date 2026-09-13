/**
 * Shared scoped-async helpers.
 *
 * Every panel that dispatches work into an injected adapter keeps local state
 * scoped to the exact record identity it answers. A scope key change resets
 * that state synchronously, and an async result may only commit while its
 * dispatch scope is still current, so a late result from a previous job can
 * never decorate a newer card.
 */

export function scopedKey(...parts: readonly (string | number)[]): string {
  return parts.map((part) => String(part)).join("\u0000");
}

export function isScopeCurrent(
  dispatchScope: string,
  currentScope: string,
): boolean {
  return dispatchScope === currentScope;
}
