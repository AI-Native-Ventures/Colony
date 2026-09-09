# One-reply teammate model selection

### Per-message teammate model requests

An owner may attach `["agent-reply", "1", "<teammate-pubkey>", "<canonical-model-id>"]`
(as a JSON string array) to a kind-9 message. The target must also be an explicit
`p` recipient. At most one request is allowed; edits and other kinds reject it.
The canonical ID is copied from the runtime catalog, including an advertised
`[reasoning-effort]` suffix when present. Unknown, malformed or unsupported
choices reject rather than falling back.

This selects one addressed teammate's reply to this one signed message. The ACP
host checks the message signer against that teammate's owner, queues the message
separately, and never injects it into a running turn. Other recipients retain their
own defaults. The host applies the selection to a temporary session and requires
successful runtime acknowledgement before prompting; a timeout is an error. It
preserves the ordinary conversation session and does not persist agent, channel,
thread, provider, billing route or worker changes. A runtime may advertise
`_meta.colony.closeSessionMethod = "_colony/session/close"` on `session/new` to
release the idle temporary session afterward.

The message UI describes these tags as *requested*. The `reply_model_applied`
observer frame records the acknowledged canonical choice for the actual turn;
telemetry never authorizes a request. Runtime/provider execution and an end-user
reply remain separate proof from that acknowledgement.

For adapters without a confirmed close operation, the host limits unclosed
temporary sessions to eight per process. Further scoped requests fail visibly
without altering the ordinary session; default replies remain available. A
normal process restart clears that resource count. This bounds unsupported
session cleanup rather than silently allocating until the adapter fails.
