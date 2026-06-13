# M5 Plan — interfaces complete (HTTP MCP · cloud providers · SDK freeze)

> **For the parallel implementation agents.** M0–M4 are landed (`git log`: through
> `34c2f10 Complete M4 freshness hardening`). This file sequences M5. Strategic context lives in
> `PLAN.md` §7 (milestone table) and §12.4–§12.5 (HTTP/daemon/provider/trust deltas). Kept separate
> from `PLAN.md` to avoid edit collisions, mirroring `M2_PLAN.md`.
>
> **Why M5:** after M4 codesift is a fresh, daemon-backed local retriever reachable over stdio MCP — but
> (1) a *second machine* can't query it (HTTP transport is a no-op scaffold), (2) there is no *learned*
> embedding path, so "semantic"/"hybrid" remains honestly unclaimable, and (3) the SDK surface and its
> docs are neither frozen nor proven. M5 closes all three so v0.1's interface contract is complete and
> M6 is purely quality/release.

## What M0–M4 already delivered (so M5 doesn't redo it)

Verified in the working tree:
- Real stdio MCP transport + daemon shim (`packages/mcp/src/index.ts`, `packages/cli/src/{daemon,mcp-shim}.ts`); 5 tools.
- `EmbeddingProvider` interface + registry (`embedding.ts`); `isLearned` gate; `getDefaultEmbeddingProvider()` honoring `CODESIFT_EMBEDDING_PROVIDER`.
- Index records `{provider_id, provider_dims, model_version, schema}` in `meta`; `IndexCompatibilityError` + guided-rebuild messaging (`repo.ts`).
- `sync({rebuild})` shadow-DB atomic swap; content-addressed embedding cache keyed by provider/dims/model/hash.
- CLI `serve` command exists but calls `ScaffoldHttpServerHandle` (a no-op); `config` prints a "lands in M5" stub.
- Zero-egress guarantee: `scripts/block-network.cjs` + `pnpm run test:offline`. **This is a hard release invariant.**

---

## The M5 work (streams; each names its files + blocker)

### M5-A — Real streamable HTTP MCP transport + bearer token  `[CRITICAL · the second-machine demo]`
- **Owner files (parallel-safe):** `packages/mcp/src/http.ts` (new), `packages/mcp/src/index.ts` (replace
  `ScaffoldHttpServerHandle` only), `packages/mcp/test/http.test.ts` (new). **Do NOT touch the CLI** — the
  integrator wires `serve`.
- **Now.** `ScaffoldHttpServerHandle.start()` returns `undefined`; `codesift serve` prints "Scaffold HTTP
  server ready" and serves nothing. No second machine can connect.
- **Build.** Implement `createHttpServer(repo, {host,port,token})` over the MCP SDK
  `StreamableHTTPServerTransport` (`@modelcontextprotocol/sdk/server/streamableHttp.js` — verify exact
  export) wrapping the same `createSdkServer(repo)` used by stdio (one tool registry, no duplication).
  Bind `127.0.0.1` by default. If `token` is set, require `Authorization: Bearer <token>` on every
  request; reject missing/wrong tokens with HTTP 401 **using a constant-time compare** (`crypto.timingSafeEqual`
  over equal-length buffers; never short-circuit on length). Expose `start()`/`stop()` that actually
  listen/close; surface the bound address. Route all logs to stderr.
- **Accept.** `http.test.ts` starts the handle on an ephemeral port and over real HTTP runs
  `initialize → tools/list → tools/call(search_code)`; asserts a tool result. A second case asserts 401
  when a token is configured and the header is absent/wrong, and success when correct. No reliance on the CLI.

### M5-B — Cloud embedding providers (Voyage, OpenAI) + secret-scan/redaction  `[CRITICAL · the learned path]`
- **Owner files (parallel-safe):** `packages/core/src/providers/voyage.ts` (new),
  `packages/core/src/providers/openai.ts` (new), `packages/core/src/secret-scan.ts` (new),
  `packages/core/src/embedding.ts` (extend: register the two providers + a `registerCloudProviders()`/lazy
  hook), `packages/core/src/index.ts` (add exports for the new public symbols),
  `packages/core/test/providers.test.ts` (new). **Do NOT touch `repo.ts`** — the integrator wires the
  secret-scan gate into `sync()`.
- **Now.** Only `lexical-v1` (zero-vector) and `local-hash-v1` (fixture) exist; both `isLearned=false`.
  No learned provider, so "semantic" is correctly unclaimable and there is no cloud egress path at all.
- **Build.**
  1. `VoyageEmbeddingProvider` (`id:'voyage-code-3'`, `isLearned:true`, `dims:1024`, model `voyage-code-3`)
     and `OpenAIEmbeddingProvider` (`id:'openai-text-embedding-3-small'`, `isLearned:true`, `dims:1536`).
     Each reads its key from env (`VOYAGE_API_KEY` / `OPENAI_API_KEY`) **lazily inside `embedBatch`**, calls
     the embeddings REST endpoint via `globalThis.fetch`, respects `maxBatch`/`maxBatchTokens`, maps the
     `role` to the provider's `input_type`/equivalent, and returns `Float32Array[]`. Throw a clear,
     actionable error when the key is missing. **No network at import time** and **no network unless
     `embedBatch` is actually called** — the default local path must never reach these.
  2. `secret-scan.ts`: `scanSecrets(text): SecretFinding[]` (high-precision patterns: AWS keys, GitHub/Slack
     tokens, private-key PEM blocks, generic `*_API_KEY=...`/`Bearer <jwt>`, high-entropy assignments) and
     `redactSecrets(text): string`. Pure, deterministic, no network.
  3. A small `prepareForCloud(texts, {allowSecrets})` helper the integrator can call before any cloud send:
     if findings exist and `!allowSecrets` → throw an error naming the file/line shape and instructing
     `--allow-secrets`; if `allowSecrets` → return redacted texts.
- **Accept.** `providers.test.ts`: (a) with `globalThis.fetch` stubbed, both providers shape the correct
  request (URL, auth header, model, batch) and parse vectors of the right `dims`; (b) missing-key throws;
  (c) `scanSecrets` flags planted secrets and ignores ordinary code; (d) `prepareForCloud` refuses without
  `allowSecrets` and redacts with it. **Importing the module triggers zero network** (covered by the
  offline gate in integration).

### M5-C — `config` + provider resolution + `--rebuild`/`--allow-secrets` flow  `[CRITICAL · glue · integrator/main-thread only]`
- **Owner files (shared — main thread after the parallel barrier):** `packages/core/src/config.ts` (new),
  `packages/core/src/repo.ts`, `packages/core/src/index.ts` (`openRepo` options), `packages/core/src/types.ts`,
  `packages/cli/src/program.ts`, `packages/cli/src/daemon.ts` (pass options through), tests in
  `packages/core/test/` + `packages/cli/test/`.
- **Build.**
  1. `.codesift/config.json` read/write: `{ provider?, model?, ignore?, allowSecrets? }`. Provider
     resolution precedence: explicit `openRepo(root,{providerId})` > `CODESIFT_EMBEDDING_PROVIDER` env >
     `config.json` > `lexical-v1` default. `openRepo` accepts an options arg; `SqliteRepo` resolves and
     records the provider accordingly (today it hardcodes `getDefaultEmbeddingProvider()`).
  2. CLI `config get|set <key> [value]` reads/writes `config.json` (replaces the M5 stub). Setting
     `provider` to a value whose `dims`/`id` differ from the indexed `meta` must surface the existing
     `IndexCompatibilityError` guidance and tell the user to `codesift index --rebuild`.
  3. `index --rebuild` already exists; ensure the provider-switch path round-trips (old index → set
     provider → rebuild → status shows new provider/dims). Add `--allow-secrets` to `index` and thread it
     to the cloud send via M5-B's `prepareForCloud`. Wire the secret-scan gate into `repo.sync()` so it
     runs **only** on the cloud (learned-provider) send path, never on the local path.
  4. Wire CLI `serve` to M5-A's real `createHttpServer` (remove the "Scaffold" wording; print the bound
     address + whether a token is required).
- **Accept.** Round-trip test: default index → `config set provider voyage-code-3` → `status`/search across
  a switch raises compatibility guidance → `index --rebuild` (with a stubbed provider) → `status` reports
  the new provider/dims. `--allow-secrets` gate test. `serve` smoke (spawn → HTTP round-trip via the CLI).
  **`pnpm run test:offline` still passes** (no egress on the default path).

### M5-D — SDK API freeze + typedoc + documented quickstart  `[HIGH · the SDK contract]`
- **Owner files (parallel-safe):** `typedoc.json` (new), `docs/sdk.md` (new),
  `packages/core/test/sdk-quickstart.test.ts` (new). **Do NOT edit root `package.json`, `README.md`, or
  `packages/core/src/index.ts`** — *report* the exact `package.json` script/devDep additions and any export
  gaps for the integrator to apply.
- **Build.** A `typedoc.json` targeting `@codesift/core`'s public entry. A `docs/sdk.md` quickstart that
  matches the SDK exactly (`openRepo`, `sync`, `search`, `grep`, `findSymbol`, `readChunk`, `status`,
  `watch`, `registerEmbeddingProvider`). A `sdk-quickstart.test.ts` that **executes the quickstart against
  a temp repo** so the documented snippet is proven, not aspirational (build a tiny repo, `openRepo`,
  `sync`, `search`, assert a hit; offline/local provider only).
- **Accept.** The quickstart test passes; typedoc config builds the API reference; the integrator adds the
  `docs`/devDep wiring reported by this stream.

---

## M5 exit criteria (the demo)

1. A **second machine** (or a second process) connects to `codesift serve` over streamable HTTP, with and
   without a bearer token, and runs the 5 tools.
2. A **learned** embedding provider (Voyage or OpenAI) is configurable; switching providers triggers the
   guided `--rebuild`; the cloud send is secret-scanned and refuses without `--allow-secrets`.
3. The **SDK quickstart** runs exactly as documented (proven by a test); typedoc reference builds.
4. **Zero-egress invariant holds:** `pnpm run test:offline` and the network-egress block still pass; the
   default `index`/`search`/`sym`/`status` path makes no network calls.
5. `pnpm run ci` is green (build · typecheck · test · test:offline · bench).

## Parallelization (what to fan out vs serialize)

- **Parallel (disjoint files, no builds inside the agents):** M5-A (`packages/mcp/**`),
  M5-B (`packages/core/src/providers/**` + `secret-scan.ts` + `embedding.ts` + core `index.ts` exports),
  M5-D (`typedoc.json` + `docs/` + a core test). These never touch the same file.
- **Serial / main-thread (collision-prone glue):** M5-C touches `program.ts`, `repo.ts`, `index.ts`,
  `types.ts`, `daemon.ts` — done after the parallel barrier so it integrates A's HTTP handle and B's
  providers/secret-scan, then runs the full gate.
- **Suggested order:** fan out A+B+D → integrate C + wiring + exports → run `pnpm run ci` → adversarial
  review (bearer-token timing-safety, secret-scan coverage, offline-path purity) → update `README.md`,
  `PLAN.md` §12, `IMPLEMENTATION_DRIFTS.md`.

## Decisions recorded for M5

- **`vec0` stays in M6, not M5.** PLAN §12.8 gates the `vec0`/ANN move on a learned provider becoming a
  *default-supported* path. M5's cloud providers are **opt-in**, so the blob-column vector arm remains the
  v0.1 backend. When a learned provider is configured, `index_status` continues to report the vector mode
  honestly; the documented 50k/100k crossover is unchanged. Migrating `vec0` is the first M6 retrieval task.
- **Telemetry remains none**; cloud egress happens **only** on an explicitly-configured learned provider's
  `embedBatch`, after secret-scan, and is excluded from the offline/default path by construction.
