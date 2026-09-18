import 'package:buzz/shared/animated_avatar.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const posterUrl = 'https://relay.example/media/poster.png';
  const animationUrl = 'https://relay.example/media/animation.png?loop=1';

  test('parses the selected poster and animated PNG URLs', () {
    final url = '$posterUrl#buzz-anim=${Uri.encodeComponent(animationUrl)}';

    final parsed = parseAnimatedAvatarUrl(url);

    expect(parsed?.posterUrl, posterUrl);
    expect(parsed?.animationUrl, animationUrl);
  });

  test('round-trips a query string and fragment inside the animation URL', () {
    // Desktop builds this fragment with encodeURIComponent, so reserved
    // characters in the animation URL must survive the round trip.
    const awkward = 'https://relay.example/media/bb.png?x=1&y=2#frag';
    final url = '$posterUrl#buzz-anim=${Uri.encodeComponent(awkward)}';

    expect(parseAnimatedAvatarUrl(url)?.animationUrl, awkward);
  });

  test('rejects malformed and non-http animated avatar URLs', () {
    expect(parseAnimatedAvatarUrl(posterUrl), isNull);
    expect(parseAnimatedAvatarUrl(null), isNull);
    expect(parseAnimatedAvatarUrl(''), isNull);
    expect(parseAnimatedAvatarUrl('$posterUrl#buzz-anim='), isNull);
    expect(parseAnimatedAvatarUrl('$posterUrl#buzz-anim=%E0%A4%A'), isNull);
    expect(parseAnimatedAvatarUrl('$posterUrl#buzz-anim=%'), isNull);
    expect(
      parseAnimatedAvatarUrl(
        '$posterUrl#buzz-anim=${Uri.encodeComponent('javascript:alert(1)')}',
      ),
      isNull,
    );
    expect(
      parseAnimatedAvatarUrl(
        'data:image/png;base64,xx#buzz-anim='
        '${Uri.encodeComponent(animationUrl)}',
      ),
      isNull,
    );
  });

  test('rejects a separator with no poster before it', () {
    expect(
      parseAnimatedAvatarUrl('#buzz-anim=${Uri.encodeComponent(animationUrl)}'),
      isNull,
    );
  });
}
