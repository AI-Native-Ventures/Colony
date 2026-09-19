/// Email and password sign-in against the relay's account routes.
///
/// The mirror of desktop's `signIn` in
/// `desktop/src/features/onboarding/authService.ts`. The password never leaves
/// the device: what is posted is [deriveAuthKey]'s output, and the identity
/// comes back encrypted under the same password for this device to open.
library;

import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:nostr/nostr.dart' as nostr;

import 'account_relay.dart';
import 'auth_crypto.dart';
import 'ncryptsec.dart';
import 'password_kdf.dart';

/// The one KDF parameter set this build sends and accepts.
///
/// Matches `KDF_VERSION` in authService.ts. A newer relay may hold the
/// identity at a format this build cannot open, and continuing would sign
/// someone in with a key that decrypts nothing.
const accountKdfVersion = 1;

/// Why a sign-in failed. Screens switch on this and nothing else: there is
/// deliberately no field carrying a status code or a server message.
enum SigninFailure {
  /// Unknown address or wrong password. The relay reports one answer for both
  /// on purpose, so credential stuffing gets no oracle.
  invalidCredentials,

  /// Too many attempts. [SigninException.retryAfterSeconds] says how long.
  locked,

  /// The relay could not be reached, or answered something unusable.
  unreachable,

  /// The account is stored at a format this build does not understand.
  updateRequired,

  /// The relay answered, but its backup would not open with this password.
  /// Distinct from [invalidCredentials]: the relay accepted the auth key, so
  /// the password is right and the stored blob is the problem.
  damagedBackup,
}

class SigninException implements Exception {
  const SigninException(this.failure, {this.retryAfterSeconds = 0});

  final SigninFailure failure;
  final int retryAfterSeconds;

  @override
  String toString() => 'SigninException(${failure.name})';
}

/// A signed-in identity, ready to become a `Community`.
class SignedInAccount {
  const SignedInAccount({
    required this.pubkey,
    required this.nsec,
    required this.servedBy,
  });

  final String pubkey;

  /// The bech32 secret key, the shape `CommunityStorage` already persists.
  final String nsec;

  /// Which implementation derived the auth key. Carried so a host that never
  /// registered the channel is visible rather than merely slow.
  final PasswordKdfBackend servedBy;
}

/// Sign in with an email address and password.
Future<SignedInAccount> signInWithPassword({
  required String email,
  required String password,
  required http.Client client,
  Uri? apiOrigin,
  PasswordKdf kdf = const PlatformPasswordKdf(),
}) async {
  final derivation = await deriveAuthKey(
    email: email,
    password: password,
    kdf: kdf,
  );

  final http.Response response;
  try {
    response = await client.post(
      (apiOrigin ?? accountApiOrigin()).replace(path: '/api/accounts/signin'),
      headers: const {'Content-Type': 'application/json'},
      body: jsonEncode({
        'email': normaliseEmail(email),
        'authKey': derivation.authKey,
      }),
    );
  } catch (_) {
    // Anything that stopped the request reaching an answer is the one bucket
    // that means "retry, nothing has changed".
    throw const SigninException(SigninFailure.unreachable);
  }

  final body = _decodeBody(response.body);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw _failureFromBody(body);
  }

  final pubkey = body['pubkey'];
  final passwordBlob = body['passwordBlob'];
  final kdfVersion = body['kdfVersion'];
  if (pubkey is! String || passwordBlob is! String) {
    throw const SigninException(SigninFailure.unreachable);
  }
  if (kdfVersion != accountKdfVersion) {
    throw const SigninException(SigninFailure.updateRequired);
  }

  final nostr.Keys keys;
  try {
    final secret = await decryptNcryptsec(
      ncryptsec: passwordBlob,
      password: password,
    );
    keys = nostr.Keys(_hex(secret));
  } on NcryptsecException {
    // The relay accepted the auth key, so the password is right. A blob that
    // will not open under it is a damaged or foreign backup, and reporting
    // "wrong password" here would send someone to reset a correct one.
    throw const SigninException(SigninFailure.damagedBackup);
  }

  if (keys.public != pubkey) {
    // The backup opened, but not into the identity this account claims. That
    // is not a login: it would sign every later event with the wrong key.
    throw const SigninException(SigninFailure.damagedBackup);
  }

  return SignedInAccount(
    pubkey: pubkey,
    nsec: keys.nsec,
    servedBy: derivation.servedBy,
  );
}

Map<String, dynamic> _decodeBody(String body) {
  if (body.isEmpty) return const {};
  try {
    final decoded = jsonDecode(body);
    return decoded is Map ? Map<String, dynamic>.from(decoded) : const {};
  } on FormatException {
    return const {};
  }
}

SigninException _failureFromBody(Map<String, dynamic> body) {
  switch (body['error']) {
    case 'invalid_credentials':
    case 'invalid_recovery_code':
      return const SigninException(SigninFailure.invalidCredentials);
    // Both mean "wait, then try again", and both carry how long. Rate limiting
    // must not fall through to unreachable: that tells the user to retry, and
    // retrying is what keeps the window open.
    case 'temporarily_locked':
    case 'rate_limited':
      final seconds = body['retryAfterSecs'];
      return SigninException(
        SigninFailure.locked,
        retryAfterSeconds: seconds is num ? seconds.floor().clamp(0, 86400) : 0,
      );
    default:
      return const SigninException(SigninFailure.unreachable);
  }
}

String _hex(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
