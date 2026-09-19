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
import 'package:unorm_dart/unorm_dart.dart' as unorm;

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

/// Canonical form of a password: NFKC, the same normalisation NIP-49 applies
/// before its scrypt.
///
/// Which spelling a keyboard emits is not something a user chooses. iOS and
/// macOS routinely produce decomposed text where other sources produce
/// composed, and without this the same typed password derives a different key
/// depending on where it was typed.
String normalisePassword(String password) => unorm.nfkc(password);

/// Derive the value the relay checks against its stored hash.
///
/// The password is normalised first, matching desktop's `deriveAuthKey` and
/// NIP-49's own handling. Accounts created before that was true are reached
/// through [deriveLegacyAuthKey] instead.
Future<AuthKeyDerivation> deriveAuthKey({
  required String email,
  required String password,
  PasswordKdf kdf = const PlatformPasswordKdf(),
  bool normalise = true,
}) async {
  final result = await kdf.pbkdf2HmacSha256(
    password: Uint8List.fromList(
      utf8.encode(normalise ? normalisePassword(password) : password),
    ),
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

/// Derive the key an account created before signup normalised would have.
///
/// Only for the sign-in fallback. Normalising at signup fixes new accounts,
/// but an account created from a decomposed password already has an
/// `auth_hash` over those exact bytes, and normalising everywhere would lock
/// its owner out of an account that works today.
///
/// Removable once v2 re-keying lands; see the `account-key-normalisation-v2`
/// epic artifact for what that takes.
Future<AuthKeyDerivation> deriveLegacyAuthKey({
  required String email,
  required String password,
  PasswordKdf kdf = const PlatformPasswordKdf(),
}) =>
    deriveAuthKey(email: email, password: password, kdf: kdf, normalise: false);
