import type { SQSEvent } from "aws-lambda";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import Redis from "ioredis";
import twilio from "twilio";

const redis = new Redis();
const sms = twilio("sid", "token");

// Typed SQS Lambda with a per-record "seen?" check: work runs before the marker is written.
export const handler = async (event: SQSEvent) => {
  for (const record of event.Records) {
    if (await redis.get(`msg:${record.messageId}`)) continue; // expect: check-then-insert-race
    await sms.messages.create({ to: JSON.parse(record.body).phone, body: "Order shipped" }); // expect: effect-before-record
    await redis.set(`msg:${record.messageId}`, "1", "EX", 86400);
  }
};

// Not exported as a handler: ignored.
export function helper(_e: SQSEvent) {
  return new SESClient({}).send(new SendEmailCommand({} as never));
}
