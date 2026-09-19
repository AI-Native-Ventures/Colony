import 'dart:convert';

import 'package:buzz/shared/auth/auth_crypto.dart';
import 'package:buzz/shared/auth/password_kdf.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

/// The shared account vector.
///
/// Minted from desktop's own `deriveAuthKey`, not from a reimplementation of
/// it, and pinned identically in three other places:
///
/// - `desktop/src/features/onboarding/authCrypto.test.mjs`
/// - `mobile/ios/RunnerTests/RunnerTests.swift`
/// - `mobile/android/app/src/test/kotlin/.../PasswordKdfTest.kt`
///
/// If any implementation drifts, one of those four fails. Without the pin they
/// would all keep passing while a real user got `invalid_credentials` for a
/// correct password, which is the only symptom the relay can report.
const vectorEmail = 'founder@example.com';
const vectorPassword = 'correct horse battery';
const vectorAuthKey =
    '25e331a7de880c18d500eb562f99241e65a13f2ad5a0c664be0179d7cfc92082';
const vectorSalt =
    '8af931298933fa3787812090082249cbdca8621047fa7aff922fe12acb35d9d7';

/// A [PasswordKdf] that records its inputs and returns fixed bytes, so the
/// tests about wiring do not pay for 600,000 rounds.
class _RecordingKdf implements PasswordKdf {
  Uint8List? password;
  Uint8List? salt;
  int? iterations;
  int? length;

  @override
  Future<PasswordKdfResult> pbkdf2HmacSha256({
    required Uint8List password,
    required Uint8List salt,
    required int iterations,
    required int length,
  }) async {
    this.password = password;
    this.salt = salt;
    this.iterations = iterations;
    this.length = length;
    return PasswordKdfResult(
      key: Uint8List.fromList(List<int>.filled(length, 0xab)),
      servedBy: PasswordKdfBackend.platform,
    );
  }
}

String _hex(List<int> bytes) =>
    bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('normaliseEmail', () {
    test('trims and lowercases', () {
      expect(normaliseEmail('  Founder@Example.COM '), 'founder@example.com');
    });

    test('keeps plus addressing distinct', () {
      // Matches normalise_email in crates/buzz-auth/src/account_crypto.rs: a
      // tagged address is deliberately a separate account.
      expect(normaliseEmail('a+work@x.com'), isNot(normaliseEmail('a@x.com')));
    });
  });

  group('authKeySalt', () {
    test('is the raw SHA-256 digest of the prefixed address', () {
      expect(_hex(authKeySalt(vectorEmail)), vectorSalt);
      expect(authKeySalt(vectorEmail), hasLength(32));
    });

    test('ignores address case', () {
      expect(authKeySalt('FOUNDER@EXAMPLE.COM'), authKeySalt(vectorEmail));
    });
  });

  group('deriveAuthKey', () {
    test('matches the desktop vector', () async {
      // The one cross-implementation assertion. Runs the real 600,000 rounds
      // through pointycastle; it is slow on purpose, because a cheaper test
      // would prove nothing about the value the relay actually checks.
      final derived = await deriveAuthKey(
        email: vectorEmail,
        password: vectorPassword,
        kdf: const DartPasswordKdf(),
      );

      expect(derived.authKey, vectorAuthKey);
      expect(derived.authKey, matches(RegExp(r'^[0-9a-f]{64}$')));
    }, timeout: const Timeout(Duration(minutes: 2)));

    test('sends the desktop parameters to the derivation', () async {
      final kdf = _RecordingKdf();
      await deriveAuthKey(
        email: '  Founder@Example.COM ',
        password: vectorPassword,
        kdf: kdf,
      );

      expect(kdf.iterations, 600000);
      expect(kdf.length, 32);
      // The address is normalised before it is salted, and the salt is raw
      // digest bytes rather than their hex rendering.
      expect(_hex(kdf.salt!), vectorSalt);
      expect(kdf.password, utf8.encode(vectorPassword));
    });

    test('does NOT normalise the password', () async {
      // Deliberate, and the opposite of NIP-49. Desktop encodes the password
      // with TextEncoder and normalises nothing, so a composed and a
      // decomposed spelling derive different keys there. Normalising here
      // would lock every user with an accented password out of their account
      // while every other test still passed.
      final composed = _RecordingKdf();
      final decomposed = _RecordingKdf();
      await deriveAuthKey(
        email: vectorEmail,
        password: 'caf\u00e9 battery staple',
        kdf: composed,
      );
      await deriveAuthKey(
        email: vectorEmail,
        password: 'cafe\u0301 battery staple',
        kdf: decomposed,
      );

      expect(composed.password, isNot(decomposed.password));
    });

    test('reports which implementation served the call', () async {
      final kdf = _RecordingKdf();
      final derived = await deriveAuthKey(
        email: vectorEmail,
        password: vectorPassword,
        kdf: kdf,
      );

      expect(derived.servedBy, PasswordKdfBackend.platform);
    });
  });

  group('PlatformPasswordKdf', () {
    late List<MethodCall> calls;

    setUp(() => calls = <MethodCall>[]);

    Future<PasswordKdfResult> derive({
      required Future<Object?>? Function(MethodCall) handler,
    }) {
      const channel = MethodChannel(passwordKdfChannelName);
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) {
            calls.add(call);
            return handler(call);
          });
      addTearDown(() {
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            .setMockMethodCallHandler(channel, null);
      });
      return const PlatformPasswordKdf().pbkdf2HmacSha256(
        password: Uint8List.fromList(utf8.encode(vectorPassword)),
        salt: authKeySalt(vectorEmail),
        iterations: 4,
        length: 32,
      );
    }

    test('passes raw bytes to the host and reports the platform', () async {
      final native = Uint8List.fromList(List<int>.filled(32, 0x11));
      final result = await derive(handler: (_) async => native);

      expect(result.key, native);
      expect(result.servedBy, PasswordKdfBackend.platform);
      final call = calls.single;
      expect(call.method, 'pbkdf2HmacSha256');
      final arguments = call.arguments as Map<Object?, Object?>;
      expect(arguments['password'], utf8.encode(vectorPassword));
      expect(_hex(arguments['salt']! as Uint8List), vectorSalt);
      expect(arguments['iterations'], 4);
      expect(arguments['length'], 32);
    });

    test('falls back to Dart when the host answers the wrong shape', () async {
      // A host returning a short key is worse than one that does not answer,
      // so it must not be trusted just because it replied.
      final result = await derive(
        handler: (_) async => Uint8List.fromList(List<int>.filled(16, 0x11)),
      );

      expect(result.servedBy, PasswordKdfBackend.dart);
      expect(result.key, hasLength(32));
    });

    test('falls back to Dart when the host refuses', () async {
      final result = await derive(
        handler: (_) async =>
            throw PlatformException(code: 'derivation_failed'),
      );

      expect(result.servedBy, PasswordKdfBackend.dart);
      expect(result.key, hasLength(32));
    });

    test('falls back to Dart when no host registered the channel', () async {
      // The widget-test case, and any platform the app reaches before its
      // channel does.
      final result = await const PlatformPasswordKdf().pbkdf2HmacSha256(
        password: Uint8List.fromList(utf8.encode(vectorPassword)),
        salt: authKeySalt(vectorEmail),
        iterations: 4,
        length: 32,
      );

      expect(result.servedBy, PasswordKdfBackend.dart);
      expect(result.key, hasLength(32));
    });

    test('the two implementations agree on the same inputs', () async {
      // The fallback is only safe because it is the same function. Four
      // rounds rather than 600,000 keeps this cheap; the vector test above
      // covers the real parameters.
      final native = await derive(
        handler: (call) async {
          final arguments = call.arguments as Map<Object?, Object?>;
          return derivePbkdf2HmacSha256Sync(
            password: arguments['password']! as Uint8List,
            salt: arguments['salt']! as Uint8List,
            iterations: arguments['iterations']! as int,
            length: arguments['length']! as int,
          );
        },
      );
      final fallback = await const DartPasswordKdf().pbkdf2HmacSha256(
        password: Uint8List.fromList(utf8.encode(vectorPassword)),
        salt: authKeySalt(vectorEmail),
        iterations: 4,
        length: 32,
      );

      expect(native.servedBy, PasswordKdfBackend.platform);
      expect(fallback.servedBy, PasswordKdfBackend.dart);
      expect(native.key, fallback.key);
    });
  });
}
