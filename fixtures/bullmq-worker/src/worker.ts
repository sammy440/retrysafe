import { Worker } from "bullmq";
import { Resend } from "resend";
import twilio from "twilio";
import Stripe from "stripe";
import Redis from "ioredis";
import { emailQueue } from "./queues";

const resend = new Resend(process.env.RESEND_API_KEY);
const sms = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const redis = new Redis();

new Worker("invoices", async (job) => {
  // OK: the email carries an idempotency key derived from the job.
  await resend.emails.send({ to: job.data.email, subject: "Invoice", html: "..." }, { idempotencyKey: `invoice-email/${job.id}` });

  await emailQueue.add("followup", { email: job.data.email }); // expect: unguarded-side-effect
  await emailQueue.add("receipt", { email: job.data.email }, { jobId: `receipt-${job.id}` });
});

export const notifications = new Worker("notifications", processNotification);

async function processNotification(job: { data: { phone: string; text: string } }) {
  await sms.messages.create({ to: job.data.phone, from: "+15550100", body: job.data.text }); // expect: unguarded-side-effect
}

// CLAIMED BUT NO KEY: the SET NX claim stops duplicates but a crash after it loses the transfer;
// the transfer itself also passes no idempotency key.
new Worker("payouts", async (job) => {
  if (!(await redis.set(`payout:${job.id}`, "1", "NX"))) return; // expect: record-before-effect-no-tx
  await stripe.transfers.create({ amount: job.data.amount, currency: "usd", destination: job.data.account }); // expect: effect-missing-idempotency-key
});
