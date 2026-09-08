import assert from "node:assert/strict";

/** Project only the exact issued shell result; never accept unrelated history. */
export function readFixtureShellResult(messages, toolCallId) {
  const matches = messages.filter(
    (message) => message.role === "tool" && message.tool_call_id === toolCallId,
  );
  assert.equal(
    matches.length,
    1,
    "Exactly one result for the issued shell call",
  );
  const clean = (value) =>
    String(value ?? "")
      .replace(/(?:nsec|ncryptsec)1[a-z0-9]+/gi, "[redacted-key]")
      .replace(/[a-f0-9]{64}/gi, "[redacted-key]")
      .replace(/\b(?:Bearer|Basic)\s+\S+/gi, "[redacted-authorization]")
      .replace(/\b[a-z]+:\/\/[^\s]*@[^\s]*/gi, "[redacted-credential-url]")
      .slice(0, 2048);
  let shell;
  try {
    shell = JSON.parse(matches[0].content);
  } catch {
    return {
      toolCallId,
      accepted: false,
      format: "unstructured",
      diagnostic: clean(matches[0].content),
    };
  }
  let cli;
  try {
    cli = JSON.parse(shell.stdout);
  } catch {
    /* A failed shell or non-JSON CLI output remains a failed gate. */
  }
  return {
    toolCallId,
    exitCode: shell.exit_code,
    timedOut: shell.timed_out,
    accepted: cli?.accepted === true,
    eventId: /^[a-f0-9]{64}$/.test(cli?.event_id ?? "") ? cli.event_id : null,
    message: clean(cli?.message),
    stderr: clean(shell.stderr),
    stdoutJson: cli !== undefined,
  };
}
