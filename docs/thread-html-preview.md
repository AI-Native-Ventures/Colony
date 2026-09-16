# Website previews and design review in artifact Blocks

This feature extends the existing artifact Block without installing another team or creating a separate job. The sections below distinguish the static fallback from the complete bundle viewer and its current proof boundaries.

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

## Complete website bundles (integration in progress)

Artifact 1.4.0 includes optional `website_bundle: {url, sha256}`. The HTTPS URL
points to a `colony.website-preview/1` manifest; the digest pins its exact bytes.
Each manifest file has a relative path, HTTPS URL, SHA-256 digest, MIME type and
byte size. The loader verifies every asset before the native viewer opens it.
The event retains its normal title, description, source/thumbnail URL, status and
revision. Historical artifacts and small static `preview_html` remain valid.

Electron dispatch and the React artifact row now mount an isolated native viewer.
Its scope includes the artifact event ID, community, thread, revision and manifest
digest. Desktop/mobile controls and expansion retain the existing channel and
adjacent thread. Preview sessions have no app preload or shared cookies.

## Exact-version design approval

A ready-for-review bundle published by the updated CLI requests attention from
its authenticated owner. `artifact.approve-design` signs a design-only scope,
revision and manifest digest, in addition to the standard pinned Block instance,
manifest and processor. The relay requires the designated human owner of that
processor. The renderer checks the signed owner action; an agent-written
`status: approved` does not establish approval. Each new revision needs its own
owner decision. No approval action publishes a site or changes DNS.

Once approved, **Download website files** exports the retained, verified browser
files in a ZIP. Its `colony-handover.json` records artifact ID, revision, manifest
digest and each file hash. An optional `source_archive` in the pinned website manifest supplies an HTTPS
URL, SHA-256 and byte size for an opaque project ZIP. It is verified before the
preview is ready, counts toward the 64 MiB total, and exports as
`source/project.zip`. The UI reports whether it was attached. Its integrity is
proven; completeness of the project still requires agent review. The exported
metadata does not yet carry the signed approval event, which remains a gap.

## Verified stages and remaining gates (2026-09-16)

- [35065425443](https://github.com/AI-Native-Ventures/Colony/actions/runs/35065425443)
  passed the React approval-to-download path through a real Electron preload,
  controller and native view. The resulting ZIP's identity and file hashes were
  checked, along with a later revision remaining unapproved. Relay, website bytes
  and native save-dialog selection were fixtures; the archive creation and file
  write were real. This does not prove production-main wiring or a packaged app.
- [35067439641](https://github.com/AI-Native-Ventures/Colony/actions/runs/35067439641)
  and its preview run passed after the CLI owner-attention correction and agent
  guidance version 8. Live adoption of the instructions remains unproven.
- [35072040699](https://github.com/AI-Native-Ventures/Colony/actions/runs/35072040699)
  passed real CLI/relay authorization: worker, wrong-revision and wrong-digest
  decisions were rejected, and the exact owner decision was persisted. No model
  inference was used.
- [35070838025](https://github.com/AI-Native-Ventures/Colony/actions/runs/35070838025)
  passed Mac packaging, relocated-app startup, signup and isolation checks on
  e3fb6988a, including the staged ZIP dependency. This predates source-archive
  support and does not exercise the native save dialog.
- Full original-source handover, approval provenance in its archive, final visual
  parity and a real agent website delivery remain outstanding.

PR 812 is a draft. None of the above constitutes merge, production deployment,
or completion of the approved Website Manager experience. CI uses deterministic
fixtures and does not purchase model inference or build a commercial website.
