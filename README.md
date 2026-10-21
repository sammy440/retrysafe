# retrysafe

> What happens if this handler runs twice, or stops halfway?

Static analysis for Node/TypeScript webhook handlers and queue workers. See
[README-retrysafe.md](README-retrysafe.md) for the full vision, architecture, and roadmap.

## Status

Phases 1–11 of the [roadmap](README-retrysafe.md#build-phases) are built. Not yet: the docs site and
playground (Phase 12), and publishing to npm. The runtime library `@retrysafe/guard` lives in its own
package (developed in a separate `retrysafe-backend` directory); the safe patterns are in
[docs/patterns.md](docs/patterns.md).

- **Discovery:** Express (mounted routers, `router.route()`, `app.use` middleware), Fastify (routes,
  `route()`, plugins with prefixes, preHandler hooks), Next.js App Router and Pages API routes, server
  actions (opt-in), BullMQ, Bull, AWS Lambda event handlers (SQS, SNS, EventBridge, Kinesis, DynamoDB
  Streams, S3), `sqs-consumer`, Probot. Monorepos load per workspace package with their own tsconfig.
- **Effects:** JSON packs in [packages/core/catalog](packages/core/catalog) with source links: Stripe,
  Paystack, Flutterwave, Prisma, Drizzle, Knex, Mongoose, `pg`/`mysql2`, Redis, nodemailer, Resend,
  SendGrid, Postmark, Mailgun, Twilio, Slack, BullMQ/Bull, Inngest, Trigger.dev, AWS SDK v3 commands,
  GitHub (Octokit/Probot), Shopify GraphQL (`@idempotent`), and outbound HTTP classified by API host.
- **Guards:** Redis `SET NX`, unique inserts (Prisma, SQL, Drizzle, Knex, Mongoose, DynamoDB conditional
  puts), lookups (flagged non-atomic), idempotency keys, middleware, configured helpers; transactions,
  try/catch, switch scoping, and condition polarity.
- **Schema awareness:** Prisma schema, SQL migrations, Drizzle tables, Mongoose schemas decide whether a
  processed-events insert is backed by a unique constraint.
- **Rules (16):** see `retrysafe rules`. Each finding has a failing sequence, a fix, and a code snippet
  for the library in use.
- **Adoption:** `retrysafe.config.ts`, `init`, `explain`, baselines, inline suppressions with reasons.
- **Codemods:** `retrysafe fix` (dry run; `--write` to apply) adds idempotency keys and job ids derived
  from the event or job id, answers permanent failures with 400, and with `--guard <module>#<export>`
  wraps handlers in `guard.run(eventKey…)`, moving Prisma/pg writes onto the transaction client.
- **Guard library awareness:** `@retrysafe/guard` (`guard.run`, `withGuard`, `withGuardRoute`,
  `withGuardJob`) is recognized without configuration.
- **Output and CI:** terminal, JSON, Markdown, SARIF, GitHub annotations; `--changed`/`--staged`;
  a [GitHub Action](packages/action) and a [pre-commit hook](.pre-commit-hooks.yaml).
- **`retrysafe verify` (experimental):** loads a handler with catalog libraries stubbed, delivers the
  event twice (retry, concurrent duplicate, and a crash before each effect), and marks static findings
  confirmed when it reproduces the duplicate or the lost event.

Control flow is analyzed structurally over the AST (blocks, branches, early exits, try/catch, switch,
loops) rather than with an explicit CFG graph; this covers structured TypeScript, which has no goto.

## Development

```sh
corepack pnpm install        # or: npx pnpm@9.15.0 install
pnpm test                    # vitest: fixtures, guard/schema/adoption tests, dynamic verify
pnpm lint                    # biome
pnpm typecheck
pnpm build                   # bundles the CLI to packages/cli/dist
pnpm retrysafe fixtures/express-basic --effect-map
```

Run `retrysafe --help` for all commands and options.

### Layout

```
packages/core/catalog   provider and library packs (JSON, with source links)
packages/core/src
  project/     loader (tsconfig, aliases) and symbol resolution
  discovery/   entry-point detectors: express, fastify, next, queues, serverless, probot, server actions
  effects/     catalog loader, classifiers (SQL, HTTP, GraphQL), query builders, AWS commands
  schema/      Prisma / SQL migration / Drizzle / Mongoose unique-constraint readers
  guards/      guard primitives and condition polarity
  analysis/    interprocedural walker (effects, guards, checks per handler)
  rules/       one file per rule
packages/cli   `retrysafe` command (verify/ holds the dynamic verification runtime and stubs)
packages/action  composite GitHub Action
fixtures/      small projects; mark expected findings inline with `// expect: <rule>`,
               list expected handlers in expected.json
```
