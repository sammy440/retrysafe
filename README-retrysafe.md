# retrysafe

> Static analysis for handlers that run more than once. retrysafe finds the Node/TypeScript webhook handlers, queue workers, and serverless consumers in your codebase, maps every side effect they cause, and tells you which ones would double-charge, double-email, or silently drop an event when a retry arrives.

**Status:** Planning. This README doubles as the project roadmap and architecture document.
**Name:** `retrysafe` is a placeholder. Check npm and GitHub availability before committing to it.
**License:** MIT

---

## Table of Contents

1. [The Problem](#the-problem)
2. [Vision](#vision)
3. [How It Works](#how-it-works)
4. [Feature Overview](#feature-overview)
5. [Architecture](#architecture)
6. [Tech Stack](#tech-stack)
7. [Build Phases](#build-phases)
8. [Rule Catalog](#rule-catalog)
9. [Effect Catalog](#effect-catalog)
10. [Guard Patterns](#guard-patterns)
11. [Configuration Reference](#configuration-reference)
12. [CLI Reference](#cli-reference)
13. [Report Format](#report-format)
14. [Hard Problems](#hard-problems)
15. [Testing Strategy](#testing-strategy)
16. [Distribution and Positioning](#distribution-and-positioning)
17. [Novelty Check Before You Build](#novelty-check-before-you-build)
18. [Decisions to Settle Early](#decisions-to-settle-early)

---

## The Problem

Webhook providers and message queues deliver at-least-once. That means your handler will eventually run twice for the same event: a timeout, a deploy mid-request, a retry after a slow response, a manual "resend" button.

What happens next depends on code nobody tests:

- The handler charges a card, sends an email, or credits a balance, and does it again on the retry.
- Two copies arrive at the same instant, both pass a "have I seen this?" check, and both proceed.
- The handler records the event as processed, then crashes before doing the work. The retry is skipped as a duplicate and the event is lost.
- The handler does the work, then crashes before recording it. The retry does the work again.
- An error is caught, logged, and answered with a 200, so the provider never retries and the event is lost.
- A deduplication key is built from `Date.now()` or a fresh UUID, so every retry gets a new key and nothing is ever deduplicated.

These are design bugs, not syntax bugs. They look fine in review and pass every ordinary test.

## Vision

retrysafe reads your code the way an experienced reviewer would when asking one question: **"What happens if this runs twice, or stops halfway?"**

1. **Finds the handlers for you.** It discovers webhook routes, queue workers, and serverless consumers instead of asking you to list them.
2. **Maps effects.** It resolves calls through your own code to find what each handler really does: database writes, payments, emails, queue publishes.
3. **Understands guards.** It recognizes dedupe checks, unique-constraint inserts, idempotency keys, and transactions, and checks that they actually protect each effect and in the right order.
4. **Explains the fix.** Every finding says what can go wrong, shows the failing sequence, and shows the safe pattern.

## How It Works

```
your repo
   │
   ▼
[1] Load             TypeScript program + tsconfig + package manifests
   │                 (+ prisma/drizzle schema and SQL migrations if present)
   ▼
[2] Discover         find at-least-once entry points
   │                 (Express/Fastify routes, Next.js route handlers,
   │                  BullMQ workers, SQS/Lambda handlers, ...)
   ▼
[3] Resolve          walk the call graph from each entry point,
   │                 through your own functions, to a bounded depth
   ▼
[4] Classify         tag each call as an effect (db write, payment, email,
   │                 enqueue, ...) using the effect catalog;
   │                 mark idempotent vs non-idempotent
   ▼
[5] Detect guards    find dedupe checks, unique inserts, idempotency keys,
   │                 transactions, and where they sit in the control flow
   ▼
[6] Analyze          control-flow rules: does a guard dominate each effect?
   │                 what order? what happens on exception paths?
   ▼
findings: rule, severity, confidence, failing sequence, suggested fix
```

## Feature Overview

### Analysis engine (the core)
- Automatic discovery of at-least-once handlers across common frameworks
- Interprocedural effect resolution through your own code (bounded depth)
- Declarative effect catalog (libraries and methods mapped to effect kinds)
- Guard detection: processed-event tables, unique-constraint inserts, Redis `SET NX`, idempotency keys, transactions
- Control-flow analysis: guard dominance, ordering, exception paths, early responses
- Schema awareness: reads Prisma/Drizzle schema and SQL migrations to know whether an insert is protected by a unique constraint
- Key-derivation analysis: flags keys built from non-deterministic values or from the wrong event field

### Reporting
- Terminal, JSON, Markdown, and SARIF output
- Per-handler **effect map** showing each effect and whether it is protected
- Severity and confidence levels on every finding
- Suggested fix and a minimal failing sequence for each finding

### Adoption tools
- Baseline file for existing codebases (only new problems fail CI)
- Inline suppressions with required reasons
- Config to teach it your own guard helpers and effect wrappers

### Integrations
- GitHub Action with PR annotations
- Pre-commit hook

### Later
- Optional runtime guard library (`@retrysafe/guard`) implementing the safe pattern
- Codemods for the most common fixes
- Experimental dynamic verification: run a handler twice against stubbed effects and compare

## Architecture

### Monorepo layout

```
retrysafe/
├── packages/
│   ├── core/          # project loader, call graph, CFG, dominance, rule engine
│   ├── frameworks/    # entry-point detectors (express, fastify, next, bullmq, sqs)
│   ├── effects/       # effect catalog + provider packs (stripe, paystack, ...)
│   ├── schema/        # prisma / drizzle / SQL migration readers
│   ├── rules/         # one file per rule, each with docs and fixtures
│   ├── cli/           # `npx retrysafe`
│   ├── action/        # GitHub Action
│   ├── guard/         # optional runtime library (later phase)
│   └── web/           # docs + playground
├── fixtures/          # good and bad handlers, one set per rule
├── pnpm-workspace.yaml
└── README.md
```

### Design rules

- **Rules never match raw text.** They operate on resolved symbols and control flow, so renamed imports and wrapper functions still work.
- **Everything is declarative where possible.** Entry-point detectors, effect catalog entries, and guard patterns are data users can extend.
- **Unknown is a first-class result.** When a call cannot be resolved, it becomes an `unknown-effect` with low confidence instead of being ignored or guessed.
- **Every finding carries a failing sequence.** For example: "request A inserts order, crashes; retry B finds no record, inserts a second order."

### Core data model

```ts
interface Handler {
  id: string;
  kind: "http-webhook" | "queue-worker" | "serverless" | "server-action";
  framework: string;
  location: SourceLocation;
  provider?: string;              // stripe, paystack, shopify, github, ...
  middleware: Middleware[];       // guards may live here
}

interface Effect {
  kind: "db-write" | "payment" | "email" | "sms" | "enqueue" | "http-call" | "file-write" | "unknown";
  idempotent: boolean | "unknown";
  location: SourceLocation;
  acceptsIdempotencyKey?: KeySpec;   // e.g. Stripe's idempotencyKey option
  path: SourceLocation[];            // call chain from the handler
}

interface Guard {
  kind: "unique-insert" | "redis-setnx" | "lookup-then-insert" | "idempotency-key" | "transaction" | "middleware";
  keySource: KeySource;              // where the dedupe key comes from
  atomic: boolean;                   // true if unique-constraint-backed
  location: SourceLocation;
}

interface Finding {
  rule: string;
  severity: "error" | "warning" | "info";
  confidence: "high" | "medium" | "low";
  handler: string;
  effect?: Effect;
  failingSequence: string[];
  fix: string;
}
```

## Tech Stack

| Layer | Choice |
|---|---|
| Language | TypeScript |
| Package manager | pnpm workspaces |
| Build | tsup |
| Code analysis | TypeScript compiler API, optionally wrapped by `ts-morph` |
| Control flow | A small CFG built over the TS AST (branches, early returns, try/catch, await points) |
| Schema parsing | Prisma schema parser, Drizzle schema via TS AST, SQL via a Postgres parser |
| Config | Zod-validated `retrysafe.config.ts` |
| Tests | Vitest |
| Web | Next.js, Tailwind CSS |

## Build Phases

### Phase 1: Foundation
**Goal:** load a real project and walk its code.

- [ ] Monorepo scaffold, shared tsconfig, lint, Vitest
- [ ] Project loader: tsconfig resolution, monorepo workspaces, path aliases
- [x] Symbol resolution through imports, re-exports, and aliases
- [ ] Fixture set: small Express, Fastify, and Next.js projects with known good and bad handlers
- [x] Snapshot-style test harness comparing findings against expected output

**Done when:** the loader resolves calls across files in every fixture project.

### Phase 2: Entry-point discovery
**Goal:** find the handlers automatically.

- [x] Express: `app.post/put/patch`, `router.*`, mounted routers
- [ ] Fastify: route registration, plugins, schema-based routes
- [ ] Next.js: App Router `route.ts` exports (`POST`, `PUT`), Pages API routes, server actions
- [x] BullMQ and Bull: `new Worker(...)`, `queue.process(...)`
- [ ] SQS and Lambda handler signatures
- [ ] Signals: path contains `webhook`, signature verification calls, provider SDK event parsing
- [ ] Manual override in config (`handlers: [...]`)

**Done when:** every handler in the fixtures is found, and ordinary non-webhook routes are not flagged as at-least-once.

### Phase 3: Effect catalog and classification
**Goal:** know what each handler actually does.

- [ ] Catalog format (YAML or JSON) with module, callee, kind, idempotency, key support
- [ ] Database packs: Prisma, Drizzle, Knex, `pg`, Mongoose
- [ ] Provider packs: Stripe, plus the payment and messaging providers listed in the effect catalog
- [ ] Interprocedural walk: follow calls through your own functions to a bounded depth
- [ ] Classify SQL and ORM calls as idempotent or not (upsert, `ON CONFLICT`, increment, plain insert)
- [ ] Unknown-effect handling for unresolved calls

**Done when:** each fixture handler produces a complete, correct effect list.

### Phase 4: Guards and control flow
**Goal:** understand whether effects are protected, and in what order.

- [ ] CFG construction per function, including try/catch and early returns
- [ ] Dominance analysis: does a guard dominate an effect on every path?
- [ ] Guard detectors for each pattern (see Guard Patterns)
- [ ] Key-source tracking: trace the dedupe key back to its origin (header, `event.id`, payload field, `Date.now()`, `uuid()`)
- [ ] Middleware-level guards applied to a route
- [ ] Transaction scope tracking

**Done when:** the analyzer correctly distinguishes protected from unprotected effects in all fixtures.

### Phase 5: Core rules and reporting
**Goal:** the first useful release.

- [x] Implement rules: `unguarded-side-effect`, `effect-before-record`, `record-before-effect-no-tx`, `nondeterministic-key`, `effect-missing-idempotency-key`
- [x] Failing-sequence generator for each rule
- [x] Terminal report with the effect map
- [x] JSON and Markdown output
- [x] Fix suggestions with code snippets

**Done when:** a developer can run the tool on a real Express or Next.js project and get findings they recognize as real.

### Phase 6: CLI, config, and adoption
**Goal:** usable on a real, messy codebase.

- [ ] `retrysafe`, `retrysafe init`, `retrysafe explain <finding>`
- [ ] Config file with custom guards, effects, and ignored paths
- [ ] Baseline file (`--update-baseline`) so existing issues do not block CI
- [ ] Inline suppression with required reason
- [ ] SARIF output
- [ ] Publish to npm and verify `npx retrysafe` works

**Done when:** it can be dropped into an existing repo without producing an unusable wall of findings.

### Phase 7: Schema awareness
**Goal:** know whether the database really protects against duplicates.

- [ ] Prisma schema reader (`@@unique`, `@unique`, relations)
- [ ] Drizzle schema reader (unique indexes and constraints)
- [ ] SQL migration reader (unique indexes created by migrations)
- [ ] Use schema facts in guard detection: a processed-events insert is only atomic if the key column is unique
- [ ] Rule: `check-then-insert-race` (lookup then insert with no unique constraint behind it)

**Done when:** "insert into processed_events" is correctly judged protected or unprotected based on the real schema.

### Phase 8: More rules and provider packs
- [ ] `swallowed-error-returns-2xx`, `permanent-error-returns-5xx`
- [ ] `ack-timing` (response sent before or after work, relative to platform limits)
- [ ] `wrong-event-field-as-key` (object id used instead of event id)
- [ ] `incrementing-write-unguarded`, `non-atomic-multi-write`, `retry-loop-with-effect`
- [ ] `queue-add-without-job-id`, `dedupe-ttl-short`
- [ ] Provider packs for Paystack, Flutterwave, Shopify, GitHub, Twilio, SendGrid, Resend, nodemailer
- [ ] Info-level rule: `order-dependence-assumed`

### Phase 9: CI integration
- [ ] GitHub Action with PR annotations on the exact lines
- [ ] Only analyze handlers affected by the diff
- [ ] Pre-commit hook

### Phase 10: Fixes
- [ ] Optional `@retrysafe/guard` library: transactional processed-events guard for Postgres, Redis store
- [ ] Codemods that wrap a handler with the guard and extract the correct event id
- [ ] Documentation of the safe patterns

### Phase 11: Dynamic verification (experimental)
- [ ] Run a handler twice with a recorded payload against stubbed effects (module interception for DB, email, payment clients)
- [ ] Compare the effect logs of run one and run two
- [ ] Mark static findings as "confirmed" when the dynamic run reproduces the duplicate

### Phase 12: Docs, playground, launch
- [ ] Docs site: one page per rule with the failing sequence, why it happens, and the fix
- [ ] Playground: paste a handler, see the effect map and findings
- [ ] Demo GIF
- [ ] Benchmark on open-source projects; report real findings

## Rule Catalog

| Rule | Detects | Default severity |
|---|---|---|
| `unguarded-side-effect` | A non-idempotent effect (payment, email, plain insert, increment) with no guard on every path to it | error |
| `check-then-insert-race` | Reads a processed-events table, then inserts separately, with no unique constraint or transaction. Two concurrent duplicates can both pass the check | error |
| `record-before-effect-no-tx` | Event marked as processed, then effects run outside the same transaction with no rollback. A crash in between loses the event | error |
| `effect-before-record` | An external effect runs before the event is recorded. A crash between the two causes a duplicate effect | warning |
| `nondeterministic-key` | Dedupe or idempotency key derived from `Date.now()`, `Math.random()`, or `uuid()` inside the handler, so each retry gets a new key | error |
| `wrong-event-field-as-key` | Key derived from the object id (for example the resource inside the event) rather than the event id. Distinct events can share the same object id | warning |
| `effect-missing-idempotency-key` | A call whose SDK supports an idempotency key (payments, transfers) made without one derived from the event | warning |
| `swallowed-error-returns-2xx` | A catch block logs the error and responds 200, so the provider never retries and the event is lost | error |
| `permanent-error-returns-5xx` | Validation or bad-payload failures answered with 5xx, causing endless retries | warning |
| `ack-timing` | Response sent before async work completes (work may be cut off on serverless) or long synchronous work before the response (provider timeout triggers retries) | warning |
| `incrementing-write-unguarded` | `x = x + n`, ORM `increment`, array push inside a handler with no guard | error |
| `non-atomic-multi-write` | Several dependent writes with no transaction, so a partial failure plus retry leaves inconsistent state | warning |
| `retry-loop-with-effect` | In-code retry (loop, `p-retry`) around a non-idempotent call without a stable key | warning |
| `queue-add-without-job-id` | Enqueuing jobs from a handler with no job id for deduplication | info |
| `dedupe-ttl-short` | Processed-event keys expire sooner than the provider's retry window (configurable per provider) | warning |
| `order-dependence-assumed` | Handler applies state changes without checking a version or timestamp, assuming events arrive in order | info |

Each rule ships with: description, failing sequence template, safe pattern, fixtures, and a docs page.

### Why the first four rules matter together

Two opposite mistakes are both common, and a naive "add a dedupe check" fix swaps one for the other:

- Record first, then do the work: safe against duplicates, but a crash loses the event (`record-before-effect-no-tx`).
- Do the work first, then record: safe against loss, but a crash causes a duplicate (`effect-before-record`).

The safe pattern for database effects is to insert the event id (unique constraint) in the **same transaction** as the writes. For external effects (email, payment), use the provider's idempotency key derived from the event id, or an outbox. retrysafe checks which situation each handler is in.

## Effect Catalog

Declarative entries, extendable in config:

```yaml
- match: { module: "stripe", callee: "paymentIntents.create" }
  kind: payment
  idempotent: false
  acceptsKey: { arg: 1, field: idempotencyKey }

- match: { module: "@prisma/client", callee: "*.create" }
  kind: db-write
  idempotent: false          # unless a unique constraint makes it so (schema-aware)

- match: { module: "@prisma/client", callee: "*.upsert" }
  kind: db-write
  idempotent: true

- match: { module: "nodemailer", callee: "*.sendMail" }
  kind: email
  idempotent: false
```

### Provider and library packs (planned)

| Area | Packs |
|---|---|
| Payments | Stripe, Paystack, Flutterwave |
| Commerce and dev platforms | Shopify, GitHub |
| Messaging | Twilio, SendGrid, Resend, nodemailer |
| Databases | Prisma, Drizzle, Knex, `pg`, Mongoose |
| Queues | BullMQ, Bull, AWS SQS and SNS |

Verify each provider's retry behavior and idempotency-key support against its own documentation when writing its pack; the catalog should link to the source.

## Guard Patterns

| Pattern | Recognized as | Atomic? |
|---|---|---|
| `INSERT ... ON CONFLICT DO NOTHING` on a processed-events table with a unique key | `unique-insert` | Yes |
| Insert that catches a unique-violation error and treats it as a duplicate | `unique-insert` | Yes (if the constraint exists in the schema) |
| Redis `SET key value NX` | `redis-setnx` | Yes |
| `findUnique` / `SELECT` then `create` / `INSERT` | `lookup-then-insert` | **No** (race) |
| Provider idempotency key option on the call | `idempotency-key` | Yes (on that call only) |
| Wrapper or middleware listed in config (`withIdempotency(...)`) | `middleware` / custom | Trusted |
| Database transaction around guard and writes | `transaction` | Scope-limited |

## Configuration Reference

Example `retrysafe.config.ts`:

```ts
import { defineConfig } from "retrysafe";

export default defineConfig({
  include: ["src/**", "app/**"],
  exclude: ["**/*.test.ts"],

  handlers: {
    discover: true,
    add: ["src/jobs/send-invoice.ts#handler"],     // force-mark as at-least-once
    ignore: ["src/routes/health.ts"],
  },

  guards: [
    { callee: "withIdempotency", keyArg: 0, atomic: true },
    { callee: "dedupe.once", keyArg: 0, atomic: true },
  ],

  effects: {
    extend: [
      { match: { module: "@/lib/billing", callee: "chargeCustomer" }, kind: "payment", idempotent: false },
    ],
  },

  providers: {
    stripe: { retryWindowHours: 72 },     // check the provider docs and adjust
  },

  analysis: { maxCallDepth: 6, minConfidence: "medium" },

  baseline: ".retrysafe-baseline.json",

  rules: {
    "unguarded-side-effect": "error",
    "order-dependence-assumed": "off",
  },
});
```

Config resolution order: CLI flags, then project config, then defaults.

## CLI Reference

```
retrysafe                         Analyze the project
retrysafe --handlers              List discovered handlers only
retrysafe --effect-map            Show the effect map for each handler
retrysafe explain <finding-id>    Failing sequence, why it happens, and the fix
retrysafe init                    Create a starter config
retrysafe --update-baseline       Record current findings as accepted
retrysafe --format sarif          Machine-readable output for code scanning
retrysafe --ci                    Non-zero exit on new findings above threshold
retrysafe verify <handler>        (experimental) run twice against stubbed effects
```

## Report Format

Example terminal output:

```
retrysafe: 2 handlers need attention (6 discovered)

POST /api/webhooks/stripe        app/api/webhooks/stripe/route.ts:12
  Effect map
    ✔ verify signature                 route.ts:18
    ✖ db-write   prisma.order.create    route.ts:31   no guard on this path
    ✖ email      sendReceipt()          lib/mail.ts:9 (via route.ts:36)  no guard
    ✔ payment    stripe.refunds.create  route.ts:48   idempotency key from event.id

  ✖ unguarded-side-effect  (error, high confidence)
      Failing sequence:
        1. Stripe delivers evt_1; handler creates order #1, sends receipt
        2. Response times out; Stripe retries evt_1
        3. Handler creates order #2 and sends a second receipt
      Fix: insert event.id into a processed_events table with a unique constraint,
           in the same transaction as the order write; skip when the insert conflicts.

  ✖ record-before-effect-no-tx  (error, medium confidence)  route.ts:24
      Failing sequence:
        1. Event recorded as processed
        2. Process crashes before the order is written
        3. Retry finds the record and skips; the order is lost

Worker  queue "invoices"          src/jobs/invoices.ts:8
  ⚠ nondeterministic-key  (error, high confidence)  invoices.ts:21
      Idempotency key built from Date.now(); each retry gets a different key.
      Fix: derive the key from job.id or the invoice id.

4 handlers clean. 3 findings suppressed by baseline.
```

## Hard Problems

| Problem | Approach |
|---|---|
| Effects hidden behind dependency injection or service layers | Resolve through types where possible; fall back to config-declared effects; report `unknown-effect` at low confidence |
| Guards implemented in custom helpers | Config lets users declare guard helpers; infer common shapes automatically |
| Middleware applied far from the route | Track `app.use` and route-level middleware chains |
| Dynamic routing and generated handlers | Allow manual handler registration; accept some misses |
| False positives wear out trust | Confidence levels, baseline file, required suppression reasons, conservative defaults |
| Unique constraints live in the database, not the code | Read Prisma, Drizzle, and SQL migrations; treat unknown schemas as unknown, not as protected |
| Provider behavior changes over time | Keep provider facts in data files with source links, not in rule logic |
| Cross-file analysis cost on large monorepos | Cache the TypeScript program, analyze only handlers reachable from changed files in CI |
| Async and await ordering | Model await points explicitly in the CFG |
| Mutual exclusion outside the code (locks, single-worker queues) | Config option to declare handlers as serialized; document the assumption |
| TypeScript-only coverage | Start with TS/JS; keep the core language-agnostic in design |

## Testing Strategy

- **Rule fixtures:** for every rule, a "bad" handler that must produce the finding and a "good" handler that must produce none.
- **Mutation tests:** take a correct handler, delete its guard, and assert the analyzer flags it; add the guard back and assert the finding clears. Do the same with reordering (record-before and record-after).
- **Discovery tests:** every framework fixture lists its expected handlers; also include ordinary routes that must not be treated as at-least-once.
- **Schema tests:** the same handler passes or fails depending on whether the schema has a unique constraint.
- **False-positive corpus:** a set of well-written real handlers (from docs and open-source projects) that must stay clean.
- **Real-world benchmark:** run on popular open-source Node projects and record genuine findings.
- **CI:** Linux, macOS, Windows; current and previous Node LTS.

## Distribution and Positioning

- **npm:** publish `core`, `cli`, and packs; `npx retrysafe` runs with no install.
- **README lead line:** "What happens if this handler runs twice, or stops halfway?"
- **Demo GIF:** a Stripe webhook handler that sends two emails, found and explained.
- **Launch post:** the two opposite failure modes ("record first loses events, work first duplicates them") with real examples. This is the kind of write-up developers share.
- **Open-source outreach:** report real findings as issues or PRs to projects you analyze.
- **Where to share:** Hacker News (Show HN), r/node, dev.to, X.
- **Natural pairing:** a runtime test tool that replays duplicates and out-of-order events can confirm what retrysafe flags statically.

## Novelty Check Before You Build

What my searches found:

- Plenty of guides and agent skills that teach the idempotency patterns.
- A PHP-focused agent skill that scans for missing idempotency keys and non-idempotent handlers.
- A language-agnostic analyzer with a low-confidence rule about retrying operations that may not be safe to repeat.
- A Ruby gem that takes the dynamic route: it runs a block multiple times and compares side effects.
- Generic security scanners built on Semgrep, whose taint analysis is described as intraprocedural in one write-up.

What I did **not** find: a Node/TypeScript analyzer that discovers webhook and queue handlers, resolves their effects across your own code, and checks guard ordering and atomicity. That is an absence in a limited search, not proof.

Before building, spend about 30 minutes on:

1. npm search: `idempotency lint`, `eslint-plugin idempotency`, `webhook lint`, `retry safe`.
2. The Semgrep registry and GitHub code search for idempotency or webhook rules in JavaScript and TypeScript.
3. CodeQL query packs for JavaScript (I did not check these).
4. Check whether any existing tool resolves effects through helper functions and checks guard ordering rather than just matching a pattern.

Semgrep and CodeQL users can write custom rules, so the differentiators to lean on are automatic handler discovery, the effect catalog, guard dominance and ordering analysis, and schema awareness.

## Decisions to Settle Early

1. **Name:** short and available on npm and GitHub.
2. **Scope of v1:** discovery, effects, guards, and the five core rules (through Phase 5), Express and Next.js first.
3. **Analysis depth:** bounded call depth with an explicit `unknown-effect` category.
4. **Confidence policy:** default `minConfidence: medium` so the first impression is trustworthy.
5. **Provider facts:** stored as data with source links, reviewed against provider docs.
6. **Runtime library:** keep it optional and separate from the analyzer.
7. **Telemetry:** none.

## Suggested First Steps

1. Reserve the package name and repository.
2. Write 10 to 15 small fixture handlers by hand (good and bad, covering the first five rules).
3. Build the project loader and prove it resolves calls across files (Phase 1).
4. Implement discovery for Express and Next.js route handlers (Phase 2).
5. Get one end-to-end finding working (`unguarded-side-effect`) before building more rules.
6. Run the prototype on two or three open-source projects early to see what real handlers look like.
