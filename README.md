# REFLEX Starter Pack

**The autonomy control layer for AI agents.**  
**More autonomy. Less supervision.**

This package is the implementation bootstrap for REFLEX.

## Contents

- `CLAUDE.md` — permanent engineering/product instructions for Claude Code.
- `docs/product.md` — product positioning, wedge, adoption loop and pricing hypothesis.
- `docs/architecture.md` — exact monorepo and system boundaries.
- `packages/contracts/src/index.ts` — first canonical TypeScript contracts.
- `docs/backlog.md` — implementation tickets ordered by gates.
- `docs/adr/` — architecture decision records: index, template and process.

## Development

Requires Node.js 24 (current LTS, see `.nvmrc`) and the pnpm version pinned in
`package.json#packageManager`.

```sh
pnpm install
pnpm lint        # ESLint (typed, all packages + root) and Prettier check
pnpm typecheck
pnpm test        # every package, plus repo-level integrity tests in tests/
pnpm build
pnpm format      # apply Prettier
```

Packages import each other by name and resolve to `dist/`, so Turborepo builds
a package's workspace dependencies before it lints, typechecks or tests it.
Nothing needs to be built by hand.

CI (`.github/workflows/ci.yml`) runs the same commands after
`pnpm install --frozen-lockfile`. It reports a single status check named
**Quality gates**. Mark that check as required on `main` in the GitHub branch
protection settings; a workflow file cannot make itself mandatory.

## Recommended first Claude Code prompt

```text
Read CLAUDE.md, README.md, docs/product.md, docs/architecture.md and docs/backlog.md completely.

You are implementing REFLEX, not redesigning it.

Start with Gate G0 only. Do not implement later gates.

For every ticket:
1. restate the acceptance criteria,
2. identify affected package boundaries,
3. implement the smallest complete change,
4. add tests,
5. run lint/typecheck/test,
6. update the ticket status in docs/backlog.md.

Before writing code for RFX-001, inspect the repository state and report any conflict with the documented architecture. If there is no conflict, proceed through G0 autonomously.

Do not change product semantics, decision precedence, safety fallback behavior, or package boundaries without creating an ADR and explicitly flagging the change.
```

## Development philosophy

Do not ask Claude Code to "build the whole product." Give it one gate at a time.

Recommended cycle:

1. `/clear`
2. ask Claude Code to read `CLAUDE.md` plus current gate
3. implement gate
4. run CI/evals
5. review diff
6. commit
7. move to next gate

The backlog deliberately front-loads contracts, policy semantics and safety evals before dashboard work.
