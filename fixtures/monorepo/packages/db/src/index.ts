import { PrismaClient } from "@prisma/client";

export const db = new PrismaClient();

export async function recordPayment(customer: string, amount: number) {
  await db.payment.create({ data: { customer, amount } }); // expect: unguarded-side-effect
}
