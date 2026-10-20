import express from "express";
import { recordPayment } from "@acme/db";
import { verify } from "~/verify";

const app = express();

// BAD: the payment row is written again on every retry; the write lives in another workspace package.
app.post("/hooks/payments", async (req, res) => {
  verify(req);
  await recordPayment(req.body.customer, req.body.amount);
  res.sendStatus(200);
});

app.listen(3000);
