/// The relay a fresh sign-in talks to.
///
/// Baked in at build time rather than typed by the user. Desktop does the same
/// thing, reading `option_env!("BUZZ_DESKTOP_BUILD_RELAY_URL")` in
/// `desktop/src-tauri/src/commands/identity.rs`, so each channel ships its own
/// default. Asking someone to type a workspace URL is a setup step whose
/// answer the build already knows.
///
/// Set it per channel with:
///
/// ```
/// flutter build ... --dart-define=BUZZ_MOBILE_BUILD_RELAY_URL=wss://relay.example.com
/// ```
///
/// Pairing and invite links still carry their own relay and keep overriding
/// this, which is how a second workspace gets on the device at all.
library;

/// Production relay, used when the build defines nothing.
const defaultAccountRelayUrl = 'wss://relay.ainative.ventures';

/// The relay this build signs in against.
const accountRelayUrl = String.fromEnvironment(
  'BUZZ_MOBILE_BUILD_RELAY_URL',
  defaultValue: defaultAccountRelayUrl,
);

/// The HTTPS origin matching a `wss://` relay URL.
///
/// The account routes are HTTP on the same host as the WebSocket. A `wss://`
/// base handed to `Uri.resolve` produces a `wss://` request that no HTTP
/// client will make, which is the mistake `relay_provider.dart` already
/// records for the media endpoints.
Uri accountApiOrigin([String relayUrl = accountRelayUrl]) {
  final uri = Uri.parse(relayUrl);
  final scheme = switch (uri.scheme) {
    'wss' || 'https' => 'https',
    'ws' || 'http' => 'http',
    _ => throw FormatException('Unsupported relay scheme', relayUrl),
  };
  if (uri.host.isEmpty) {
    throw FormatException('Relay URL has no host', relayUrl);
  }
  return Uri(
    scheme: scheme,
    host: uri.host,
    port: uri.hasPort ? uri.port : null,
  );
}
