import express from "express";
import axios from "axios";
import { Octokit } from "@octokit/rest";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBClient, PutItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { createAdminApiClient } from "@shopify/admin-api-client";
import Paystack from "paystack-api";
import { sql } from "drizzle-orm";
import { db, knex, Order, ProcessedEvent, orders, processedEvents } from "./db";

const app = express();
const octokit = new Octokit();
const sqs = new SQSClient({});
const dynamo = new DynamoDBClient({});
const shopify = createAdminApiClient({ storeDomain: "x", apiVersion: "2026-04", accessToken: "t" });
const paystack = Paystack(process.env.PAYSTACK_SECRET!);

// Drizzle: plain insert flagged; conflict-ignoring insert and fixed update are idempotent; relative update flagged.
app.post("/webhooks/drizzle", async (req, res) => {
  await db.insert(orders).values({ id: req.body.id }); // expect: unguarded-side-effect
  await db.insert(orders).values({ id: req.body.id }).onConflictDoNothing(); // expect: non-atomic-multi-write
  await db.update(orders).set({ status: "paid" });
  await db.update(orders).set({ total: sql`${orders.total} + ${req.body.amount}` }); // expect: incrementing-write-unguarded
  res.sendStatus(200);
});

// Drizzle claim: insert ... on conflict do nothing returning, checked by row count, then work in the same tx.
app.post("/webhooks/drizzle-claim", async (req, res) => {
  await db.transaction(async (tx) => {
    const claimed = await tx.insert(processedEvents).values({ id: req.body.id }).onConflictDoNothing().returning();
    if (claimed.length === 0) return;
    await tx.insert(orders).values({ id: req.body.id });
  });
  res.sendStatus(200);
});

// Knex: increment flagged; merge upsert idempotent.
app.post("/webhooks/knex", async (req, res) => {
  await knex("wallets").where({ id: req.body.user }).increment("balance", req.body.amount); // expect: incrementing-write-unguarded
  await knex("orders").insert({ id: req.body.id }).onConflict("id").merge(); // expect: non-atomic-multi-write
  res.sendStatus(200);
});

// Mongoose: dedupe-model insert claims the event (record first, no transaction); $inc is then lost on a crash.
app.post("/webhooks/mongoose", async (req, res) => {
  await ProcessedEvent.create({ _id: req.body.id }); // expect: record-before-effect-no-tx
  await Order.updateOne({ _id: req.body.order }, { $inc: { paidCount: 1 } });
  res.sendStatus(200);
});

// HTTP and SDKs: Paystack transfer via REST without reference; GitHub comment; SQS message without dedup id.
app.post("/webhooks/payout", async (req, res) => {
  await axios.post("https://api.paystack.co/transfer", { amount: req.body.amount, recipient: req.body.to }); // expect: unguarded-side-effect
  await axios.post("https://api.paystack.co/transfer", { amount: 1, recipient: "r", reference: `payout_${req.body.id}` });
  await fetch("https://api.example.com/status"); // GET: not an effect
  await octokit.issues.createComment({ owner: "o", repo: "r", issue_number: 1, body: "Paid" }); // expect: unguarded-side-effect
  await sqs.send(new SendMessageCommand({ QueueUrl: "q", MessageBody: "x" })); // expect: queue-add-without-job-id
  await sqs.send(new SendMessageCommand({ QueueUrl: "q.fifo", MessageBody: "x", MessageDeduplicationId: req.body.id, MessageGroupId: "g" }));
  await paystack.transfer.create({ amount: 1, recipient: "r", reference: req.body.ref });
  res.sendStatus(200);
});

// DynamoDB conditional put claims atomically; the ADD update after it is outside any transaction.
app.post("/webhooks/dynamo", async (req, res) => {
  await dynamo.send(new PutItemCommand({ TableName: "processed", Item: { pk: { S: req.body.id } }, ConditionExpression: "attribute_not_exists(pk)" })); // expect: record-before-effect-no-tx
  await dynamo.send(new UpdateItemCommand({ TableName: "accounts", Key: {}, UpdateExpression: "ADD credits :n" }));
  res.sendStatus(200);
});

// Shopify GraphQL: mutation without @idempotent flagged; with it, idempotent; queries ignored.
app.post("/webhooks/shopify", async (req, res) => {
  await shopify.request(`query { shop { name } }`);
  await shopify.request(`mutation { refundCreate(input: $input) { refund { id } } }`); // expect: unguarded-side-effect
  await shopify.request(`mutation { refundCreate(input: $input) @idempotent(key: $key) { refund { id } } }`);
  res.sendStatus(200);
});

app.listen(3000);
