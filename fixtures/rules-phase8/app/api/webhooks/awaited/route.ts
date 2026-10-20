import { prisma } from "../../../../src/clients";

// GOOD: awaited before responding.
export async function POST(req: Request) {
  const event: any = await req.json();
  await prisma.ledger.upsert({ where: { id: event.id }, create: { id: event.id }, update: {} });
  return Response.json({ ok: true });
}
