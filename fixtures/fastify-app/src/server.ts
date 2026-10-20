import Fastify from "fastify";
import Stripe from "stripe";
import { PrismaClient } from "@prisma/client";
import billingRoutes from "./routes/billing";
import { shopRoutes } from "./routes/shop";

const app = Fastify();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const prisma = new PrismaClient();

// BAD: app.route() form; credits are applied again on each retry.
app.route({
  method: "POST",
  url: "/webhooks/stripe",
  handler: async (request, reply) => {
    const event = stripe.webhooks.constructEvent(request.body as string, request.headers["stripe-signature"] as string, "whsec");
    await prisma.credit.create({ data: { eventId: event.id } }); // expect: unguarded-side-effect
    return reply.send({ ok: true });
  },
});

// NOT AT-LEAST-ONCE: ordinary route.
app.post("/signup", async (request) => {
  await prisma.user.create({ data: request.body as object });
  return { ok: true };
});

app.register(billingRoutes, { prefix: "/billing" });
app.register(shopRoutes, { prefix: "/shop" });
app.listen({ port: 3000 });
