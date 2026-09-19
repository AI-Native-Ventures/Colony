/// Email and password sign-in state for the onboarding surface.
///
/// Sign-in is the primary way onto a phone. Pairing stays for the case it
/// actually serves: moving an identity that already exists on a desktop, where
/// no password ever derived it.
library;

import 'package:buzz/shared/auth/auth.dart';
import 'package:http/http.dart' as http;
import 'package:hooks_riverpod/hooks_riverpod.dart';

/// Overridden in tests. The real client is closed with the provider.
final signInHttpClientProvider = Provider<http.Client>((ref) {
  final client = http.Client();
  ref.onDispose(client.close);
  return client;
});

/// The key derivation sign-in uses. Overridden in widget tests, which cannot
/// afford 600,000 real rounds per pump and have no platform channel to serve
/// them anyway.
final signInKdfProvider = Provider<PasswordKdf>(
  (ref) => const PlatformPasswordKdf(),
);

enum SignInStatus { idle, submitting, success }

class SignInState {
  const SignInState({
    this.status = SignInStatus.idle,
    this.errorMessage,
    this.retryAfterSeconds = 0,
  });

  final SignInStatus status;
  final String? errorMessage;
  final int retryAfterSeconds;

  bool get isBusy => status == SignInStatus.submitting;
}

class SignInNotifier extends Notifier<SignInState> {
  @override
  SignInState build() => const SignInState();

  /// Sign in and, on success, adopt the identity as the active community.
  Future<void> submit({required String email, required String password}) async {
    if (state.isBusy) return;
    final trimmedEmail = email.trim();
    if (trimmedEmail.isEmpty || password.isEmpty) {
      state = const SignInState(
        errorMessage: 'Enter your email address and password.',
      );
      return;
    }

    state = const SignInState(status: SignInStatus.submitting);
    try {
      final account = await signInWithPassword(
        email: trimmedEmail,
        password: password,
        client: ref.read(signInHttpClientProvider),
        kdf: ref.read(signInKdfProvider),
      );
      final community = Community.create(
        name: accountApiOrigin().host,
        relayUrl: accountRelayUrl,
        pubkey: account.pubkey,
        nsec: account.nsec,
      );
      await ref
          .read(authProvider.notifier)
          .authenticateWithCommunity(community);
      state = const SignInState(status: SignInStatus.success);
    } on SigninException catch (failure) {
      state = SignInState(
        errorMessage: signInFailureMessage(failure),
        retryAfterSeconds: failure.retryAfterSeconds,
      );
    } catch (_) {
      // Storage or identity adoption failed after a good answer. Saying
      // "check your connection" would be a lie, and a raw error says nothing
      // anyone can act on.
      state = const SignInState(
        errorMessage: 'Signed in, but this device could not save the account.',
      );
    }
  }

  /// Clear a failure so the next keystroke does not argue with stale copy.
  void clearError() {
    if (state.errorMessage != null) state = const SignInState();
  }
}

final signInProvider = NotifierProvider<SignInNotifier, SignInState>(
  SignInNotifier.new,
);

/// Copy for each failure the service distinguishes.
///
/// Every string is something the reader can act on. None of them leaks whether
/// the address exists: the relay answers identically for an unknown address
/// and a wrong password precisely so that sign-in is not an account oracle,
/// and saying "no account found" here would undo that.
String signInFailureMessage(SigninException failure) {
  switch (failure.failure) {
    case SigninFailure.invalidCredentials:
      return 'That email and password do not match.';
    case SigninFailure.locked:
      final seconds = failure.retryAfterSeconds;
      if (seconds <= 0) return 'Too many attempts. Try again shortly.';
      final minutes = (seconds / 60).ceil();
      return seconds < 60
          ? 'Too many attempts. Try again in $seconds seconds.'
          : 'Too many attempts. Try again in $minutes '
                '${minutes == 1 ? 'minute' : 'minutes'}.';
    case SigninFailure.unreachable:
      return 'Could not reach Colony. Check your connection and try again.';
    case SigninFailure.updateRequired:
      return 'This version of Colony is too old to open your account. '
          'Update the app and try again.';
    case SigninFailure.damagedBackup:
      return 'Your password was accepted, but this account could not be '
          'opened on this device. Contact support rather than resetting it.';
  }
}
