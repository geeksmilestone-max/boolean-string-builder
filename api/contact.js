// /api/contact.js
// Vercel serverless function — receives submissions from all four pathway
// forms on the About & Contact page, writes to Supabase, and notifies
// support@thedailytalent.com via Resend with the pathway clearly labeled
// in the subject line (so inbox filters/labels can sort it automatically).

const PATHWAY_LABELS = {
  seeker: 'Get Help',
  sponsor: 'Sponsorship & Collaboration',
  contribute: 'Contribute',
  general: 'General & Bug Report',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    const { pathway, email, page_url, referrer, company_hp, ...fields } = body || {};

    // Honeypot: if this hidden field was filled, silently accept without
    // writing to Supabase or sending an email (bot submission).
    if (company_hp) {
      return res.status(200).json({ ok: true });
    }

    if (!pathway || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const label = PATHWAY_LABELS[pathway] || pathway;

    // 1) Write to Supabase — never block the email notification on this.
    try {
      const supabaseRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/contact_submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          pathway,
          email,
          payload: fields,
          page_url,
          referrer,
        }),
      });
      if (!supabaseRes.ok) {
        console.error('Supabase insert failed:', await supabaseRes.text());
      }
    } catch (dbErr) {
      console.error('Supabase insert threw:', dbErr);
    }

    // 2) Build a readable field table for the email body.
    const rows = Object.entries(fields)
      .map(([key, value]) => {
        const niceKey = key.replace(/_/g, ' ');
        const safeValue = String(value ?? '—').replace(/</g, '&lt;');
        return `<tr><td style="padding:4px 16px 4px 0;color:#6b7794;font-size:13px;text-transform:capitalize;white-space:nowrap;vertical-align:top;">${niceKey}</td><td style="padding:4px 0;font-size:13px;color:#0f1219;">${safeValue}</td></tr>`;
      })
      .join('');

    // 3) Send the notification via Resend.
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM,
        to: 'support@thedailytalent.com',
        reply_to: email,
        subject: `[${label}] New contact form submission`,
        html: `
          <div style="font-family:-apple-system,sans-serif; max-width:520px;">
            <p style="font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase; color:#4f8ef7; margin:0 0 12px;">${label}</p>
            <table style="border-collapse:collapse;">${rows}</table>
            <p style="margin-top:20px; padding-top:12px; border-top:1px solid #eee; font-size:12px; color:#9aa3b8;">
              From: ${email}<br>
              Page: ${page_url || 'n/a'}
            </p>
          </div>
        `,
      }),
    });

    if (!resendRes.ok) {
      console.error('Resend send failed:', await resendRes.text());
      return res.status(502).json({ error: 'Notification email failed to send' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Contact form error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
