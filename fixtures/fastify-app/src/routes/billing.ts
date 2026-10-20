import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Untyped plugin: recognized because it is passed to app.register().
export default async function billingRoutes(fastify) {
  // BAD: options object + handler; path comes from the register() prefix.
  fastify.post("/callback", { config: { rawBody: true } }, async (request) => {
    await prisma.invoice.update({ where: { id: request.body.invoiceId }, data: { attempts: { increment: 1 } } }); // expect: incrementing-write-unguarded
    return { ok: true };
  });
}
