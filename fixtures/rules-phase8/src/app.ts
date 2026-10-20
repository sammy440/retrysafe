import express from "express";
import pRetry from "p-retry";
import { prisma, stripe, redis } from "./clients";

const app = express();
const upsertLedger = (id: string) => prisma.ledger.upsert({ where: { id }, create: { id }, update: {} });

// swallowed-error-returns-2xx — BAD: failure acknowledged with 200.
app.post("/webhooks/swallow", async (req, res) => {
  try {
    await upsertLedger(req.body.id);
  } catch (err) { // expect: swallowed-error-returns-2xx
    console.error(err);
    return res.sendStatus(200);
  }
  res.sendStatus(200);
});

// GOOD: rethrown, so the provider retries.
app.post("/webhooks/rethrow", async (req, res) => {
  try {
    await upsertLedger(req.body.id);
  } catch (err) {
    console.error(err);
    throw err;
  }
  res.sendStatus(200);
});

// permanent-error-returns-5xx — BAD: bad signature and invalid payload answered with 500.
app.post("/webhooks/strict", async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], "whsec");
  } catch {
    return res.status(500).send("bad signature"); // expect: permanent-error-returns-5xx
  }
  if (!event.data.object.customer) return res.status(503).json({ error: "missing customer" }); // expect: permanent-error-returns-5xx
  await upsertLedger(event.id);
  res.sendStatus(200);
});

// GOOD: 400 for permanent failures.
app.post("/webhooks/lenient", async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], "whsec");
  } catch {
    return res.status(400).send("bad signature");
  }
  await upsertLedger(event.id);
  res.sendStatus(200);
});

// ack-timing — BAD: acknowledged before the work, and work fired off with forEach(async).
app.post("/webhooks/early-ack", async (req, res) => {
  res.sendStatus(200); // expect: ack-timing
  await upsertLedger(req.body.id);
  req.body.items.forEach(async (item) => {
    await upsertLedger(item.id); // expect: ack-timing
  });
});

// wrong-event-field-as-key — BAD: dedupe key is the invoice id, shared by invoice.created/paid/voided.
app.post("/webhooks/object-key", async (req, res) => {
  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], "whsec");
  const invoice = event.data.object as any;
  await prisma.$transaction(async (tx) => {
    await tx.processedEvent.create({ data: { id: invoice.id } }); // expect: wrong-event-field-as-key
    await tx.invoice.upsert({ where: { id: invoice.id }, create: { id: invoice.id }, update: {} });
  });
  res.sendStatus(200);
});

// GOOD: keyed on the event id.
app.post("/webhooks/event-key", async (req, res) => {
  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], "whsec");
  await prisma.$transaction(async (tx) => {
    await tx.processedEvent.create({ data: { id: event.id } });
    await tx.invoice.upsert({ where: { id: event.data.object.id }, create: {}, update: {} });
  });
  res.sendStatus(200);
});

// retry-loop-with-effect — BAD: p-retry and a retry loop around charges with no idempotency key.
app.post("/webhooks/retry", async (req, res) => {
  await pRetry(() => stripe.charges.create({ amount: req.body.amount, currency: "usd" })); // expect: unguarded-side-effect, retry-loop-with-effect
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await stripe.refunds.create({ charge: req.body.charge }); // expect: unguarded-side-effect, retry-loop-with-effect
      break;
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
  res.sendStatus(200);
});

// GOOD: the key is computed once, so every attempt is the same request to Stripe.
app.post("/webhooks/retry-keyed", async (req, res) => {
  const key = `charge_${req.body.id}`;
  await pRetry(() => stripe.charges.create({ amount: req.body.amount, currency: "usd" }, { idempotencyKey: key }));
  res.sendStatus(200);
});

// dedupe-ttl-short — BAD: one hour, but Stripe retries for three days.
app.post("/webhooks/short-ttl", async (req, res) => {
  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], "whsec");
  if (!(await redis.set(`evt:${event.id}`, "1", "EX", 3600, "NX"))) return res.sendStatus(200); // expect: dedupe-ttl-short
  res.sendStatus(200);
});

// GOOD: a week.
app.post("/webhooks/long-ttl", async (req, res) => {
  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], "whsec");
  if (!(await redis.set(`evt:${event.id}`, "1", "EX", 60 * 60 * 24 * 7, "NX"))) return res.sendStatus(200);
  res.sendStatus(200);
});

app.listen(3000);
