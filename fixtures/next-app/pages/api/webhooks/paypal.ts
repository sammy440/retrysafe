import { Pool } from "pg";

const pool = new Pool();

// RECORD FIRST: ON CONFLICT DO NOTHING claims the event atomically, but the balance update is a separate
// statement outside any transaction; a crash between them loses the update.
export default async function handler(req: any, res: any) {
  const event = req.body;
  const claim = await pool.query("INSERT INTO processed_events (id) VALUES ($1) ON CONFLICT DO NOTHING", [event.id]); // expect: record-before-effect-no-tx
  if (claim.rowCount === 0) return res.status(200).end();

  await pool.query("UPDATE balances SET amount = amount + $1 WHERE user_id = $2", [event.resource.amount, event.resource.user]);
  res.status(200).end();
}
