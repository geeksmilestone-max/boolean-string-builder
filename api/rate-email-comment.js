// /api/rate-email-comment.js
//
// Handles the optional comment form shown after a low rating on the
// email feedback page (POST from rate-email.js's thank-you HTML).
//
// POST /api/rate-email-comment
// Body (application/x-www-form-urlencoded): id=<boolean_requests.id>&comment=<text>
//
// Required Vercel env vars (same as rate-email.js):
//   SUPABASE_URL
//   SUPABASE_ANON_KEY

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderConfirmPage() {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Thanks — The Daily Talent</title>
  <style>
    body{margin:0;padding:0;background:#eef1f8;font-family:Arial,sans-serif;}
    .wrap{max-width:480px;margin:60px auto;padding:0 20px;text-align:center;}
    .card{background:#fff;border:1px solid rgba(15,18,25,0.08);border-radius:14px;padding:36px 28px;}
    h1{font-size:20px;color:#0f1219;margin:0 0 10px;}
    p{font-size:14px;color:#4a5568;line-height:1.6;margin:0 0 18px;}
    a.home{display:inline-block;margin-top:6px;font-size:12px;color:#4f8ef7;text-decoration:none;}
  </style></head>
  <body><div class="wrap"><div class="card">
    <h1>Got it — thank you.</h1>
    <p>Your note helps us tune the next batch of strings.</p>
    <a class="home" href="https://tools.thedailytalent.com">Build another string →</a>
  </div></div></body></html>`;
}

// Manual fallback parser in case the platform doesn't auto-parse the body
// for this content type in a given runtime configuration.
function parseUrlEncoded(raw) {
  const params = new URLSearchParams(raw);
  const out = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  let id, comment;

  if (req.body && typeof req.body === "object" && Object.keys(req.body).length) {
    // Platform already parsed it for us.
    ({ id, comment } = req.body);
  } else {
    try {
      const raw = typeof req.body === "string" ? req.body : await readRawBody(req);
      const parsed = parseUrlEncoded(raw);
      id = parsed.id;
      comment = parsed.comment;
    } catch (e) {
      console.error("rate-email-comment body parse error:", e);
    }
  }

  if (!id) {
    res.setHeader("Content-Type", "text/html");
    return res.status(400).send("<p>Missing feedback reference.</p>");
  }

  const trimmedComment = (comment || "").trim().slice(0, 1000);

  if (trimmedComment) {
    try {
      await fetch(
        `${process.env.SUPABASE_URL}/rest/v1/ratings?session_id=eq.${encodeURIComponent("email:" + id)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            apikey: process.env.SUPABASE_ANON_KEY,
            Authorization: "Bearer " + process.env.SUPABASE_ANON_KEY,
            Prefer: "return=minimal",
          },
          body: JSON.stringify({ comment: trimmedComment }),
        }
      );
    } catch (e) {
      console.error("rate-email-comment patch error:", e);
      // Still show the confirmation page — don't punish the user for our error.
    }
  }

  res.setHeader("Content-Type", "text/html");
  return res.status(200).send(renderConfirmPage());
};
