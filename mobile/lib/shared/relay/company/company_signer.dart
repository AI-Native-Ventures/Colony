import 'package:nostr/nostr.dart' as nostr;

import '../nostr_models.dart';
import 'company_action.dart';

/// Sign a Company Action with the member's own key.
///
/// A Company Action is owner-signed by contract, and the relay checks that
/// before it reads anything else. The desktop signs in Rust; mobile holds the
/// key in the same place every other outgoing event is signed from, so the
/// envelope is built here and signed the same way.
NostrEvent signCompanyAction(String nsec, CompanyAction action) {
  final privateKeyHex = nostr.Nip19.decode(payload: nsec).data;
  if (privateKeyHex.isEmpty) {
    throw StateError('Recording company work requires a signing key.');
  }
  final event = nostr.Event.from(
    kind: EventKind.companyAction,
    content: action.content,
    tags: action.tags,
    secretKey: privateKeyHex,
    verify: false,
  );
  return NostrEvent.fromJson(event.toMap());
}

/// The hex public key one nsec signs as, or null when there is no key.
String? companySignerPubkey(String? nsec) {
  if (nsec == null || nsec.isEmpty) return null;
  final privateKeyHex = nostr.Nip19.decode(payload: nsec).data;
  if (privateKeyHex.isEmpty) return null;
  return nostr.Keys(privateKeyHex).public;
}
