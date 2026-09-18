import 'package:buzz/features/channels/message_content/link_normalizer.dart';
import 'package:flutter_test/flutter_test.dart';

const _channelId = '11111111-1111-4111-8111-111111111111';
final _messageId = 'a' * 64;
final _permalink = 'buzz://message?channel=$_channelId&id=$_messageId';

void main() {
  test('links a bare buzz permalink', () {
    expect(
      normalizeBareLinks('see $_permalink'),
      'see [$_permalink]($_permalink)',
    );
  });

  test('links a bare channel permalink', () {
    const url = 'buzz://channel/$_channelId';

    expect(normalizeBareLinks('see $url'), 'see [$url]($url)');
  });

  test('links an angle-bracket autolink', () {
    expect(
      normalizeBareLinks('see <$_permalink>'),
      'see [$_permalink]($_permalink)',
    );
  });

  test('leaves a URL inside inline code alone', () {
    expect(normalizeBareLinks('see `$_permalink`'), 'see `$_permalink`');
  });

  test('leaves a URL inside a fenced block alone', () {
    final content = 'before\n```\n$_permalink\n```\nafter';

    expect(normalizeBareLinks(content), content);
  });

  test('peels trailing punctuation off a buzz URL', () {
    expect(
      normalizeBareLinks('see $_permalink.'),
      'see [$_permalink]($_permalink).',
    );
  });

  test('leaves trailing punctuation on an http URL', () {
    // Peeling here would change an existing destination, so http(s) keeps
    // whatever the author typed.
    const url = 'https://example.com/page.';

    expect(normalizeBareLinks('see $url'), 'see [$url]($url)');
  });

  test('does not relink an authored markdown link', () {
    final content = '[label]($_permalink)';

    expect(normalizeBareLinks(content), content);
  });

  test('leaves an unsupported buzz host as plain text', () {
    // Colony has no parser for entity permalinks, so linking one would render
    // a chip that navigates nowhere.
    const url = 'buzz://pr?owner=a&repo=b&number=1';

    expect(normalizeBareLinks('see $url'), 'see $url');
  });

  test('still links ordinary http URLs', () {
    const url = 'https://example.com/page';

    expect(normalizeBareLinks('see $url'), 'see [$url]($url)');
  });
}
