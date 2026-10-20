import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({ host: "smtp.example.com" });

export async function sendReceipt(to: string, orderId: string) {
  await transporter.sendMail({ to, subject: "Your receipt", text: `Order ${orderId}` }); // expect: unguarded-side-effect, effect-before-record
}
