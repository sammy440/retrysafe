// Untyped JavaScript Lambda: recognized by iterating event.Records.
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

exports.handler = async (event) => {
  for (const r of event.Records) {
    await prisma.ledger.create({ data: { body: r.body } }); // expect: unguarded-side-effect
  }
};
