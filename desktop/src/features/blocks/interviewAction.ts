/** Derive only the existing Interview unknown-answer action from its pinned fact. */
export function resolveInterviewActionInputs(
  handle: string,
  data: unknown,
): Map<string, { fact: string }> {
  if (
    handle !== "interview" ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  )
    return new Map();
  const fact = (data as Record<string, unknown>).fact;
  if (typeof fact !== "string" || !fact.trim() || [...fact].length > 80)
    return new Map();
  return new Map([["interview.unknown", { fact }]]);
}
