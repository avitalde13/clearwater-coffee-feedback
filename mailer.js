// Sends email through Resend's HTTP API (https://resend.com).
// Railway blocks outgoing SMTP on most plans, so an HTTP API is the reliable option.
//
// Env:
//   RESEND_API_KEY  – required in production
//   MAIL_FROM       – optional, defaults to Resend's test sender. With the test sender,
//                     Resend only delivers to the email address that owns the Resend account.
//
// Locally, without RESEND_API_KEY, the email is printed to the console instead.

const MAIL_FROM = process.env.MAIL_FROM || 'Clearwater Coffee <onboarding@resend.dev>';

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY) || !process.env.RAILWAY_ENVIRONMENT;
}

async function sendMail({ to, subject, text }) {
  if (!process.env.RESEND_API_KEY) {
    if (process.env.RAILWAY_ENVIRONMENT) throw new Error('RESEND_API_KEY is not set');
    console.log(`\n[dev email] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend error ${res.status}: ${body.slice(0, 300)}`);
  }
}

module.exports = { sendMail, isConfigured };
