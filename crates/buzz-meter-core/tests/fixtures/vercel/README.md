# Vercel AI Gateway captures (2026-08-08)

Real responses captured verbatim from `https://ai-gateway.vercel.sh/v1/chat/completions`
on 2026-08-08, using a Vercel AI Gateway API key scoped to the `ai-native-ventures`
project (team `basheers-projects-d36c90c8`). Requests are not included — only
responses; no secrets are in these files.

## What the captures show (the billing contract)

1. **Vercel injects its own `usage` object; it does not pass the provider's
   through.** Every capture carries `cost`, `market_cost`, `gateway_cost`,
   `is_byok`, `cost_details`, `cache_creation_input_tokens`, and
   `prompt_tokens_details`/`completion_tokens_details` — Vercel's shape, not
   DeepInfra's or OpenAI's.
2. **Cost appears in the body only.** Neither the streaming nor the
   non-streaming response carries anything cost-related in its headers
   (`x-vercel-id`, `x-vercel-cache`, `x-matched-path` are the interesting
   ones). A header-borne cost does not exist for this shape.
3. **`usage.cost` is a float USD** (`3.72e-06`), alongside **integer**
   `prompt_tokens` / `completion_tokens` / `total_tokens` in the same object,
   with `is_byok: false`. The shared parser's recognized-shape gate therefore
   passes: the stated cost is kept, never dropped.
4. **The streaming terminal chunk carries the full usage object**, cost
   included, without `stream_options.include_usage` having been requested.
5. A second cost representation exists: `provider_metadata.gateway.cost` (a
   **string**, `"0.00000372"`) plus `generationId` on the choice delta and at
   the top level. The shared parser ignores both; `usage.cost` is the number
   the ledger uses.
6. Failed calls return `providerMetadata.gateway.routing` (attempts, provider
   names, errors) in the error body, with no cost — an error must never settle.

## Files

- `chat_completions_nonstream.json` — `alibaba/qwen-3-14b` (DeepInfra), HTTP 200.
- `chat_completions_stream.sse` — same model, `stream: true`, HTTP 200.
- `chat_completions_stream_gpt4o_mini.sse` — `openai/gpt-4o-mini` (OpenAI),
  `stream: true`, HTTP 200 — same shape across a second provider.
- `headers_nonstream.txt` / `headers_stream.txt` — full response header sets
  for the first two captures.

## Re-capturing

Needs a gateway key (`vercel ai-gateway api-keys create --name <name>`), then:

```bash
curl -s -D - https://ai-gateway.vercel.sh/v1/chat/completions \
  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" -H 'Content-Type: application/json' \
  -d '{"model":"alibaba/qwen-3-14b","messages":[{"role":"user","content":"Reply with the single word: fixture"}],"max_tokens":8,"temperature":0}'
```

Add `"stream": true` for the SSE capture. If the shape has drifted, these
tests fail and the drift is the finding.
