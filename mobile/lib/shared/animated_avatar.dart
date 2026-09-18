// Animated avatar URL scheme, shared with the desktop client.
//
// An animated avatar is persisted in the kind:0 `picture` field as one string
// so it round-trips through any Nostr client:
//
//   <posterUrl>#buzz-anim=<encoded animationUrl>
//
// The poster is the static frame the user picked; the fragment carries the
// animation. A client that does not understand the scheme loads the whole
// string as an image URL, and since a fragment is never sent over HTTP it
// simply renders the poster.
//
// `#buzz-anim=` is a wire token, not a name we are free to change: desktop
// already writes it in `desktop/src/shared/lib/animatedAvatar.ts`, and every
// avatar published by a desktop client carries it. Renaming it here would
// make mobile silently fail to parse avatars the rest of Colony produces.
const _animatedAvatarSeparator = '#buzz-anim=';

/// The static poster and animated image URLs encoded in an avatar URL.
class AnimatedAvatarDescriptor {
  const AnimatedAvatarDescriptor({
    required this.posterUrl,
    required this.animationUrl,
  });

  /// Static image shown when the avatar is idle.
  final String posterUrl;

  /// Animated image played when the avatar is activated.
  final String animationUrl;
}

/// Parses the animated-avatar fragment scheme from [url].
///
/// Returns `null` when the poster or animation URL is missing, malformed, or
/// does not use HTTP(S). Desktop's parser tests the scheme with a regex; this
/// one additionally requires a non-empty host, which only rejects strings
/// desktop's builder cannot produce.
AnimatedAvatarDescriptor? parseAnimatedAvatarUrl(String? url) {
  if (url == null || url.isEmpty) return null;

  final separatorIndex = url.indexOf(_animatedAvatarSeparator);
  if (separatorIndex <= 0) return null;

  final posterUrl = url.substring(0, separatorIndex);
  final encodedAnimationUrl = url.substring(
    separatorIndex + _animatedAvatarSeparator.length,
  );
  if (encodedAnimationUrl.isEmpty) return null;

  final String animationUrl;
  try {
    animationUrl = Uri.decodeComponent(encodedAnimationUrl);
  } on ArgumentError {
    return null;
  } on FormatException {
    return null;
  }

  if (!_isHttpUrl(posterUrl) || !_isHttpUrl(animationUrl)) return null;
  return AnimatedAvatarDescriptor(
    posterUrl: posterUrl,
    animationUrl: animationUrl,
  );
}

bool _isHttpUrl(String value) {
  final uri = Uri.tryParse(value);
  return uri != null &&
      (uri.scheme == 'http' || uri.scheme == 'https') &&
      uri.host.isNotEmpty;
}
