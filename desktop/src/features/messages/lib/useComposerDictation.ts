import * as React from "react";
import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { invoke, invokeRawBinary } from "@/shared/api/nativeBridge";
import type { MessageComposerProps } from "../ui/MessageComposer.types";
import { captureDictation } from "./dictationCapture";
import {
  createDictationSession,
  type DictationState,
} from "./dictationSession";

/** Insert speech as literal text, preserving formatting and the selected range. */
export function insertDictationText(
  editor: Editor,
  text: string,
  selection: { from: number; to: number },
  document: ProseMirrorNode,
) {
  if (editor.isDestroyed || !editor.state.doc.eq(document)) {
    throw new Error(
      "The draft changed while dictating. Please try again in the current draft.",
    );
  }
  const before = editor.state.doc.textBetween(
    Math.max(0, selection.from - 1),
    selection.from,
  );
  const after = editor.state.doc.textBetween(
    selection.to,
    Math.min(editor.state.doc.content.size, selection.to + 1),
  );
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s|^[.,!?;:]/.test(after) ? " " : "";
  editor
    .chain()
    .focus()
    .insertContentAt(selection, {
      type: "text",
      text: `${prefix}${text}${suffix}`,
    })
    .run();
}

/** Bind a cancellable recording to one draft and editor selection. */
export function useComposerDictation(
  editor: Editor | null,
  context: Pick<
    MessageComposerProps,
    | "draftKey"
    | "channelId"
    | "replyTarget"
    | "editTarget"
    | "typingParentEventId"
    | "typingRootEventId"
  >,
  disabled: boolean,
) {
  const scope = JSON.stringify([
    context.draftKey ?? context.channelId,
    context.channelId,
    context.replyTarget?.id,
    context.editTarget?.id,
    context.typingParentEventId,
    context.typingRootEventId,
  ]);
  const started = React.useRef(false);
  const [state, setState] = React.useState<DictationState>({
    phase: "idle",
    error: null,
    reviewed: false,
  });
  const [levels, setLevels] = React.useState<number[]>(Array(28).fill(0));
  const [seconds, setSeconds] = React.useState(0);
  const mounted = React.useRef(false);
  const latest = React.useRef({ editor, scope, disabled });
  latest.current = { editor, scope, disabled };
  const target = React.useRef<{
    editor: Editor;
    scope: string;
    selection: { from: number; to: number };
    document: ProseMirrorNode;
  } | null>(null);
  const [session] = React.useState(() =>
    createDictationSession({
      prepare: () => invoke<void>("prepare_dictation"),
      capture: (signal) =>
        captureDictation({
          signal,
          level: (value) => {
            if (mounted.current)
              setLevels((values) => [...values.slice(1), value]);
          },
          limit: () => {
            void session.stop();
          },
          failed: (message) => session.cancel(message),
        }),
      transcribe: (audio) =>
        invokeRawBinary<string>("transcribe_dictation", audio),
      insert: (text) => {
        const captured = target.current;
        if (
          !captured ||
          latest.current.disabled ||
          latest.current.scope !== captured.scope ||
          latest.current.editor !== captured.editor
        )
          return;
        insertDictationText(
          captured.editor,
          text,
          captured.selection,
          captured.document,
        );
      },
      changed: (value) => {
        if (mounted.current) setState(value);
      },
    }),
  );
  React.useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      session.cancel();
    };
  }, [session]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: context changes invalidate pending permission and transcription.
  React.useLayoutEffect(() => {
    session.cancel();
    return () => session.cancel();
  }, [editor, scope, disabled, session]);
  const active = state.phase !== "idle";
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.setEditable(!disabled && !active);
    return () => {
      if (!editor.isDestroyed) editor.setEditable(!disabled);
    };
  }, [editor, disabled, active]);
  React.useEffect(() => {
    if (state.phase !== "recording") return;
    const started = Date.now();
    const timer = setInterval(
      () => setSeconds(Math.min(60, Math.floor((Date.now() - started) / 1000))),
      250,
    );
    return () => clearInterval(timer);
  }, [state.phase]);
  const start = () => {
    if (!editor || disabled || session.busy()) return;
    started.current = true;
    const { from, to } = editor.state.selection;
    target.current = {
      editor,
      scope,
      selection: { from, to },
      document: editor.state.doc,
    };
    setLevels(Array(28).fill(0));
    setSeconds(0);
    void session.start();
  };
  const cancel = () => {
    session.cancel();
    editor?.commands.focus();
  };
  return {
    ...state,
    active,
    levels,
    seconds,
    start,
    cancel,
    stop: () => {
      void session.stop();
    },
    busy: session.busy,
    hasStarted: () => started.current,
  };
}
export type ComposerDictationControl = ReturnType<typeof useComposerDictation>;
