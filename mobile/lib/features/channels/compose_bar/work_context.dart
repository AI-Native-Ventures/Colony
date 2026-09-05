part of '../compose_bar.dart';

/// Which conversation's task this composer is about.
///
/// A DM is one thread for its whole life, so it is keyed by the conversation
/// and never by a root; a channel timeline has no thread yet, so its scope is
/// not addressable and nothing task-shaped is offered there.
ThreadTaskScope _composeBarTaskScope(
  WidgetRef ref, {
  required String channelId,
  required String? threadRoot,
}) {
  final isConversation =
      ref
          .watch(channelsProvider)
          .value
          ?.any((channel) => channel.id == channelId && channel.isDm) ??
      false;
  return ThreadTaskScope(
    channelId: channelId,
    conversationScope: isConversation,
    threadRoot: isConversation ? null : threadRoot,
  );
}

/// A failed send, in the words the failure already used.
///
/// A [WorkContextError] carries a sentence written for the person sending, so
/// it is shown as-is; anything else is a transport failure with no wording of
/// its own.
String _formatSendError(Object error) {
  if (error is WorkContextError) return error.message;
  final message = error.toString().replaceFirst('Exception: ', '');
  return message.isEmpty ? 'That message could not be sent.' : message;
}
