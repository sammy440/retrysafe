// Plain JavaScript package with no tsconfig: loaded with default globs.
const { Worker } = require("bullmq");
const nodemailer = require("nodemailer");

const mailer = nodemailer.createTransport({});

new Worker("digests", async (job) => {
  await mailer.sendMail({ to: job.data.to, subject: "Your digest" }); // expect: unguarded-side-effect
});
