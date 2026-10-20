import { Webhooks } from "@octokit/webhooks";
import { db } from "@/lib/db";

const webhooks = new Webhooks({ secret: process.env.GITHUB_WEBHOOK_SECRET! });

// GOOD: the delivery id is inserted in the same transaction as the counter update.
export async function POST(req: Request) {
  const body = await req.text();
  const ok = await webhooks.verify(body, req.headers.get("x-hub-signature-256")!);
  if (!ok) return new Response("bad signature", { status: 401 });

  const deliveryId = req.headers.get("x-github-delivery")!;
  const payload = JSON.parse(body);

  await db.$transaction(async (tx) => {
    await tx.processedEvent.create({ data: { id: deliveryId } });
    await tx.starCount.update({ where: { repo: payload.repository.full_name }, data: { count: { increment: 1 } } });
  });

  return new Response("ok");
}
