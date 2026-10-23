// Sends email through an HTTP email API. Railway blocks outgoing SMTP on most plans,
// so an HTTP API is the reliable option. Two providers are supported:
//
// Brevo (https://brevo.com) – recommended. After you verify ONE sender address
// (e.g. your Gmail), it can send to any recipient on the free plan.
//   BREVO_API_KEY    – API key (starts with "xkeysib-")
//   MAIL_FROM_EMAIL  – the sender address you verified in Brevo
//   MAIL_FROM_NAME   – optional, defaults to "Clearwater Coffee"
//
// Resend (https://resend.com) – without a verified domain, it only delivers to the
// email address that owns the Resend account.
//   RESEND_API_KEY   – API key (starts with "re_")
//   MAIL_FROM        – optional, defaults to Resend's test sender
//
// Locally, without either key, the email is printed to the console instead.

const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Clearwater Coffee';

async function sendWithBrevo({ to, subject, text }) {
  if (!process.env.MAIL_FROM_EMAIL) throw new Error('MAIL_FROM_EMAIL is not set (needed for Brevo)');
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { name: MAIL_FROM_NAME, email: process.env.MAIL_FROM_EMAIL },
      to: [{ email: to }],
      subject,
      textContent: text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Brevo error ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function sendWithResend({ to, subject, text }) {
  const from = process.env.MAIL_FROM || `${MAIL_FROM_NAME} <onboarding@resend.dev>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend error ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function sendMail(message) {
  if (process.env.BREVO_API_KEY) return sendWithBrevo(message);
  if (process.env.RESEND_API_KEY) return sendWithResend(message);
  if (process.env.RAILWAY_ENVIRONMENT) {
    throw new Error('No email service configured: set BREVO_API_KEY and MAIL_FROM_EMAIL');
  }
  console.log(`\n[dev email] To: ${message.to}\nSubject: ${message.subject}\n${message.text}\n`);
}

module.exports = { sendMail };
