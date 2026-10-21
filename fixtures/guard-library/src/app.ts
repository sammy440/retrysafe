import express from "express";
import Stripe from "stripe";
import nodemailer from "nodemailer";
import { Worker } from "bullmq";
import { eventKey, withGuard, withGuardJob } from "@retrysafe/guard";
import { dbGuard, txGuard, leaseGuard } from "./guard";

const app = express();
const stripe = new Stripe("sk");
const mailer = nodemailer.createTransport({});

// GOOD: claim and writes share the Prisma transaction.
app.post("/webhooks/stripe", async (req, res) => {
  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], "whsec");
  await txGuard.run(eventKey.stripe(event), async (tx) => {
    await tx.order.create({ data: { id: event.data.object.id } });
    await tx.wallet.update({ where: { id: 1 }, data: { balance: { increment: 10 } } });
  });
  res.sendStatus(200);
});

// GOOD: Express adapter around the whole handler.
app.post(
  "/webhooks/orders",
  withGuard(dbGuard, (req) => eventKey.fromHeader(req.headers, "x-delivery-id"), async (req, res, client) => {
    await client.query("INSERT INTO orders (id) VALUES ($1)", [req.body.id]);
    await mailer.sendMail({ to: req.body.email, subject: "Thanks" });
    res.sendStatus(200);
  }),
);

// Redis lease around a payment: guarded, but the charge itself should still carry an idempotency key.
app.post("/webhooks/payouts", async (req, res) => {
  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], "whsec");
  const result = await leaseGuard.run(eventKey.stripe(event), async () => {
    await stripe.payouts.create({ amount: 100, currency: "usd" }); // expect: effect-missing-idempotency-key
  });
  res.sendStatus(result.status === "in-progress" ? 409 : 200);
});

// BAD KEY: a guard keyed on the clock never sees a duplicate.
app.post("/webhooks/clock", async (req, res) => {
  await leaseGuard.run(`evt:${Date.now()}`, async () => { // expect: nondeterministic-key
    await mailer.sendMail({ to: "ops@example.com", subject: "event" });
  });
  res.sendStatus(200);
});

// GOOD: queue adapter.
new Worker(
  "receipts",
  withGuardJob(leaseGuard, (job) => eventKey.job("receipts", job), async (job) => {
    await mailer.sendMail({ to: job.data.email, subject: "Receipt" });
  }),
);

app.listen(3000);
