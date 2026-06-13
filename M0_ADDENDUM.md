# M0 Addendum — scope deltas for the scaffold

> **For the parallel agent implementing M0.** This file is intentionally separate from `PLAN.md`
> to avoid edit collisions. It does **not** restate M0's existing exit criteria (workspace,
> tsconfig/tsup, vitest, CI matrix, MIT, npm name) — it adds the *architectural seams and proof
> obligations* that are cheap now and expensive to retrofit later, surfaced by the nuance audit
> (see `NUANCES.md` §9, §10). Rationale in one line: **M0's real job is proving the toolchain and
> trust posture actually work under the per-spawn `npx codesift mcp` agent flow** — not just that
> `pnpm build && pnpm test` is green locally.

Each item: **what / why it must be in M0 / concrete change / acceptance.**

---

## M0-1 — Lazy-load `sqlite-vec`; never block the lexical path on the vector native dep `[critical]`

- **Why now.** This is an architectural seam M1 will build on. The lexical/symbol/literal path
  (the grep-parity path, and the zero-model cold-start fast-path) must run even when the vector
  native prebuild is missing or broken. Today `openDatabase()` calls `sqliteVec.load(db)`
  *unconditionally* (`packages/core/src/repo.ts:384`), so a missing `sqlite-vec` binary takes the
  *entire* tool down — including queries that need no vectors at all.
- **Change.** Do **not** call `sqliteVec.load()` in `openDatabase()`. Introduce a
  `ensureVectorExtension(db)` that loads lazily on the first vector operation and caches the result;
  if the load fails, surface a structured "vector search unavailable (native dep), lexical/symbol
  still works" status rather than throwing on open. Keep the `vec_length` CHECK out of the
  always-created schema path (see M1 for the dims/migration guard).
- **Acceptance.** With `sqlite-vec` deliberately unavailable, `openRepo` + a symbol/lexical query
  succeed; only a vector query reports the degraded mode. A unit test forces the failure path.

## M0-2 — Self-gitignore the index on creation `[high]`

- **Why now.** `.codesift/index.db` stores full file `content`, i.e. a second plaintext copy of the
  source. PLAN §4.1 claims it's "gitignored by default," but **no code does this**. It's a trivial,
  unconditional correctness fix that belongs at the scaffold level so it's never missed.
- **Change.** On first `openRepo`/`sync`, write `.codesift/.gitignore` containing a single line `*`
  (the git-standard self-ignoring-directory pattern), regardless of repo `.gitignore` state.
- **Acceptance.** After `index`, `git status` in a tracked repo never lists `.codesift/`. Test
  asserts the file is written with `*`.

## M0-3 — Expand the CI native-dep matrix + clean-install smoke test `[high]`

- **Why now.** codesift hard-depends on two native modules (`better-sqlite3`, `sqlite-vec`). Under
  `npx codesift mcp` per-repo, if a prebuilt binary is missing for the user's exact Node
  ABI/platform/libc, npm silently falls back to a **node-gyp source compile** that fails on a fresh
  agent machine — and the agent sees an MCP server that won't start. The current matrix
  (`ubuntu/macos/windows-latest`, node 20) does not exercise the failure surfaces that matter.
- **Change.** Add to `.github/workflows/ci.yml`: (a) **musl/Alpine** (e.g. a `node:20-alpine`
  container job) and **Windows-ARM** if runners allow; (b) Node **20 and 22**; (c) a **clean-image
  `npx`/`npm pack` install smoke test** that installs the packed tarball on a toolchain-free image,
  runs `codesift index` + `codesift search`, and **asserts no node-gyp source build occurred** (fail
  if a compiler is invoked).
- **Acceptance.** CI is green on the expanded matrix; the smoke job fails loudly if prebuilt binaries
  aren't resolved.

## M0-4 — Network-egress / offline test on the green bar; resolve telemetry → none `[high]`

- **Why now.** codesift runs as an MCP server with read access to the user's entire source tree — a
  high-trust position. PLAN OQ#5 ("telemetry: none") is unresolved and nothing verifies that no
  dependency phones home on the **default local path**. Locking this in before any cloud/model-download
  code lands makes the posture auditable from day one.
- **Change.** Resolve OQ#5 → **none** (record in `PLAN.md` §12 / README). Add a CI job that runs
  `index` + `search` with network blocked (and/or asserts zero outbound sockets) and passes only if
  the default local path makes no network calls.
- **Acceptance.** Offline `index`+`search` succeeds; the egress assertion is part of `pnpm run ci`.

## M0-5 — Pin and document the supported Node / platform / libc matrix `[medium]`

- **Why now.** The per-spawn `npx codesift mcp` flow needs a *defined* support surface, not ABI
  roulette. `engines.node` is `>=20` but the real, tested matrix is implicit.
- **Change.** State the tested matrix explicitly in root + package `package.json` `engines` and in
  the README (OS list, libc note for Linux, Node 20/22). Keep it in sync with the CI matrix (M0-3).
- **Acceptance.** README has a "Supported platforms" table; `engines` reflects it.

## M0-6 — `lint` is a fake alias; either add a real linter or rename `[low, optional]`

- **Why now.** Every package's `"lint"` is `tsc -p tsconfig.json --noEmit` — identical to
  `"typecheck"`. The PLAN implies real linting; a no-op `lint` gives false assurance.
- **Change.** Either add a real linter (eslint/biome flat config) and wire `pnpm lint`, or drop the
  duplicate `lint` scripts and call it `typecheck` honestly. (Low priority — flag it, don't block on it.)
- **Acceptance.** `pnpm lint` does something distinct from `pnpm typecheck`, or the duplicate is removed.

---

## Note on M0 exit criteria still open (from `IMPLEMENTATION_DRIFTS.md`)

These are M0's *own* stated criteria, not new — included so M0 isn't signed off prematurely:
- npm name `codesift` + `@codesift/*` **registered/reserved** (currently only informally checked).
- GitHub Actions matrix **proven green remotely** (currently only run locally).
- Package **publish/install flow validated** (e.g. `npm pack` + install — folds into M0-3's smoke test).
