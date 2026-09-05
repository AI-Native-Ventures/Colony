import 'dart:convert';

import 'package:http/http.dart' as http;

import 'canonical_json.dart';

/// The active relay's own signing key, from its NIP-11 document.
///
/// Company records are only evidence because the tenant relay authored them,
/// so every read and every receipt check is measured against this key. A relay
/// that advertises none, or advertises something that is not a public key, is
/// untrusted rather than trusted-by-default: callers must treat null exactly
/// as they treat a failure.
Future<String?> fetchRelaySelf(
  String baseUrl, {
  http.Client? client,
  Duration timeout = const Duration(seconds: 8),
}) async {
  final owned = client == null;
  final httpClient = client ?? http.Client();
  try {
    final response = await httpClient
        .get(
          Uri.parse(baseUrl),
          headers: const {'Accept': 'application/nostr+json'},
        )
        .timeout(timeout);
    if (response.statusCode < 200 || response.statusCode >= 300) return null;
    final decoded = jsonDecode(utf8.decode(response.bodyBytes));
    if (decoded is! Map<String, dynamic>) return null;
    final relaySelf = decoded['self'];
    if (relaySelf is! String) return null;
    final normalized = normalizeHex(relaySelf);
    return isEventId(normalized) ? normalized : null;
  } catch (_) {
    return null;
  } finally {
    if (owned) httpClient.close();
  }
}
