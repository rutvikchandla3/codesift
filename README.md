# codesift

Local-first hybrid code search for repositories, delivered as one TypeScript core with three thin interfaces:

- `codesift` CLI
- `@codesift/core` SDK
- `@codesift/mcp` server

## Status

Milestone 0 scaffold is in place. The repo now has:

- pnpm workspace layout
- shared TypeScript + tsup build setup
- Vitest test harness
- GitHub Actions CI on macOS, Linux, and Windows
- MIT licensing
- package names aligned to the chosen `codesift` brand

The next milestone is M1: the walking skeleton for scan → chunk → embed → store → search.

## Workspace

```text
packages/
  core/   @codesift/core
  cli/    codesift
  mcp/    @codesift/mcp
  eval/   private eval harness
```

## Commands

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

See `PLAN.md` for the full product plan.
