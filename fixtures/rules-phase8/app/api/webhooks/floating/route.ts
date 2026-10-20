import { prisma } from "../../../../src/clients";

// ack-timing — BAD on serverless: the write is not awaited and may be cut off when the response returns.
export async function POST(req: Request) {
  const event: any = await req.json();
  prisma.ledger.upsert({ where: { id: event.id }, create: { id: event.id }, update: {} }); // expect: ack-timing
  return Response.json({ ok: true });
}
