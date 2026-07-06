// /api/rate-email.js
//
// Handles the "Yes, spot on" / "Not quite" links inside the Boolean Pack email.
// GET /api/rate-email?id=<boolean_requests.id>&score=5
//
// Required Vercel env vars (same Supabase project the tool already uses):
//   SUPABASE_URL
//   SUPABASE_ANON_KEY

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderThankYouPage({ high, id }) {
  const heading = high ? "Glad it worked!" : "Thanks for the honesty";
  const sub = high
    ? "Come back any time you need another search."
    : "Tell us what missed the mark and we'll use it to improve the next batch.";
  const showComment = !high;

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thanks — The Daily Talent</title>
  <style>
    body{margin:0;padding:0;background:#eef1f8;font-family:Arial,sans-serif;}
    .wrap{max-width:480px;margin:60px auto;padding:0 20px;text-align:center;}
    .card{background:#fff;border:1px solid rgba(15,18,25,0.08);border-radius:14px;padding:36px 28px;}
    h1{font-size:20px;color:#0f1219;margin:0 0 10px;}
    p{font-size:14px;color:#4a5568;line-height:1.6;margin:0 0 18px;}
    textarea{width:100%;box-sizing:border-box;border:1px solid rgba(15,18,25,0.15);border-radius:8px;padding:10px;font-size:13px;font-family:inherit;min-height:80px;margin-bottom:12px;}
    button{background:#0f1219;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;}
    a.home{display:inline-block;margin-top:16px;font-size:12px;color:#4f8ef7;text-decoration:none;}
  </style></head>
  <body><div class="wrap"><div class="card">
    <h1>${heading}</h1>
    <p>${sub}</p>
    ${showComment ? `
    <form method="POST" action="/api/rate-email-comment">
      <input type="hidden" name="id" value="${escHtml(id || "")}">
      <textarea name="comment" placeholder="What were you hoping to see instead? (optional)"></textarea>
      <button type="submit">Send feedback</button>
    </form>` : ""}
    <a class="home" href="https://tools.thedailytalent.com">Build another string →</a>
  </div></div></body></html>`;
}

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  const { id, score } = req.query;
  const numericScore = parseInt(score, 10);

  if (!id || isNaN(numericScore)) {
    res.setHeader("Content-Type", "text/html");
    return res.status(400).send("<p>Missing or invalid feedback link.</p>");
  }

  let jobTitle = null;
  let region = null;

  // Best-effort: look up the original request for richer rating context.
  try {
    const lookupRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/boolean_requests?id=eq.${encodeURIComponent(id)}&select=titles,regions`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          Authorization: "Bearer " + process.env.SUPABASE_ANON_KEY,
        },
      }
    );
    if (lookupRes.ok) {
      const rows = await lookupRes.json();
      if (rows && rows[0]) {
        jobTitle = (rows[0].titles && rows[0].titles[0]) || null;
        region = (rows[0].regions && rows[0].regions[0]) || null;
      }
    }
  } catch (e) {
    // Non-fatal — proceed without enrichment.
  }

  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/ratings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: "Bearer " + process.env.SUPABASE_ANON_KEY,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        score: numericScore,
        job_title: jobTitle,
        region: region,
        session_id: "email:" + id,
      }),
    });
  } catch (e) {
    console.error("rate-email insert error:", e);
    // Still show the thank-you page even if the write failed — don't punish the user for our error.
  }

  res.setHeader("Content-Type", "text/html");
  return res.status(200).send(renderThankYouPage({ high: numericScore >= 4, id }));
};
