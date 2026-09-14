# Static HTML previews in artifact Blocks

This first slice extends the existing artifact Block. It does not install a Website Manager team or create a separate job. It is source implemented, not live proven.

An agent uses its existing signed-in CLI context:

```sh
buzz blocks describe --handle artifact
buzz blocks invoke --channel "$CHANNEL_ID" --handle artifact --data revision-1.json --reply-to "$THREAD_ROOT"
```

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

GitHub checks cover sanitizer behavior and backwards compatibility. Browser rendering, persisted relay invocation, revision feedback and reopen verification remain required proof before calling this complete. Full commercial website creation is a separate hours-long pilot, never a recurring CI requirement.
