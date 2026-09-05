import 'dart:convert';
import 'dart:typed_data';

import 'package:pointycastle/digests/sha256.dart';
import 'package:uuid/uuid.dart';

/// The exact encodings a Colony company record is identified and signed by.
///
/// Every value here has a counterpart in `buzz-core` that the relay validates
/// byte for byte: a company action whose content is not canonical is refused
/// before anything reads it, and an idempotency key derived differently from
/// the desktop's turns a safe retry into a second write. So these are ports of
/// specific Rust functions rather than conveniences, and each names the one it
/// mirrors.

/// Canonical JSON: object keys sorted recursively, no whitespace.
///
/// Mirrors `canonical_json` in `buzz-core/src/block.rs`. The relay re-encodes
/// the content it receives and refuses anything that does not round-trip, so
/// key order is part of the wire contract rather than a formatting choice.
String canonicalCompanyJson(Object? value) => jsonEncode(_canonicalize(value));

Object? _canonicalize(Object? value) {
  if (value is Map) {
    final keys = value.keys.map((key) => key as String).toList()..sort();
    return <String, Object?>{
      for (final key in keys) key: _canonicalize(value[key]),
    };
  }
  if (value is List) {
    return [for (final entry in value) _canonicalize(entry)];
  }
  return value;
}

/// The namespace every derived Colony request UUID lives under.
///
/// Fixed forever, and identical to `COLONY_NAMESPACE` in
/// `buzz-core/src/company_roster.rs`: changing it would make every in-flight
/// retry generate fresh idempotency keys and re-apply completed relay writes.
const colonyUuidNamespace = '1e9f4d2a-7c3b-4e8a-9d5f-6210a4c78351';

const _uuid = Uuid();

/// The idempotency key for one step of one request.
///
/// Derived, not random, exactly as `step_idempotency_key` is: a retry after a
/// dropped connection produces the same key, so the relay recognises the write
/// as one it already applied instead of applying it twice.
String stepIdempotencyKey(String requestId, String step) =>
    _uuid.v5(colonyUuidNamespace, '$requestId:$step');

/// Unix seconds this epoch counts from, matching `COLONY_EPOCH`.
const _colonyEpoch = 1767225600;
const _colonyEpochSpread = 31536000;

/// A stable `createdAt` for one request.
///
/// Mirrors `approval_timestamp`. Derived from the request rather than read
/// from the clock, so a retry rebuilds byte-identical events; reading the
/// clock would make every attempt a different event with a different id, and
/// the relay's duplicate suppression would be the only thing between a retry
/// and a second record.
int approvalTimestamp(String requestId) {
  final digest = SHA256Digest().process(
    Uint8List.fromList(utf8.encode(requestId)),
  );
  final spread =
      (digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3];
  return _colonyEpoch + (spread.toUnsigned(32) % _colonyEpochSpread);
}

/// Lowercase a hex string, or return empty when it is not one.
String normalizeHex(String? value) {
  final trimmed = value?.trim().toLowerCase() ?? '';
  if (trimmed.isEmpty) return '';
  for (final unit in trimmed.codeUnits) {
    final isDigit = unit >= 0x30 && unit <= 0x39;
    final isLowerHex = unit >= 0x61 && unit <= 0x66;
    if (!isDigit && !isLowerHex) return '';
  }
  return trimmed;
}

/// Whether a string is a well-formed Nostr event id or public key.
bool isEventId(String? value) => normalizeHex(value).length == 64;
