# Static HTML previews in artifact Blocks

This first slice extends the existing artifact Block. It does not install a Website Manager team or create a separate job. It is source implemented, not live proven.

An agent uses its existing signed-in CLI context:

```sh
buzz blocks describe --handle artifact
buzz blocks invoke --channel "$CHANNEL_ID" --handle artifact --data revision-1.json --reply-to "$THREAD_ROOT" --processor "$AGENT_PUBKEY"
```

`AGENT_PUBKEY` is the actual agent identity responsible for the artifact's signed actions; the artifact manifest requires this processor even for static previews.

`revision-1.json` contains the usual artifact fields plus `preview_html` and `revision`. The `url` is the actual uploaded source file URL, not an invented deployment. Example payload structure (replace the example source URL):

```json
{
  "title": "Homepage draft",
  "description": "First static layout for your feedback.",
  "url": "https://example.com/replace-with-uploaded-source.html",
  "alt": "Homepage source",
  "status": "ready-for-review",
  "revision": 1,
  "preview_html": "<!doctype html><style>body{font-family:system-ui;padding:32px}h1{color:teal}</style><h1>A clearer homepage</h1><p>Ready for your feedback.</p>"
}
```

The preview bytes persist inside the ordinary Block data. A reply requests a change. The agent publishes a second artifact in the same thread with `revision: 2`, changed HTML and `previous_artifact` set to the exact first artifact message event ID. The prior message is not edited or removed. This first slice labels versions; it does not yet provide a consolidated version picker.

Only the verified core artifact manifest opts into this renderer. Older artifacts without `preview_html` retain existing behavior. The HTML limit is 20,000 characters and the normal overall Block byte limit still applies. Oversized content must not be silently truncated.

The preview is static HTML/CSS. A blank iframe sandbox, restrictive child CSP and element/attribute allowlists disable scripts, forms, navigation, external assets and network calls. Desktop/mobile controls change the viewport; Expand opens the preview in a dialog. This is a layout review, not a functional form or JavaScript application test. Reopening renders saved data without asking an agent to rebuild it.

GitHub run [34859212549](https://github.com/AI-Native-Ventures/Colony/actions/runs/34859212549) passed sanitizer behavior, backwards compatibility, TypeScript, browser rendering, a second revision in the thread, and closing/reopening the thread with both versions visible. These browser checks use the mock native/relay bridge and signed fixture events; they do not prove relay persistence or agent execution. Real CLI invocation and desktop reopening against a real relay remain required before calling this complete. Full commercial website creation is a separate hours-long pilot, never a recurring CI requirement.


## Next acceptance gate: real agent integration

Use an existing authorized test community and thread with the updated core artifact manifest and desktop renderer. First inspect `buzz blocks describe --handle artifact`; if `preview_html` is absent, the relay has not adopted the manifest and this gate cannot run against that deployment yet.

Have the existing agent publish a small static artifact through `buzz blocks invoke`, using its real uploaded source URL. Record the returned event ID and open that exact thread in the desktop. Request a heading change in the same thread, retain the first artifact and publish a second with its predecessor event ID. Close and reopen the thread, then restart the client and reopen it to distinguish in-memory rendering from relay persistence. Verify both versions and the changed heading. Record the actual app build and relay deployment alongside the two event IDs.

No paid model call is part of CI. This gate is a separate supervised runtime exercise; it must not silently reuse the cancelled PR 691 paid proof workflow. Passing it still does not prove the full approved Website Manager workflow or a commercial website rebuild.
