/// Client-side derivation for email and password accounts.
///
/// The mirror of `desktop/src/features/onboarding/authCrypto.ts`. The password
/// never leaves the device: what reaches the relay is [deriveAuthKey]'s output,
/// which proves the password is known without revealing it.
///
/// Every constant here is a wire format shared with desktop and with the
/// relay's `is_lowercase_hex(&request.auth_key, 64)` check. A derivation that
/// differs from desktop's by one byte reports `invalid_credentials` for a
/// correct password, with nothing in any log to say why, so the values are
/// pinned by a shared test vector rather than trusted.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:pointycastle/export.dart';

import 'password_kdf.dart';

/// Iterations desktop uses. `authCrypto.ts` calls this PBKDF2_ITERATIONS.
const authKeyIterations = 600000;

/// Bytes of derived key, rendered as 64 hex characters.
const authKeyLength = 32;

/// Salt prefix. Deriving the salt from the address rather than the server lets
/// a second device derive this from the password alone, with no round trip.
const authKeySaltPrefix = 'colony-auth-v1:';

/// A derived auth key and the implementation that produced it.
class AuthKeyDerivation {
  const AuthKeyDerivation({required this.authKey, required this.servedBy});

  /// 64 lowercase hex characters, the shape the relay validates.
  final String authKey;

  final PasswordKdfBackend servedBy;
}

/// Canonical form of an address: trimmed and lowercased.
///
/// Plus-addressing is preserved deliberately, matching `normalise_email` in
/// `crates/buzz-auth/src/account_crypto.rs`: a tagged address is a separate
/// account because a user who tags one expects it to stay separate.
String normaliseEmail(String raw) => raw.trim().toLowerCase();

/// The 32 raw salt bytes for an address.
///
/// Raw digest bytes, not their hex rendering. Desktop passes the `ArrayBuffer`
/// from `crypto.subtle.digest` straight into PBKDF2, and hex here would double
/// the salt's length and change every key.
Uint8List authKeySalt(String email) {
  final digest = SHA256Digest();
  final input = utf8.encode('$authKeySaltPrefix${normaliseEmail(email)}');
  return digest.process(Uint8List.fromList(input));
}

/// Derive the value the relay checks against its stored hash.
///
/// The password is used as its raw UTF-8 bytes, with **no** Unicode
/// normalisation. That is not an oversight and must not be "fixed": desktop
/// encodes the password with `new TextEncoder()` and normalises nothing, so a
/// composed and a decomposed spelling of the same accented password derive
/// different keys there. NIP-49, which opens the returned backup, does the
/// opposite and NFKC-normalises. Matching desktop is the requirement; matching
/// NIP-49 here would lock every user with an accented password out of their
/// own account.
Future<AuthKeyDerivation> deriveAuthKey({
  required String email,
  required String password,
  PasswordKdf kdf = const PlatformPasswordKdf(),
}) async {
  final result = await kdf.pbkdf2HmacSha256(
    password: Uint8List.fromList(utf8.encode(password)),
    salt: authKeySalt(email),
    iterations: authKeyIterations,
    length: authKeyLength,
  );
  return AuthKeyDerivation(
    authKey: _toHex(result.key),
    servedBy: result.servedBy,
  );
}

String _toHex(Uint8List bytes) {
  final buffer = StringBuffer();
  for (final byte in bytes) {
    buffer.write(byte.toRadixString(16).padLeft(2, '0'));
  }
  return buffer.toString();
}
