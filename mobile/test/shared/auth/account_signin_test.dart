import 'dart:convert';
import 'dart:typed_data';

import 'package:buzz/shared/auth/account_relay.dart';
import 'package:buzz/shared/auth/account_signin.dart';
import 'package:buzz/shared/auth/password_kdf.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nostr/nostr.dart' as nostr;

import 'ncryptsec_test.dart' show specNcryptsec, specPassword, specSecretKey;

/// A fixed-output derivation, so these tests do not pay 600,000 rounds each.
/// `auth_crypto_test.dart` covers the real parameters against the shared
/// vector; what matters here is what gets posted and what comes back.
class _StubKdf implements PasswordKdf {
  @override
  Future<PasswordKdfResult> pbkdf2HmacSha256({
    required Uint8List password,
    required Uint8List salt,
    required int iterations,
    required int length,
  }) async => PasswordKdfResult(
    key: Uint8List.fromList(List<int>.filled(length, 0x2a)),
    servedBy: PasswordKdfBackend.platform,
  );
}

final _apiOrigin = Uri.parse('https://relay.example.com');

Future<SignedInAccount> _signIn({
  required Future<http.Response> Function(http.Request) handler,
  String password = specPassword,
  List<http.Request>? sent,
}) {
  return signInWithPassword(
    email: '  Founder@Example.COM ',
    password: password,
    apiOrigin: _apiOrigin,
    kdf: _StubKdf(),
    client: MockClient((request) async {
      sent?.add(request);
      return handler(request);
    }),
  );
}

http.Response _ok(Object body) => http.Response(
  jsonEncode(body),
  200,
  headers: {'content-type': 'application/json'},
);

Matcher _fails(SigninFailure failure) => throwsA(
  isA<SigninException>().having((e) => e.failure, 'failure', failure),
);

void main() {
  final specPubkey = nostr.Keys(specSecretKey).public;

  test('posts the normalised address and the derived key', () async {
    final sent = <http.Request>[];
    await _signIn(
      sent: sent,
      handler: (_) async => _ok({
        'pubkey': specPubkey,
        'passwordBlob': specNcryptsec,
        'kdfVersion': 1,
      }),
    );

    final request = sent.single;
    expect(request.url.path, '/api/accounts/signin');
    expect(request.url.origin, _apiOrigin.origin);
    final body = jsonDecode(request.body) as Map<String, dynamic>;
    // camelCase, matching SigninRequest's serde rename_all in
    // crates/buzz-relay/src/api/accounts.rs, and the address normalised the
    // way the relay normalises it.
    expect(body.keys, containsAll(<String>['email', 'authKey']));
    expect(body['email'], 'founder@example.com');
    expect(body['authKey'], matches(RegExp(r'^[0-9a-f]{64}$')));
    // The password itself never appears anywhere in the request.
    expect(request.body, isNot(contains(specPassword)));
  });

  test('opens the returned backup into the claimed identity', () async {
    final account = await _signIn(
      handler: (_) async => _ok({
        'pubkey': specPubkey,
        'passwordBlob': specNcryptsec,
        'kdfVersion': 1,
      }),
    );

    expect(account.pubkey, specPubkey);
    expect(account.nsec, nostr.Keys(specSecretKey).nsec);
    expect(account.servedBy, PasswordKdfBackend.platform);
  });

  test('refuses a backup that opens into a different identity', () async {
    // The blob opened, but not into the account the relay named. Signing in
    // anyway would sign every later event with the wrong key.
    await expectLater(
      _signIn(
        handler: (_) async => _ok({
          'pubkey': 'f' * 64,
          'passwordBlob': specNcryptsec,
          'kdfVersion': 1,
        }),
      ),
      _fails(SigninFailure.damagedBackup),
    );
  });

  test('separates a damaged backup from a wrong password', () async {
    // The relay accepted the auth key, so the password is right. Reporting
    // "wrong password" here would send someone to reset a correct one.
    await expectLater(
      _signIn(
        password: 'not nostr',
        handler: (_) async => _ok({
          'pubkey': specPubkey,
          'passwordBlob': specNcryptsec,
          'kdfVersion': 1,
        }),
      ),
      _fails(SigninFailure.damagedBackup),
    );
  });

  test('maps the relay failures it is meant to distinguish', () async {
    Future<void> expectMapped(
      int status,
      Object body,
      SigninFailure failure,
    ) async {
      await expectLater(
        _signIn(handler: (_) async => http.Response(jsonEncode(body), status)),
        _fails(failure),
      );
    }

    await expectMapped(401, {
      'error': 'invalid_credentials',
    }, SigninFailure.invalidCredentials);
    await expectMapped(423, {
      'error': 'temporarily_locked',
      'retryAfterSecs': 90,
    }, SigninFailure.locked);
    await expectMapped(429, {
      'error': 'rate_limited',
      'retryAfterSecs': 5,
    }, SigninFailure.locked);
    // Anything unrecognised, including a 5xx or an empty body, is the bucket
    // that means "retry, nothing changed".
    await expectMapped(500, <String, Object>{}, SigninFailure.unreachable);
    await expectMapped(400, 'not json', SigninFailure.unreachable);
  });

  test('carries how long a lockout has left', () async {
    await expectLater(
      _signIn(
        handler: (_) async => http.Response(
          jsonEncode({'error': 'temporarily_locked', 'retryAfterSecs': 90}),
          423,
        ),
      ),
      throwsA(
        isA<SigninException>().having(
          (e) => e.retryAfterSeconds,
          'retryAfterSeconds',
          90,
        ),
      ),
    );
  });

  test('refuses a KDF version this build cannot open', () async {
    // A newer relay may hold the identity at a format this build cannot read.
    // Continuing would sign someone in with a key that decrypts nothing.
    await expectLater(
      _signIn(
        handler: (_) async => _ok({
          'pubkey': specPubkey,
          'passwordBlob': specNcryptsec,
          'kdfVersion': 2,
        }),
      ),
      _fails(SigninFailure.updateRequired),
    );
  });

  test('treats a half-answer as unreachable', () async {
    for (final body in <Map<String, Object>>[
      {'pubkey': 'a' * 64, 'kdfVersion': 1},
      {'passwordBlob': specNcryptsec, 'kdfVersion': 1},
    ]) {
      await expectLater(
        _signIn(handler: (_) async => _ok(body)),
        _fails(SigninFailure.unreachable),
      );
    }
  });

  test('treats a transport failure as unreachable', () async {
    await expectLater(
      _signIn(handler: (_) async => throw const SocketException('down')),
      _fails(SigninFailure.unreachable),
    );
  });

  group('accountApiOrigin', () {
    test('turns the wss relay into its https origin', () {
      // A wss base handed to an HTTP client makes a request nothing will
      // answer, which relay_provider.dart already records for media.
      expect(
        accountApiOrigin('wss://relay.example.com').toString(),
        'https://relay.example.com',
      );
      expect(
        accountApiOrigin('ws://localhost:3000').toString(),
        'http://localhost:3000',
      );
    });

    test('refuses a URL it cannot turn into an origin', () {
      expect(
        () => accountApiOrigin('relay.example.com'),
        throwsFormatException,
      );
      expect(() => accountApiOrigin('wss://'), throwsFormatException);
    });

    test('defaults to the production relay when the build defines none', () {
      // The dart-define is BUZZ_MOBILE_BUILD_RELAY_URL; tests run without it.
      expect(accountRelayUrl, defaultAccountRelayUrl);
    });
  });
}

class SocketException implements Exception {
  const SocketException(this.message);
  final String message;
}
