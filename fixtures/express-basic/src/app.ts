import express from "express";
import crypto from "node:crypto";
import { prisma } from "./lib/db";
import { stripe } from "./lib/stripe";
import { redis } from "./lib/redis";
import { sendReceipt } from "./lib/mail";
import billing from "./routes/billing";

const app = express();

// BAD: the order write and the receipt email repeat on every retry.
app.post("/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
  const event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"] as string, process.env.STRIPE_WEBHOOK_SECRET!);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as any;
    const order = await prisma.order.create({ data: { stripeSessionId: session.id, email: session.customer_email } }); // expect: unguarded-side-effect
    await sendReceipt(session.customer_email, order.id);
  }

  if (event.type === "charge.dispute.created") {
    // OK: Stripe deduplicates on the idempotency key.
    await stripe.refunds.create({ charge: (event.data.object as any).charge }, { idempotencyKey: `refund_${event.id}` });
  }

  res.json({ received: true });
});

// RECORD FIRST: SET NX stops duplicates, but a crash after the claim loses the credit.
app.post("/webhooks/paystack", async (req, res) => {
  const hash = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET!).update(JSON.stringify(req.body)).digest("hex");
  if (hash !== req.headers["x-paystack-signature"]) return res.sendStatus(401);

  const event = req.body;
  const claimed = await redis.set(`paystack:${event.data.id}`, "1", "EX", 60 * 60 * 24 * 7, "NX"); // expect: record-before-effect-no-tx
  if (!claimed) return res.sendStatus(200);

  await prisma.wallet.update({
    where: { userId: event.data.metadata.userId },
    data: { balance: { increment: event.data.amount } },
  });
  res.sendStatus(200);
});

// GOOD: the event id is claimed in the same transaction as the credit, so they commit together.
app.post("/webhooks/flutterwave", async (req, res) => {
  const event = req.body;
  await prisma.$transaction(async (tx) => {
    await tx.processedWebhook.create({ data: { id: event.data.id, receivedAt: new Date() } });
    await tx.wallet.update({ where: { userId: event.data.customer.id }, data: { balance: { increment: event.data.amount } } });
  });
  res.sendStatus(200);
});

// BAD KEY: the idempotency key changes on every delivery, so Stripe pays out twice.
app.post("/webhooks/payout", async (req, res) => {
  const key = `payout-${req.body.accountId}-${Date.now()}`; // expect: nondeterministic-key
  await stripe.payouts.create({ amount: req.body.amount, currency: "usd" }, { idempotencyKey: key });
  res.sendStatus(200);
});

// NOT AT-LEAST-ONCE: an ordinary user-facing route. Must not be discovered.
app.post("/users", async (req, res) => {
  const user = await prisma.user.create({ data: req.body });
  await sendReceipt(user.email, "welcome");
  res.json(user);
});

app.get("/health", (_req, res) => res.send("ok"));

app.use("/billing", billing);

app.listen(3000);
