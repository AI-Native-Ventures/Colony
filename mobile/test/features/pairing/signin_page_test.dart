import 'dart:convert';
import 'dart:typed_data';

import 'package:buzz/features/pairing/signin_page.dart';
import 'package:buzz/features/pairing/signin_provider.dart';
import 'package:buzz/shared/auth/auth.dart';
import 'package:buzz/shared/theme/theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:nostr/nostr.dart' as nostr;
import 'package:shared_preferences/shared_preferences.dart';

import '../../shared/auth/ncryptsec_test.dart'
    show specNcryptsec, specPassword, specSecretKey;

/// A fixed-output derivation. The real parameters are covered against the
/// shared vector in `test/shared/auth/auth_crypto_test.dart`; 600,000 rounds
/// per pump here would only make these tests slow.
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

/// Settle without `pumpAndSettle`: the busy state shows a looping spinner, so
/// there is no frame at which the tree stops animating.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 40; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

Future<List<http.Request>> _pumpSignIn(
  WidgetTester tester, {
  required Future<http.Response> Function(http.Request) handler,
}) async {
  final sent = <http.Request>[];
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        signInKdfProvider.overrideWithValue(_StubKdf()),
        signInHttpClientProvider.overrideWithValue(
          MockClient((request) async {
            sent.add(request);
            return handler(request);
          }),
        ),
      ],
      child: MaterialApp(theme: AppTheme.light(), home: const SignInPage()),
    ),
  );
  await tester.pumpAndSettle();
  return sent;
}

Future<void> _enterCredentials(
  WidgetTester tester, {
  String email = 'founder@example.com',
  String password = specPassword,
}) async {
  await tester.enterText(find.byKey(SignInPage.emailFieldKey), email);
  await tester.enterText(find.byKey(SignInPage.passwordFieldKey), password);
  await tester.pump();
}

http.Response _signedIn(String pubkey) => http.Response(
  jsonEncode({
    'pubkey': pubkey,
    'passwordBlob': specNcryptsec,
    'kdfVersion': 1,
  }),
  200,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('asks for an email and a password, and hides the password', (
    tester,
  ) async {
    await _pumpSignIn(tester, handler: (_) async => _signedIn('a' * 64));

    expect(find.byKey(SignInPage.emailFieldKey), findsOneWidget);
    expect(find.byKey(SignInPage.passwordFieldKey), findsOneWidget);
    // There is deliberately no relay field: the build already knows.
    expect(find.text('Relay'), findsNothing);
    expect(
      tester
          .widget<TextField>(find.byKey(SignInPage.passwordFieldKey))
          .obscureText,
      isTrue,
    );
  });

  testWidgets('refuses to submit an empty form without asking the relay', (
    tester,
  ) async {
    final sent = await _pumpSignIn(
      tester,
      handler: (_) async => _signedIn('a' * 64),
    );

    await tester.tap(find.byKey(SignInPage.submitButtonKey));
    await _settle(tester);

    expect(sent, isEmpty);
    expect(find.byKey(SignInPage.errorKey), findsOneWidget);
  });

  testWidgets('sends the typed credentials to the relay', (tester) async {
    final pubkey = nostr.Keys(specSecretKey).public;
    final sent = await _pumpSignIn(
      tester,
      handler: (_) async {
        return _signedIn(pubkey);
      },
    );

    await _enterCredentials(tester, email: '  Founder@Example.COM ');
    await tester.tap(find.byKey(SignInPage.submitButtonKey));
    await _settle(tester);

    final body = jsonDecode(sent.single.body) as Map<String, dynamic>;
    expect(body['email'], 'founder@example.com');
    // The password itself is never sent, only what is derived from it.
    expect(sent.single.body, isNot(contains(specPassword)));
  });

  testWidgets('shows copy a reader can act on when credentials are wrong', (
    tester,
  ) async {
    await _pumpSignIn(
      tester,
      handler: (_) async =>
          http.Response(jsonEncode({'error': 'invalid_credentials'}), 401),
    );

    await _enterCredentials(tester);
    await tester.tap(find.byKey(SignInPage.submitButtonKey));
    await _settle(tester);

    expect(find.text('That email and password do not match.'), findsOneWidget);
  });

  testWidgets('clears the failure once the reader edits a field', (
    tester,
  ) async {
    await _pumpSignIn(
      tester,
      handler: (_) async =>
          http.Response(jsonEncode({'error': 'invalid_credentials'}), 401),
    );

    await _enterCredentials(tester);
    await tester.tap(find.byKey(SignInPage.submitButtonKey));
    await _settle(tester);
    expect(find.byKey(SignInPage.errorKey), findsOneWidget);

    await tester.enterText(
      find.byKey(SignInPage.passwordFieldKey),
      'another try',
    );
    await tester.pump();

    expect(find.byKey(SignInPage.errorKey), findsNothing);
  });

  group('signInFailureMessage', () {
    test('never reveals whether the address exists', () {
      // The relay answers identically for an unknown address and a wrong
      // password so sign-in is not an account oracle. Copy saying "no account
      // found" would hand that back.
      final message = signInFailureMessage(
        const SigninException(SigninFailure.invalidCredentials),
      );

      expect(message.toLowerCase(), isNot(contains('no account')));
      expect(message.toLowerCase(), isNot(contains('not found')));
    });

    test('says how long a lockout has left, in readable units', () {
      expect(
        signInFailureMessage(
          const SigninException(SigninFailure.locked, retryAfterSeconds: 45),
        ),
        contains('45 seconds'),
      );
      expect(
        signInFailureMessage(
          const SigninException(SigninFailure.locked, retryAfterSeconds: 90),
        ),
        contains('2 minutes'),
      );
      // A lockout with no duration must still not read as a wrong password.
      expect(
        signInFailureMessage(const SigninException(SigninFailure.locked)),
        contains('Too many attempts'),
      );
    });

    test(
      'tells someone with a damaged backup not to reset a good password',
      () {
        // Their password was accepted. Sending them to a reset would be wrong
        // advice, and resets are not even built yet.
        expect(
          signInFailureMessage(
            const SigninException(SigninFailure.damagedBackup),
          ),
          contains('password was accepted'),
        );
      },
    );

    test('covers every failure the service can raise', () {
      for (final failure in SigninFailure.values) {
        expect(
          signInFailureMessage(SigninException(failure)),
          isNotEmpty,
          reason: failure.name,
        );
      }
    });
  });
}
