// Transactional email via Resend — one fetch call, no SDK (matches this
// app's zero-npm-dependency rule: external services are called with fetch,
// never a client library). Throws if RESEND_API_KEY isn't set, rather than
// attempting a request with a bogus Authorization header — callers decide
// what a send failure means for the response they've already promised.
export async function sendEmail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not set — cannot send email.');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'Setback <onboarding@resend.dev>',
      to, subject, html, text
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend returned ${res.status}: ${body}`);
  }
}
