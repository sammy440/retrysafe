# retrysafe

> What happens if this handler runs twice, or stops halfway?

Webhook providers and job queues deliver **at least once**. A slow response, a deploy, or a crash and
the same event arrives again. `retrysafe` statically analyzes your Node/TypeScript webhook handlers and
queue workers and tells you which side effects (charges, emails, inserts, enqueued jobs) would run twice,
or be lost, when that happens.

```sh
npx retrysafe                      # run without installing
npm install --save-dev retrysafe   # or pin it in your project
```

Try it in the browser first: https://retrysafe-frontend.vercel.app/playground

```
POST /webhooks/stripe  express · stripe · src/app.ts:12
  ✔ verify    stripe.webhooks.constructEvent   src/app.ts:13  signature check
  ✖ db-write  prisma.order.create              src/app.ts:17  no guard on this path
  ✖ email     transporter.sendMail             src/lib/mail.ts:6  no guard on this path

error  unguarded-side-effect  src/app.ts:17
  1. Stripe delivers evt_1; handler runs prisma.order.create
  2. The response is slow or the process restarts before Stripe sees a 2xx; it retries evt_1
  3. Handler runs prisma.order.create again: a duplicate row is written
  Fix: insert the event id into a processed-events table with a unique constraint, in the same
  transaction as this write, and skip the work when the insert conflicts.
```

## What it understands

- **Entry points:** Express, Fastify, Next.js App Router and Pages API routes, BullMQ, Bull, AWS Lambda
  (SQS, SNS, EventBridge, Kinesis, DynamoDB Streams, S3), `sqs-consumer`, Probot. Monorepos are loaded
  per package.
- **Effects:** Stripe, Paystack, Flutterwave, Prisma, Drizzle, Knex, Mongoose, `pg`/`mysql2`, Redis,
  nodemailer, Resend, SendGrid, Postmark, Mailgun, Twilio, Slack, BullMQ, Inngest, Trigger.dev, AWS SDK v3,
  Octokit, Shopify, and outbound HTTP, followed through your own helper functions.
- **Guards:** unique inserts (checked against your Prisma schema, SQL migrations, Drizzle tables or
  Mongoose schemas), Redis `SET NX`, idempotency keys, transactions, and your own helpers via config.
- **16 rules**, from unguarded side effects to check-then-insert races and record-before-effect without
  a transaction. Run `retrysafe rules` for the list and `retrysafe explain <id>` for any finding.

## Commands

```
retrysafe [dir]                 Analyze the project
retrysafe init [dir]            Create a starter retrysafe.config.ts
retrysafe explain <id> [dir]    Failing sequence, why it happens, and the fix
retrysafe rules                 List rules
retrysafe fix [dir]             Preview codemods (--write to apply)
retrysafe verify <handler>      (experimental) Deliver an event twice against stubbed libraries
retrysafe live [dir]            Re-analyze on every save and show results in the browser
```

`retrysafe live --open` opens https://retrysafe-frontend.vercel.app/live, which connects back to your
machine on 127.0.0.1; your code is analyzed locally and never uploaded.

Useful options: `--effect-map`, `--format json|markdown|sarif|github`, `--ci --fail-on warning`,
`--changed origin/main`, `--staged`, `--update-baseline`. See `retrysafe --help`.

## CI

```sh
npx retrysafe --ci --format sarif -o retrysafe.sarif
```

`--ci` exits 1 on findings at or above `--fail-on` (default `error`). A baseline
(`--update-baseline`) lets you adopt it on an existing codebase and fail only on new findings.

## Config

```ts
// retrysafe.config.ts
import { defineConfig } from "retrysafe";

export default defineConfig({
  // Your own dedupe helper: claimEvent(eventId) inserts into a uniquely-keyed table.
  guards: [{ callee: "claimEvent", keyArg: 0, atomic: true }],
  rules: { "nondeterministic-key": "warning" },
});
```

Inline suppressions need a reason: `// retrysafe-ignore unguarded-side-effect -- the ESP deduplicates`.

## Privacy

Analysis is static and local. Your code is never executed (except by the opt-in `verify` command,
against stubs) and never leaves your machine.

MIT licensed. Source and issues: https://github.com/sammy440/retrysafe
