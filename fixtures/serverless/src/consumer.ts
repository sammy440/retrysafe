import { Consumer } from "sqs-consumer";
import nodemailer from "nodemailer";

const mailer = nodemailer.createTransport({});

export const app = Consumer.create({
  queueUrl: process.env.QUEUE_URL!,
  handleMessage: async (message) => {
    await mailer.sendMail({ to: "ops@example.com", text: message.Body }); // expect: unguarded-side-effect
  },
});
