import * as React from "react";

/**
 * State that resets synchronously when `scopeKey` changes.
 *
 * The reset happens during render, before effects or async callbacks run, so a
 * component instance reused for a different job (or viewer, or approved
 * revision) never shows another scope's pending value. Callers still guard
 * their async resolutions with `isScopeCurrent`; this hook removes the stale
 * value, that guard removes the stale write.
 */
export function useScopedState<T>(
  scopeKey: string,
  createInitial: (scopeKey: string) => T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [entry, setEntry] = React.useState<{ key: string; value: T }>(() => ({
    key: scopeKey,
    value: createInitial(scopeKey),
  }));
  let value = entry.value;
  if (entry.key !== scopeKey) {
    value = createInitial(scopeKey);
    setEntry({ key: scopeKey, value });
  }
  const setScoped = React.useCallback(
    (action: React.SetStateAction<T>) => {
      setEntry((previous) => {
        const base =
          previous.key === scopeKey ? previous.value : createInitial(scopeKey);
        return {
          key: scopeKey,
          value:
            typeof action === "function"
              ? (action as (prev: T) => T)(base)
              : action,
        };
      });
    },
    [createInitial, scopeKey],
  );
  return [value, setScoped];
}
