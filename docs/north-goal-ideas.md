# codesift north-goal ideas

This is a forward-looking idea stack for the product north goal:

1. Fewer agent tool calls.
2. Less token output.
3. More accurate context.
4. Onboarding that feels close to zero setup.

This document is not a committed implementation plan. It is a prioritization map
for the next set of bets after the one-call structural-search moat described in
[`docs/moat.md`](./moat.md).

## Current signal

The current benchmark already shows the one-call direction is working:

- Median calls-to-resolution are `1.0` for every query type in the checked eval.
- Warm latency is faster than `rg` across the benchmark because the daemon/index
  path is amortized.
- Concept and identifier accuracy are stronger than `rg` in the benchmark.
- Remaining losses are mostly cold latency, plus token losses on concept and
  exact-identifier cases.
- The live MCP surface is powerful but broad: `search_code`, `find_symbol`,
  `find_callers`, `find_refs`, `find_importers`, `who_implements`, `impact`,
  `grep_code`, `read_chunk`, and `index_status`. That breadth can increase agent
  routing mistakes and onboarding friction.

So the next frontier is less about proving that one-call resolution is possible
and more about making the right one call obvious, compact, fresh, and automatic.

## Principles

- Make the common path one decision, not one tool among many.
- Prefer structured context over larger context.
- Spend tokens only when they remove a follow-up call or prevent a wrong edit.
- Make freshness implicit; expose health checks only when they are useful.
- Keep the default path local, offline, and trustable.
- Add model/network features only behind explicit proof and explicit user choice.
- Measure real agent loops, not only deterministic tool routing.

## Highest-leverage bets

### 1. Add a front-door `ask_code` tool

Give agents one default tool that accepts a natural task and internally chooses
search, symbol lookup, grep, or graph traversal.

Why it helps:

- Fewer schema tokens in the default client surface.
- Fewer tool-choice mistakes.
- Easier onboarding: "ask Codesift about this repo" instead of teaching a
  routing table.
- A single place to encode confidence, ambiguity, freshness, and next-action
  policy.

Possible response contract:

```text
answer_complete=yes
confidence=high
intent=symbol_definition
tool_path=find_symbol
next=none

= src/auth/token.ts:5-18 parseToken
5 | export function parseToken(...) {
...
```

When the answer is not complete:

```text
answer_complete=no
confidence=medium
intent=ambiguous_symbol
next=choose_candidate
ambiguous=3 defs
```

The existing specialist tools should remain available, but `ask_code` should be
the default path in MCP instructions and onboarding docs.

### 2. Stop default status preflight calls

The current MCP instructions still encourage checking `index_status`. That can
burn a call before the actual work starts.

Better default:

- If the repo is unindexed and safe to index, auto-index on first real query.
- If the index is stale, return stale/freshness metadata with normal results.
- If sync is running, either wait briefly or return compact partial results with
  `freshness=syncing`.
- Keep `index_status` as a diagnostic tool, not a required agent ritual.

This turns "check status, then search" into "search, with health attached."

### 3. Offer a minimal MCP toolset by default

Ten tools are useful for power users, but expensive for agents and new users.

Default toolset:

- `ask_code`
- `read_chunk`
- `index_status`

Advanced toolset:

- Current specialist tools, enabled with something like `--toolset all`.

Alternate compromise:

- Collapse relation tools into one `code_graph` tool with `mode=callers|refs|
  importers|implements|impact`.

The goal is not to remove capability. It is to shrink the first screen and the
first agent decision.

### 4. Add confidence and next-action metadata everywhere

Agents need to know when to stop. Today they can receive a good inline body and
still spend another call verifying it.

Every result formatter should be able to communicate:

- `answer_complete=yes|no`
- `confidence=high|medium|low`
- `next=none|read_chunk|choose_candidate|narrow_query|sync`
- `freshness=fresh|stale|syncing|unknown`
- `ambiguity=<count>` when relevant
- `omitted=<count>` when budget clipped useful context

This should be terse and machine-friendly. It is a token cost that prevents more
expensive token and tool-call waste downstream.

### 5. Make output adaptive, not just capped

The current token losses suggest some default bodies are larger than needed.

Adaptive output policies:

- Exact symbol: return signature plus the smallest body slice that covers the
  likely answer; full body only when small or explicitly requested.
- Concept search: return the relevant slice first, with a compact enclosing
  symbol header; full body only when confidence that the whole body matters is
  high.
- Literal/error search: stay very compact by default, since current grep output
  already beats `rg` on token count.
- Relations/impact: return a compact graph first, then expandable ids.
- Repeated files: group or compress repeated headers only when the formatter can
  prove it saves tokens without hurting copy/paste location clarity.

Possible option:

```text
context=auto|min|body|graph
```

`auto` should optimize for one-call resolution under the default budget.

### 6. Prewarm the daemon path

Cold latency is the broadest remaining benchmark loss. Warm path is already the
strong story.

Ideas:

- `codesift daemon start` for users who want a persistent local sidecar.
- `codesift init` writes client config that points at a warm HTTP server when
  appropriate.
- Longer idle timeout for repos used in active agent sessions.
- Cheap daemon health probe that avoids loading the heavy path just to discover
  the daemon is alive.
- Benchmark first MCP result separately for: process spawn, daemon connect,
  repo open, SQLite ready, first query.

The product goal should be "first useful answer feels instant after setup", not
just "warm query is fast in isolation."

### 7. Build one-command onboarding

Add a guided `codesift init` command.

It should:

- Check Node version and native SQLite compatibility.
- Install or verify the index.
- Run a tiny smoke query against the current repo.
- Offer to write MCP config snippets for supported clients.
- Explain local/offline trust posture in one line.
- Print two repo-specific example queries based on detected symbols/files.
- Tell the user whether a daemon/HTTP sidecar is running.

Add `codesift doctor` for failure recovery:

- Node version mismatch.
- Native module ABI mismatch.
- Missing `rg` for eval/dev flows.
- Corrupt or incompatible index.
- Cloud provider selected without key.
- Secrets blocking cloud embedding.

The first experience should be: install, run init, ask a question.

### 8. Measure real agent loops

The eval harness is much more honest now, but routing is still deterministic.
The next eval should simulate real agent behavior.

Add tasks like:

- "Where is this auth behavior enforced?"
- "What breaks if I change this function?"
- "Find the implementation behind this stack trace."
- "Update this code safely."
- "Why does this validation reject this input?"

Track:

- Tool calls to final answer.
- Tokens to final answer.
- Whether the first tool choice was correct.
- Whether the agent stopped after enough context.
- Wrong edit rate or wrong-file rate.
- Recovery cost after ambiguous or stale results.

This will tell whether `ask_code`, confidence metadata, and minimal toolsets
actually reduce agent waste.

### 9. Expand accuracy coverage before semantic defaults

Useful additions:

- Paraphrase goldens for each concept query.
- Multi-file "answer set" goldens beyond same-name collisions.
- Relation goldens for callers, refs, importers, implementers, and impact.
- Stack trace and error-message goldens.
- Large-repo fixtures that stress ranking and token budgets.
- "False friend" fixtures where docs, tests, generated files, and interfaces
  contain the same words as the real implementation.

Do not ship a default semantic arm just because concept search is important.
Ship it when expanded eval proves it beats the lexical/ranking stack without
hurting cold start, onboarding, privacy, or rebuild cost.

### 10. Keep relation bundles opt-in until they have budgets

Relation context is a strong one-call lever, especially for "what breaks if I
change X?" But default relation expansion can become expensive.

Good next step:

- Keep `with_callers` / graph context opt-in.
- Add hard candidate, time, and token budgets.
- Measure saved calls and missed relation files.
- Promote relation bundles into `ask_code` only for intents that clearly need
  them.

## Prioritized roadmap

### P0: tighten the current surface

- Sync README/docs with the live tool list.
- Fix the current symbol precision loss.
- Add `answer_complete`, `confidence`, and `next` metadata to formatters.
- Change MCP instructions so `index_status` is diagnostic, not preflight.
- Add token-budget tests for adaptive exact-symbol and concept responses.

### P1: make the first call obvious

- Build `ask_code` as the default MCP front door.
- Add a minimal default toolset and an advanced toolset.
- Implement `codesift init` and `codesift doctor`.
- Generate MCP config snippets for common clients.

### P2: reduce token and cold-start losses

- Add adaptive context modes.
- Slice bodies around query-relevant lines before full-body fallback.
- Add daemon prewarm/service flow.
- Instrument cold path into spawn/connect/open/query phases.

### P3: broaden the moat

- Add real agent-loop eval.
- Add relation and impact eval gates.
- Run gated learned/reranker A/Bs on expanded concept goldens.
- Consider a default local learned arm only if it clears accuracy, latency,
  trust, and onboarding gates.

## Ideas to avoid for now

- Do not default to cloud embeddings or cloud reranking.
- Do not expose more top-level tools as the onboarding answer.
- Do not auto-bundle callers/usages for every result without strict budgets.
- Do not optimize only the benchmark if it makes the first user experience more
  complicated.
- Do not replace `rg`; keep it as the known-literal fallback and win on
  structural context.

## Success metrics

Product metrics:

- Time from install to first successful answer.
- Percentage of users who complete setup without reading extra docs.
- Number of commands required for first useful MCP answer.
- Number of support/debug paths caught by `doctor`.

Agent metrics:

- Median tool calls to resolution.
- Median tokens to resolution.
- First-tool correctness.
- Stop-after-sufficient-context rate.
- Wrong-file and wrong-edit rate.

Engine metrics:

- Warm first-result latency.
- Cold first-result latency split by phase.
- Token loss count by query type.
- Precision loss count.
- Recall on multi-target and relation tasks.

The north-star version: a new user runs one command, asks one question, and the
agent receives enough fresh, accurate context to act without another search.
