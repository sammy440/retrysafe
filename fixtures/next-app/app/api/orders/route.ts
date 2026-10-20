import { db } from "@/lib/db";

// NOT AT-LEAST-ONCE: an ordinary API route. Must not be discovered.
export async function POST(req: Request) {
  const order = await db.order.create({ data: await req.json() });
  return Response.json(order);
}
