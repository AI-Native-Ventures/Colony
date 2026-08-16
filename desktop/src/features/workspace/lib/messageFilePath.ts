/**
 * Recognise a workspace file path written inside a message's inline code span.
 *
 * Agents hand people files by name (`PLANS/FOO.md`, `desktop/src/app/App.tsx`),
 * and those names are dead text until something decides which of them is a
 * path. The decision is deliberately narrow: only inline code is inspected,
 * and only tokens that look like a file rather than like prose. A missed path
 * costs one copy-paste; a false positive turns an ordinary word into a link
 * that goes nowhere, so this errs towards missing.
 *
 * Resolution to a real file happens natively (`resolve_workspace_path`). This
 * module never touches the filesystem: it only answers "is this shaped like a
 * path", which keeps it testable without a shell.
 */

/** Longest path this will consider. Anything longer is not a file name. */
const MAX_PATH_LENGTH = 512;

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SEGMENT = "[A-Za-z0-9._@+-]+";
const PATH_SHAPE = new RegExp(`^(?:\\.{1,2}/|/)?${SEGMENT}(?:/${SEGMENT})*$`);
const EXTENSION = /\.([A-Za-z][A-Za-z0-9]{0,11})$/;
const LINE_SUFFIX = /:\d+$/;

/**
 * The file path a code span names, or null when it names something else.
 *
 * A trailing `:42` line reference is dropped rather than rejected: the path
 * still opens, and the file view has no line targeting to use it for.
 */
export function parseMessageFilePath(text: string): string | null {
  const candidate = text.trim().replace(LINE_SUFFIX, "");
  if (!candidate || candidate.length > MAX_PATH_LENGTH) return null;
  // A URL, a `file://` path, or a Windows drive letter is not this feature's
  // job: links already have their own handling.
  if (/\s/.test(candidate) || SCHEME.test(candidate)) return null;
  if (!PATH_SHAPE.test(candidate)) return null;
  // `..` escapes whatever root this would resolve against. The native side
  // refuses those too; stopping here means no chip is ever offered for one.
  if (candidate.split("/").includes("..")) return null;

  // A directory part is what separates `desktop/src/app/App.tsx` from prose
  // that merely contains a dot (`node.js`, `e.g.`). Bare file names stay dead
  // text: guessing wrong on those is worse than the copy-paste they cost.
  if (!candidate.includes("/")) return null;
  const name = candidate.split("/").pop() ?? "";
  if (!EXTENSION.test(name)) return null;
  return candidate;
}
