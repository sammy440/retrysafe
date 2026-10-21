import { eventKey } from "@retrysafe/guard";
import { dbGuard } from "../../../../src/guard";

// GOOD: guard.run inside a Next.js route handler.
export async function POST(req: Request) {
  const order = await req.json();
  const result = await dbGuard.run(eventKey.shopify(req.headers), async (client) => {
    await client.query("UPDATE inventory SET count = count - 1 WHERE sku = $1", [order.sku]);
  });
  return new Response(null, { status: result.status === "in-progress" ? 409 : 200 });
}
