import type { FastifyInstance } from "fastify";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Typed plugin; discovered through the header it reads, not its path.
export async function shopRoutes(fastify: FastifyInstance) {
  fastify.post("/orders", async (request) => {
    const topic = request.headers["x-shopify-webhook-id"];
    // GOOD: delivery id and order write commit together.
    await prisma.$transaction(async (tx) => {
      await tx.processedEvent.create({ data: { id: String(topic) } });
      await tx.order.create({ data: { payload: request.body as object } });
    });
    return { ok: true };
  });
}
