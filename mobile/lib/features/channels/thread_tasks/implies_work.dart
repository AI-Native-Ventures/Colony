/// Whether an agent-directed message is asking for work.
///
/// A port of the desktop's `impliesWork`, kept identical on purpose: the two
/// clients decide the same thing about the same message, or one of them opens
/// a task in a thread the other treats as small talk.
///
/// Every send to an agent used to mint a task, so "are you there?" appeared in
/// Work beside real instructions, with `inProgress` status and the raw message
/// as its title. Accounting for a greeting as work makes the task list a
/// transcript rather than a list of work.
///
/// The bar is deliberately low and the default is yes. A missing task is worse
/// than a spurious one: the work still happens, the agent turn is still paid
/// for, and nothing records it. So only messages that match a known
/// conversational shape are skipped, and anything with an actual instruction in
/// it is kept even when it is short.
library;

/// Leading mentions, markdown emphasis, and punctuation the shape check
/// ignores.
final _mentionRun = RegExp(
  r'@[\w-]+(?:\s+(?:of|the|and|for|de|van|von|da|di)\b|\s+[A-Z][\w-]*)*',
);
final _emphasis = RegExp(r'[*_`~#>]');
final _punctuation = RegExp(r'[!?.,:;]+');
final _whitespace = RegExp(r'\s+');

String _normalize(String content) => content
    // Mentions the composer inserted: "@Chief of Staff are you there?". Role
    // names carry lowercase connectors ("Chief of Staff"), so the run
    // continues through those as well as through capitalised words. Without
    // the connectors the leftover "of staff" made every message to the Chief
    // of Staff look like an instruction.
    .replaceAll(_mentionRun, ' ')
    // Markdown emphasis and code fences carry no meaning for this decision.
    .replaceAll(_emphasis, ' ')
    .replaceAll(_punctuation, ' ')
    .toLowerCase()
    .replaceAll(_whitespace, ' ')
    .trim();

/// Openers, acknowledgements and presence checks: complete messages that ask
/// for nothing. Matched whole, never as a prefix, so "thanks, now ship it"
/// still counts as work.
const _conversational = {
  'hi',
  'hey',
  'hello',
  'yo',
  'hiya',
  'morning',
  'good morning',
  'good afternoon',
  'good evening',
  'thanks',
  'thank you',
  'thanks so much',
  'ta',
  'cheers',
  'ok',
  'okay',
  'k',
  'cool',
  'nice',
  'great',
  'perfect',
  'got it',
  'understood',
  'noted',
  'sure',
  'yes',
  'no',
  'yep',
  'nope',
  'sounds good',
  'well done',
  'nvm',
  'never mind',
  'are you there',
  'you there',
  'are you here',
  'you here',
  'still there',
  'are you awake',
  'you up',
  'ping',
  'test',
  'testing',
  'hello there',
  'are you alive',
  'you alive',
  'are you working',
};

/// True when this message should open a task.
///
/// An empty message never does: there is no instruction to record. Everything
/// else is work unless the whole message is one of the conversational shapes
/// above.
bool impliesWork(String content) {
  final normalized = _normalize(content);
  if (normalized.isEmpty) return false;
  return !_conversational.contains(normalized);
}
