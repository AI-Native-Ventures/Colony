import 'package:buzz/shared/relay/company/company_task.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nostr/nostr.dart' as nostr;

import 'company_fixtures.dart';

void main() {
  test('direct task parses and replies without a team reference', () {
    final relay = nostr.Keys.generate();
    final event = signedTaskHead(keys: relay, owningTeamId: null);
    final task = parseTaskHead(event, relay.public);
    expect(task, isNotNull);
    expect(task!.owningTeamId, isNull);
    expect(task.assigneePersonaIds, ['persona-cto']);
    expect(task.workContextTags, [
      ['task', task.id],
    ]);
  });

  test('existing team tasks retain their team reference', () {
    final relay = nostr.Keys.generate();
    final task = parseTaskHead(signedTaskHead(keys: relay), relay.public);
    expect(task, isNotNull);
    expect(task!.workContextTags, contains(['team', 'team-coordination']));
  });
}
