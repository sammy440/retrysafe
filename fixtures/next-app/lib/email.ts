import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendWelcome(to: string) {
  await resend.emails.send({ from: "hello@example.com", to, subject: "Welcome", html: "<p>Hi</p>" }); // expect: unguarded-side-effect
}
