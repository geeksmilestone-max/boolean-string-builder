// /api/send-boolean-pack.js
//
// Trigger: Supabase Database Webhook on INSERT to boolean_requests
// Action: generate 10 Boolean strings (LinkedIn Jobs / LinkedIn Posts / Google X-Ray)
//         matched to the submitter's captured search intent, then email via Resend.
//
// Required Vercel env vars:
//   RESEND_API_KEY   - from resend.com dashboard
//   RESEND_FROM      - e.g. "The Daily Talent <strings@tools.thedailytalent.com>"
//   WEBHOOK_SECRET   - any random string you generate; must match Supabase webhook header

const RESEND_API_URL = "https://api.resend.com/emails";

// ── LIMITS (defaults — replace with your own tested numbers if you have them) ──
const LIMITS = {
  jobsTabMaxChars: 500,
  postsTabMaxChars: 200,
  xrayMaxWords: 32,
};

// ── STRING-BUILDING HELPERS (ported from the live tool's client-side logic) ──
function quoted(s) {
  return s.includes(" ") ? '"' + s + '"' : s;
}
function orGroup(arr) {
  if (!arr.length) return "";
  const p = arr.map(quoted);
  return p.length > 1 ? "(" + p.join(" OR ") + ")" : p[0];
}
function buildTitleClause(titles, titleOp) {
  if (!titles.length) return "";
  const p = titles.map(quoted);
  return p.length > 1 ? "(" + p.join(" " + (titleOp || "OR") + " ") + ")" : p[0];
}
function buildSkillsClause(mustSkills, niceSkills) {
  const m = (mustSkills || []).map(quoted);
  const n = (niceSkills || []).map(quoted);
  const parts = [];
  if (m.length) parts.push(m.join(" AND "));
  if (n.length) parts.push("(" + n.join(" OR ") + ")");
  return parts.join(" AND ");
}
function joinAnd(parts) {
  return parts.filter(Boolean).join(" AND ");
}
function wordCount(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

// Trim a clause list to fit a char budget by progressively dropping
// the least-essential parts (nice skills first, then extra must skills).
function fitToCharBudget(baseParts, extraNiceSkills, maxChars) {
  let nice = extraNiceSkills.slice();
  let str = joinAnd(baseParts.concat(nice.length ? ["(" + nice.map(quoted).join(" OR ") + ")"] : []));
  while (str.length > maxChars && nice.length) {
    nice.pop();
    str = joinAnd(baseParts.concat(nice.length ? ["(" + nice.map(quoted).join(" OR ") + ")"] : []));
  }
  return str;
}

function buildTenStrings(intent) {
  const titles = intent.titles || [];
  const regions = intent.regions || [];
  const mustSkills = intent.must_skills || [];
  const niceSkills = intent.nice_skills || [];
  const titleOp = intent.title_op || "OR";

  const titleClause = buildTitleClause(titles, titleOp);
  const regionClause = orGroup(regions);
  const skillsClauseFull = buildSkillsClause(mustSkills, niceSkills);
  const coreParts = [titleClause, regionClause];

  const results = [];

  // ── LinkedIn Jobs Tab (3) — generous budget, full intent ──
  const jobsCore = fitToCharBudget(
    [titleClause, regionClause, mustSkills.length ? mustSkills.map(quoted).join(" AND ") : ""],
    niceSkills,
    LIMITS.jobsTabMaxChars
  );
  results.push({ platform: "LinkedIn · Jobs Tab", dot: "jobs", value: jobsCore });

  const jobsHiring = jobsCore + " AND (jobs OR hiring OR vacancy)";
  results.push({
    platform: "LinkedIn · Jobs Tab",
    dot: "jobs",
    value: jobsHiring.length <= LIMITS.jobsTabMaxChars ? jobsHiring : jobsCore,
  });

  const jobsFiltered = jobsCore + " NOT (intern OR junior)";
  results.push({
    platform: "LinkedIn · Jobs Tab",
    dot: "jobs",
    value: jobsFiltered.length <= LIMITS.jobsTabMaxChars ? jobsFiltered : jobsCore,
  });

  // ── LinkedIn Posts Tab (3) — tight budget, hiring-signal focused ──
  const primaryTitle = titles[0] ? quoted(titles[0]) : "";
  const primaryRegion = regions[0] ? quoted(regions[0]) : "";
  const postsBase = [primaryTitle, primaryRegion].filter(Boolean).join(" AND ");

  [
    postsBase + (postsBase ? " AND " : "") + "hiring",
    postsBase + (postsBase ? " AND " : "") + "(apply OR \"join our team\")",
    postsBase + (postsBase ? " AND " : "") + "vacancy",
  ].forEach((s) => {
    results.push({
      platform: "LinkedIn · Posts Tab",
      dot: "posts",
      value: s.length <= LIMITS.postsTabMaxChars ? s : postsBase,
    });
  });

  // ── Google X-Ray (4) — LinkedIn profiles + GCC job boards ──
  const xrayCoreParts = [primaryTitle, primaryRegion].filter(Boolean);
  const xraySites = [
    { key: "li", prefix: "site:linkedin.com/in" },
    { key: "bayt", prefix: "site:bayt.com/en/jobs" },
    { key: "naukri", prefix: "site:naukrigulf.com/jobs-in" },
    { key: "indeed", prefix: "site:indeed.com/jobs" },
  ];
  xraySites.forEach((site, i) => {
    let parts = xrayCoreParts.slice();
    if (i === 1 && mustSkills[0]) parts.push(quoted(mustSkills[0])); // add one skill on the 2nd variant for texture
    let str = site.prefix + " " + parts.join(" ");
    // trim words from the end if over budget
    let words = str.split(/\s+/);
    while (words.length > LIMITS.xrayMaxWords) words.pop();
    str = words.join(" ");
    results.push({ platform: "Google X-Ray", dot: "xray", value: str });
  });

  return results.slice(0, 10);
}

function charOrWordLabel(item) {
  if (item.dot === "xray") {
    return wordCount(item.value) + " / " + LIMITS.xrayMaxWords + " words";
  }
  const max = item.dot === "jobs" ? LIMITS.jobsTabMaxChars : LIMITS.postsTabMaxChars;
  return item.value.length + " / " + max + " chars";
}

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderStringBlocksHtml(items) {
  const dotColor = { jobs: "#4f8ef7", posts: "#38e8b5", xray: "#C8A84B" };
  return items
    .map(
      (item) => `
    <div style="margin:0 32px 16px;border:1px solid rgba(15,18,25,0.09);border-radius:10px;overflow:hidden;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:#f7f8fc;border-bottom:1px solid rgba(15,18,25,0.07);">
        <span style="font-size:10.5px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:#4a5568;">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${dotColor[item.dot]};margin-right:6px;"></span>${escHtml(item.platform)}
        </span>
        <span style="font-size:10.5px;color:#9aa3b8;font-family:monospace;">${charOrWordLabel(item)}</span>
      </div>
      <div style="font-family:'Courier New',monospace;font-size:12.5px;line-height:1.65;color:#1a1f2b;padding:14px 16px;word-break:break-word;background:#ffffff;">
        ${escHtml(item.value).replace(/\b(AND)\b/g, '<span style="color:#4f8ef7;">AND</span>').replace(/\b(OR)\b/g, '<span style="color:#4f8ef7;">OR</span>').replace(/\b(NOT)\b/g, '<span style="color:#e0607a;">NOT</span>')}
      </div>
    </div>`
    )
    .join("");
}

function renderEmailHtml({ name, primaryTitle, primaryRegion, items, requestId }) {
  const greetName = name ? name.split(" ")[0] : "there";
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
  <body style="margin:0;padding:0;background:#eef1f8;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 12px 60px;">
    <div style="background:#ffffff;border:1px solid rgba(15,18,25,0.08);border-radius:14px;overflow:hidden;">
      <div style="padding:28px 32px 20px;text-align:center;border-bottom:1px solid rgba(15,18,25,0.06);">
        <div style="font-weight:800;font-size:15px;letter-spacing:0.02em;color:#0f1219;">THE DAILY <span style="color:#4f8ef7;">TALENT</span></div>
        <div style="display:inline-block;margin-top:14px;background:rgba(200,168,75,0.12);border:1px solid rgba(200,168,75,0.35);color:#9c7c2e;font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;padding:5px 12px;border-radius:100px;">10 Boolean Strings Ready</div>
      </div>
      <div style="padding:26px 32px 8px;">
        <h1 style="font-size:22px;font-weight:800;color:#0f1219;margin:0 0 10px;">Hi ${escHtml(greetName)} — your Boolean strings for <span style="color:#4f8ef7;">${escHtml(primaryTitle || "your role")}</span> in <span style="color:#4f8ef7;">${escHtml(primaryRegion || "your region")}</span> are ready.</h1>
        <p style="font-size:14px;line-height:1.6;color:#4a5568;margin:0 0 4px;">Tagged by where each one works best, so you don't hit a platform's word limit by accident.</p>
      </div>
      <div style="height:1px;background:rgba(15,18,25,0.07);margin:22px 32px;"></div>
      <div style="padding:0 32px;font-size:11px;font-weight:600;letter-spacing:0.09em;text-transform:uppercase;color:#7a85a0;margin-bottom:14px;">LinkedIn — Jobs Tab</div>
      ${renderStringBlocksHtml(items.filter((i) => i.dot === "jobs"))}
      <div style="padding:0 32px;font-size:11px;font-weight:600;letter-spacing:0.09em;text-transform:uppercase;color:#7a85a0;margin-bottom:14px;">LinkedIn — Posts Tab</div>
      ${renderStringBlocksHtml(items.filter((i) => i.dot === "posts"))}
      <div style="padding:0 32px;font-size:11px;font-weight:600;letter-spacing:0.09em;text-transform:uppercase;color:#7a85a0;margin-bottom:14px;">Google X-Ray</div>
      ${renderStringBlocksHtml(items.filter((i) => i.dot === "xray"))}
      <div style="height:1px;background:rgba(15,18,25,0.07);margin:22px 32px;"></div>
      <div style="padding:26px 32px 30px;text-align:center;">
        <p style="font-size:14px;color:#4a5568;margin-bottom:14px;">Did these match what you were searching for?</p>
        <div>
          <a href="https://tools.thedailytalent.com/api/rate-email?id=${encodeURIComponent(requestId || "")}&score=5" style="display:inline-block;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;background:#0f1219;color:#ffffff;margin-right:10px;">Yes, spot on →</a>
          <a href="https://tools.thedailytalent.com/api/rate-email?id=${encodeURIComponent(requestId || "")}&score=2" style="display:inline-block;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;background:#f7f8fc;color:#4a5568;border:1px solid rgba(15,18,25,0.1);">Not quite</a>
        </div>
        <div style="margin-top:16px;font-size:11.5px;color:#9aa3b8;">
          Build another string at <a href="https://tools.thedailytalent.com" style="color:#4f8ef7;">tools.thedailytalent.com</a>
        </div>
      </div>
    </div>
  </div>
  </body></html>`;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Verify the call actually came from Supabase, not a random POST
  const secret = req.headers["x-webhook-secret"];
  if (!secret || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const payload = req.body;
    const record = payload.record || payload.new || payload;

    const email = record.email;
    if (!email) return res.status(400).json({ error: "No email on record" });

    const intent = {
      titles: record.titles || [],
      regions: record.regions || [],
      must_skills: record.must_skills || [],
      nice_skills: record.nice_skills || [],
    };

    const items = buildTenStrings(intent);
    const html = renderEmailHtml({
      name: record.name,
      primaryTitle: intent.titles[0],
      primaryRegion: intent.regions[0],
      items,
      requestId: record.id,
    });

    const sendRes = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + process.env.RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM,
        to: email,
        reply_to: "support@thedailytalent.com",
        subject: "Your 10 Boolean strings are ready \u2192",
        html: html,
      }),
    });

    if (!sendRes.ok) {
      const errText = await sendRes.text();
      console.error("Resend error:", errText);
      return res.status(502).json({ error: "Email send failed" });
    }

    // Best-effort: stamp the source row so you can query who's actually
    // received a pack (and, by absence, who hasn't — a built-in failure log).
    if (record.id) {
      try {
        await fetch(
          `${process.env.SUPABASE_URL}/rest/v1/boolean_requests?id=eq.${encodeURIComponent(record.id)}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              apikey: process.env.SUPABASE_SECRET_KEY,
              Authorization: "Bearer " + process.env.SUPABASE_SECRET_KEY,
              Prefer: "return=minimal",
            },
            body: JSON.stringify({ pack_sent_at: new Date().toISOString() }),
          }
        );
      } catch (e) {
        console.error("pack_sent_at stamp error:", e);
        // Non-fatal — the email already sent successfully either way.
      }
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error("send-boolean-pack error:", err);
    return res.status(500).json({ error: "Internal error" });
  }
};
