import '../nostr_models.dart';
import 'canonical_json.dart';
import 'company_action.dart';
import 'company_receipt.dart';

/// Submitting an owner-signed Company Action and resolving what the relay did
/// with it.
///
/// Publishing is not applying. The relay validates a company action after it
/// accepts the event, so a caller that treated a successful publish as a
/// successful write would report "done" for actions the relay went on to
/// refuse. The outcome is read out of the relay's own receipt instead.

/// What one submission resolved to.
sealed class CompanyActionOutcome {
  const CompanyActionOutcome();
}

/// The relay applied the action and named the head it produced.
class CompanyActionApplied extends CompanyActionOutcome {
  final String receiptEventId;
  final String headEventId;
  final String target;

  const CompanyActionApplied({
    required this.receiptEventId,
    required this.headEventId,
    required this.target,
  });
}

/// The relay answered and refused: `rejected`, `conflict`, or `failed`.
class CompanyActionRefused extends CompanyActionOutcome {
  final String outcome;
  final String receiptEventId;
  final String target;
  final String message;

  const CompanyActionRefused({
    required this.outcome,
    required this.receiptEventId,
    required this.target,
    required this.message,
  });
}

/// The action was published and may still be applied, but no receipt arrived
/// in time. Retrying with the same idempotency key is safe; saying "failed"
/// would invite a duplicate request.
class CompanyActionNoReceipt extends CompanyActionOutcome {
  final String actionEventId;
  final String message;

  const CompanyActionNoReceipt({
    required this.actionEventId,
    required this.message,
  });
}

/// An earlier attempt at this exact action already won the idempotency claim.
/// The goal state was reached a different way, and the winner's own receipt
/// names what it was answered with.
class CompanyActionSuperseded extends CompanyActionOutcome {
  final String actionEventId;
  final String winnerEventId;
  final String message;

  const CompanyActionSuperseded({
    required this.actionEventId,
    required this.winnerEventId,
    required this.message,
  });
}

/// The relay's exact wording for a duplicate idempotency claim that a
/// different event already won (`broker_duplicate_result` in
/// `buzz-relay/handlers/ingest.rs`).
///
/// A wire-message pattern rather than a structured field, because there is no
/// structured field to read: a NIP-01 `OK` frame is four bare elements, so the
/// message text is the only signal that distinguishes this case from any other
/// refusal.
final _supersededPattern = RegExp(
  r'conflict: superseded by original action ([0-9a-f]{64})',
);

/// The winning event's id when [error] is that refusal, otherwise null.
String? supersededWinnerEventId(Object? error) =>
    _supersededPattern.firstMatch('$error')?.group(1);

/// Publishes signed company actions and waits for the relay's answer.
class CompanyActionBroker {
  final Future<NostrEvent> Function(NostrEvent event) _publish;
  final Future<NostrEvent?> Function(NostrFilter filter) _fetchFirstEvent;
  final Future<String?> Function() _relaySelf;
  final Future<void> Function(Duration delay) _delay;
  final int _attempts;
  final Duration _interval;

  CompanyActionBroker({
    required Future<NostrEvent> Function(NostrEvent event) publish,
    required Future<NostrEvent?> Function(NostrFilter filter) fetchFirstEvent,
    required Future<String?> Function() relaySelf,
    Future<void> Function(Duration delay)? delay,
    int attempts = 20,
    Duration interval = const Duration(milliseconds: 400),
  }) : _publish = publish,
       _fetchFirstEvent = fetchFirstEvent,
       _relaySelf = relaySelf,
       _delay = delay ?? Future<void>.delayed,
       _attempts = attempts,
       _interval = interval;

  /// Publish [signedAction] and resolve the relay's receipt for it.
  ///
  /// [action] is the envelope the event was built from; the receipt is only
  /// believed when its request and idempotency keys are the ones submitted, so
  /// a receipt for some other action in flight cannot be mistaken for this
  /// one's answer.
  Future<CompanyActionOutcome> submit(
    NostrEvent signedAction,
    CompanyAction action,
  ) async {
    final relaySelfPubkey = await _relaySelf();
    if (relaySelfPubkey == null || relaySelfPubkey.isEmpty) {
      throw StateError(
        "This community's relay has no stable identity, so it cannot answer a "
        'company action.',
      );
    }

    try {
      await _publish(signedAction);
    } catch (error) {
      final winner = supersededWinnerEventId(error);
      if (winner != null) {
        return CompanyActionSuperseded(
          actionEventId: signedAction.id,
          winnerEventId: winner,
          message:
              'This exact change was already applied by an earlier '
              'attempt.',
        );
      }
      rethrow;
    }

    final actionEventId = signedAction.id;
    for (var attempt = 0; attempt < _attempts; attempt += 1) {
      final receipt = await readReceipt(relaySelfPubkey, actionEventId);
      if (receipt != null &&
          receipt.requestId == action.requestId.toLowerCase() &&
          receipt.idempotencyKey == action.idempotencyKey.toLowerCase()) {
        if (receipt.outcome == 'applied') {
          return CompanyActionApplied(
            receiptEventId: receipt.receiptEventId,
            headEventId: receipt.headEventId!,
            target: receipt.target,
          );
        }
        return CompanyActionRefused(
          outcome: receipt.outcome,
          receiptEventId: receipt.receiptEventId,
          target: receipt.target,
          message: receipt.outcome == 'conflict'
              ? 'This record changed while the request was in flight.'
              : 'The relay refused this company change.',
        );
      }
      if (attempt < _attempts - 1) await _delay(_interval);
    }

    return CompanyActionNoReceipt(
      actionEventId: actionEventId,
      message:
          'The relay has not answered this company change yet. Trying '
          'again is safe.',
    );
  }

  /// The relay's receipt for one already-published action, or null.
  ///
  /// Also the superseded path's only route to an answer: the winning action's
  /// id is known, but this client never saw its receipt.
  Future<CompanyReceipt?> readReceipt(
    String relaySelfPubkey,
    String actionEventId,
  ) async {
    final candidate = await _fetchFirstEvent(
      NostrFilter(
        kinds: const [EventKind.companyReceipt],
        authors: [relaySelfPubkey],
        tags: {
          '#e': [actionEventId],
        },
        limit: 1,
      ),
    );
    if (candidate == null) return null;
    return parseCompanyReceipt(candidate, relaySelfPubkey, actionEventId);
  }

  /// The head one applied action produced, or null when it did not apply.
  Future<String?> headForAction(String actionEventId) async {
    final relaySelfPubkey = await _relaySelf();
    if (relaySelfPubkey == null || relaySelfPubkey.isEmpty) return null;
    final receipt = await readReceipt(
      relaySelfPubkey,
      normalizeHex(actionEventId),
    );
    return receipt?.outcome == 'applied' ? receipt?.headEventId : null;
  }
}
