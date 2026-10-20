import { Router } from "express";
import { prisma } from "../lib/db";
import { stripe } from "../lib/stripe";
import { sendReceipt } from "../lib/mail";

const router = Router();

async function alreadyHandled(eventId: string) {
  return prisma.processedEvent.findUnique({ where: { id: eventId } });
}

// WORK BEFORE RECORD: the lookup stops sequential retries, but a crash before the insert repeats the email.
router.post("/callback", async (req, res) => {
  const event = req.body;
  if (await alreadyHandled(event.id)) return res.sendStatus(200);

  await sendReceipt(event.data.email, event.data.orderId);
  await prisma.processedEvent.create({ data: { id: event.id } });
  res.sendStatus(200);
});

// NOT A GUARD: a not-found check after a lookup does not deduplicate anything.
router.post("/refund-webhook", async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.body.orderId } });
  if (!order) return res.sendStatus(404);

  await prisma.order.update({ where: { id: order.id }, data: { refundCount: { increment: 1 } } }); // expect: unguarded-side-effect
  res.sendStatus(200);
});

// BAD: the saved card is charged again on every retry (no idempotency key).
router.post("/topup-webhook", async (req, res) => {
  await topUp(req.body.data.customer, req.body.data.amount);
  res.sendStatus(200);
});

async function topUp(customer: string, amount: number) {
  await stripe.paymentIntents.create({ customer, amount, currency: "usd", confirm: true }); // expect: unguarded-side-effect
}

export default router;
