# retrysafe

> What happens if this handler runs twice, or stops halfway?

Static analysis for Node/TypeScript webhook handlers and queue workers. See
[README-retrysafe.md](README-retrysafe.md) for the full vision, architecture, and roadmap.

## Status

Early prototype. Working end to end:

- **Discovery:** Express routes (including `app.use` mounted routers), Next.js App Router `route.ts` and
  Pages API routes, BullMQ `new Worker(...)`, Bull `queue.process(...)`. HTTP routes count as
  at-least-once when the path looks like a webhook or the handler verifies a signature.
- **Effects:** Stripe, Prisma, `pg`/`mysql2` (SQL text classified), Redis counters, nodemailer, Resend,
  SendGrid, Postmark, Twilio, BullMQ `add`, followed through your own functions (default depth 6).
- **Guards:** Redis `SET NX`, inserts into processed-events tables, `ON CONFLICT DO NOTHING` + row-count
  check, lookup-then-early-exit via Prisma/SQL/Redis `GET` (flagged as non-atomic), provider idempotency
  keys, configured wrappers. Transactions, later "marker" writes, and claim releases in `catch` blocks
  are tracked, and key expressions are traced back to their sources.
  The condition's polarity is checked, so `if (!user) return 404` is not mistaken for a dedupe check.
- **Rules (Phase 5 set):** `unguarded-side-effect`, `record-before-effect-no-tx`, `effect-before-record`,
  `nondeterministic-key`, `effect-missing-idempotency-key`. Each finding has a failing sequence, a fix,
  and a code snippet of the safe pattern.
- **Output:** terminal report with effect maps, JSON, Markdown.

Guard coverage is approximated structurally (a guard covers the rest of its block, or the branch it
gates); the CFG/dominance analysis in Phase 4 replaces this.

## Development

```sh
corepack pnpm install        # or: npx pnpm@9.15.0 install
pnpm test                    # vitest: fixture snapshots + guard mutation tests
pnpm typecheck
pnpm build                   # bundles the CLI to packages/cli/dist
pnpm retrysafe fixtures/express-basic --effect-map
```

CLI options: `--handlers`, `--effect-map`, `--format terminal|json|markdown`, `--project <tsconfig>`,
`--max-depth <n>`, `--min-confidence low|medium|high`, `--ci`.

### Layout

```
packages/core/src
  project/     loader (tsconfig, aliases) and symbol resolution
  discovery/   entry-point detectors: express, next, queues
  effects/     declarative effect catalog + idempotency classification
  guards/      guard primitives and condition polarity
  analysis/    interprocedural walker (effects, guards, checks per handler)
  rules/       one file per rule
packages/cli   `retrysafe` command
fixtures/      small projects; mark expected findings inline with `// expect: <rule>`,
               list expected handlers in expected.json
```
