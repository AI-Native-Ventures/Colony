import 'package:buzz/features/pairing/signin_provider.dart';
import 'package:buzz/shared/theme/theme.dart';
import 'package:buzz/shared/widgets/colony_loading_indicator.dart';
import 'package:buzz/shared/widgets/frosted_app_bar.dart';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';

/// Sign in with an email address and password.
///
/// No relay field: the build already knows which relay it signs in against
/// (`accountRelayUrl`), and asking for a workspace URL is a setup step whose
/// answer we have. Invite links and pairing still carry their own relay.
class SignInPage extends HookConsumerWidget {
  const SignInPage({super.key});

  static const emailFieldKey = Key('signin-email');
  static const passwordFieldKey = Key('signin-password');
  static const submitButtonKey = Key('signin-submit');
  static const errorKey = Key('signin-error');

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final email = useTextEditingController();
    final password = useTextEditingController();
    final obscured = useState(true);
    final state = ref.watch(signInProvider);

    // A successful sign-in swaps the whole tree for the authenticated app, so
    // this page only has to stop asking for input.
    void submit() => ref
        .read(signInProvider.notifier)
        .submit(email: email.text, password: password.text);

    return Scaffold(
      body: Stack(
        children: [
          SafeArea(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(
                Grid.md,
                Grid.xxl,
                Grid.md,
                Grid.lg,
              ),
              child: Center(
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 440),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        'Sign in',
                        style: context.textTheme.headlineSmall?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(height: Grid.xxs),
                      Text(
                        'Use the email and password for your Colony account.',
                        style: context.textTheme.bodyMedium?.copyWith(
                          color: context.colors.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: Grid.md),
                      TextField(
                        key: emailFieldKey,
                        controller: email,
                        enabled: !state.isBusy,
                        keyboardType: TextInputType.emailAddress,
                        autocorrect: false,
                        autofillHints: const [AutofillHints.username],
                        textInputAction: TextInputAction.next,
                        onChanged: (_) =>
                            ref.read(signInProvider.notifier).clearError(),
                        decoration: const InputDecoration(
                          labelText: 'Email',
                          border: OutlineInputBorder(),
                        ),
                      ),
                      const SizedBox(height: Grid.sm),
                      TextField(
                        key: passwordFieldKey,
                        controller: password,
                        enabled: !state.isBusy,
                        obscureText: obscured.value,
                        autocorrect: false,
                        enableSuggestions: false,
                        autofillHints: const [AutofillHints.password],
                        textInputAction: TextInputAction.done,
                        onChanged: (_) =>
                            ref.read(signInProvider.notifier).clearError(),
                        onSubmitted: (_) => submit(),
                        decoration: InputDecoration(
                          labelText: 'Password',
                          border: const OutlineInputBorder(),
                          suffixIcon: IconButton(
                            onPressed: () => obscured.value = !obscured.value,
                            icon: Icon(
                              obscured.value
                                  ? Icons.visibility_outlined
                                  : Icons.visibility_off_outlined,
                            ),
                            tooltip: obscured.value
                                ? 'Show password'
                                : 'Hide password',
                          ),
                        ),
                      ),
                      if (state.errorMessage != null) ...[
                        const SizedBox(height: Grid.sm),
                        Text(
                          state.errorMessage!,
                          key: errorKey,
                          style: context.textTheme.bodySmall?.copyWith(
                            color: context.colors.error,
                          ),
                        ),
                      ],
                      const SizedBox(height: Grid.md),
                      FilledButton(
                        key: submitButtonKey,
                        onPressed: state.isBusy ? null : submit,
                        child: state.isBusy
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: ColonyLoadingIndicator(
                                  size: 20,
                                  semanticLabel: 'Signing in',
                                ),
                              )
                            : const Text('Sign in'),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          const FrostedAppBar(title: Text('Sign in')),
        ],
      ),
    );
  }
}
