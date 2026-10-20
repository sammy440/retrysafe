import { headers } from "next/headers";
import { stripe } from "@/lib/stripe";
import { db } from "@/lib/db";
import { sendWelcome } from "@/lib/email";

// BAD: a retried subscription event creates a second row and sends a second welcome email.
export async function POST(req: Request) {
  const body = await req.text();
  const signature = (await headers()).get("stripe-signature")!;
  const event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);

  switch (event.type) {
    case "customer.subscription.created": {
      const sub = event.data.object as { id: string; customer: string };
      await db.subscription.create({ data: { stripeId: sub.id, customerId: sub.customer } }); // expect: unguarded-side-effect
      await sendWelcome(sub.customer);
      break;
    }
    case "invoice.paid": {
      // OK: setting a fixed value is idempotent.
      const invoice = event.data.object as { customer: string };
      await db.account.update({ where: { stripeCustomerId: invoice.customer }, data: { paidAt: new Date() } });
      break;
    }
  }

  return Response.json({ received: true });
}
