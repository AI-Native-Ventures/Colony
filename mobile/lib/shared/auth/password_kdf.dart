/// PBKDF2 for the email-and-password account key.
///
/// Pure Dart PBKDF2 is unusable here. Measured on an Apple M1 Max, 600,000
/// HMAC-SHA256 rounds through pointycastle take 6.1 s compiled AOT, which is
/// what a phone runs, against 76 ms for the same work natively: eighty times
/// slower, and a mid-range phone is slower again. So the derivation goes
/// through a platform channel, and the Dart implementation exists only as the
/// fallback that keeps tests and any unsupported host working.
///
/// Because the slow path still produces a correct answer, a host that failed
/// to register the channel would look like nothing worse than a sluggish
/// sign-in months after shipping. [PasswordKdfResult.servedBy] exists so that
/// is observable rather than invisible.
library;

import 'dart:isolate';

import 'package:flutter/services.dart';
import 'package:pointycastle/export.dart';

/// Which implementation actually produced a key.
enum PasswordKdfBackend {
  /// The native channel: `CCKeyDerivationPBKDF` or `javax.crypto.Mac`.
  platform,

  /// pointycastle inside an isolate. Correct, and roughly eighty times slower.
  dart,
}

/// A derived key plus the implementation that produced it.
class PasswordKdfResult {
  const PasswordKdfResult({required this.key, required this.servedBy});

  final Uint8List key;
  final PasswordKdfBackend servedBy;
}

/// Derives a key from a password. Bytes in, bytes out.
///
/// Implementations must not normalise, trim, case-fold or re-encode either
/// input. Text handling belongs to the caller, because two implementations
/// that each decide their own encoding produce different keys from the same
/// password and nothing reports that they disagreed.
abstract class PasswordKdf {
  Future<PasswordKdfResult> pbkdf2HmacSha256({
    required Uint8List password,
    required Uint8List salt,
    required int iterations,
    required int length,
  });
}

/// The channel name both hosts register.
const passwordKdfChannelName = 'buzz/password_kdf';

const _pbkdf2Method = 'pbkdf2HmacSha256';

/// Native PBKDF2, falling back to [DartPasswordKdf] when no host answers.
class PlatformPasswordKdf implements PasswordKdf {
  const PlatformPasswordKdf({
    MethodChannel channel = const MethodChannel(passwordKdfChannelName),
    PasswordKdf fallback = const DartPasswordKdf(),
  }) : _channel = channel,
       _fallback = fallback;

  final MethodChannel _channel;
  final PasswordKdf _fallback;

  @override
  Future<PasswordKdfResult> pbkdf2HmacSha256({
    required Uint8List password,
    required Uint8List salt,
    required int iterations,
    required int length,
  }) async {
    try {
      final derived = await _channel.invokeMethod<Uint8List>(_pbkdf2Method, {
        'password': password,
        'salt': salt,
        'iterations': iterations,
        'length': length,
      });
      if (derived != null && derived.length == length) {
        return PasswordKdfResult(
          key: derived,
          servedBy: PasswordKdfBackend.platform,
        );
      }
      // A host that answers with the wrong shape is worse than one that does
      // not answer, so treat it the same way rather than trusting the bytes.
    } on MissingPluginException {
      // No host registered the channel: widget tests, and any platform the
      // app grows onto before its channel does.
    } on PlatformException {
      // The native side refused. The fallback still derives the same key.
    }
    return _fallback.pbkdf2HmacSha256(
      password: password,
      salt: salt,
      iterations: iterations,
      length: length,
    );
  }
}

/// pointycastle PBKDF2, run off the UI isolate.
class DartPasswordKdf implements PasswordKdf {
  const DartPasswordKdf();

  @override
  Future<PasswordKdfResult> pbkdf2HmacSha256({
    required Uint8List password,
    required Uint8List salt,
    required int iterations,
    required int length,
  }) async {
    final key = await Isolate.run(
      () => derivePbkdf2HmacSha256Sync(
        password: password,
        salt: salt,
        iterations: iterations,
        length: length,
      ),
    );
    return PasswordKdfResult(key: key, servedBy: PasswordKdfBackend.dart);
  }
}

/// The synchronous derivation, exposed so the isolate entry point and the
/// vector tests run exactly the same code.
Uint8List derivePbkdf2HmacSha256Sync({
  required Uint8List password,
  required Uint8List salt,
  required int iterations,
  required int length,
}) {
  final derivator = PBKDF2KeyDerivator(HMac(SHA256Digest(), 64))
    ..init(Pbkdf2Parameters(salt, iterations, length));
  return derivator.process(password);
}
