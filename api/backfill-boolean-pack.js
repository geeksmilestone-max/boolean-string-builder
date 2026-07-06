// /api/backfill-boolean-pack.js
//
// ONE-OFF TOOL — not triggered by a webhook. You call this manually
// (visit the URL in your browser) to send packs to everyone who submitted
// BEFORE the automated pipeline existed (i.e. pack_sent_at is still null).
//
// Usage:
//   https://tools.thedailytalent.com/api/backfill-boolean-pack?secret=YOUR_WEBHOOK_SECRET&limit=15
//
// Call it repeatedly (safe to re-run — it always picks up wherever it left off)
// until it reports remaining: 0. Respect Resend's 100/day free-tier cap by
// spreading calls across multiple days if your backlog is larger than that.
//
// Reuses the same env vars as your other functions:
//   RESEND_API_KEY, RESEND_FROM, WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SECRET_KEY

const RESEND_API_URL = "https://api.resend.com/emails";

const LIMITS = {
  jobsTabMaxChars: 500,
  postsTabMaxChars: 200,
  xrayMaxWords: 32,
};

// ── STRING-BUILDING (identical to send-boolean-pack.js) ──
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
  const results = [];

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

  const xrayCoreParts = [primaryTitle, primaryRegion].filter(Boolean);
  const xraySites = [
    { key: "li", prefix: "site:linkedin.com/in" },
    { key: "bayt", prefix: "site:bayt.com/en/jobs" },
    { key: "naukri", prefix: "site:naukrigulf.com/jobs-in" },
    { key: "indeed", prefix: "site:indeed.com/jobs" },
  ];
  xraySites.forEach((site, i) => {
    let parts = xrayCoreParts.slice();
    if (i === 1 && mustSkills[0]) parts.push(quoted(mustSkills[0]));
    let str = site.prefix + " " + parts.join(" ");
    let words = str.split(/\s+/);
    while (words.length > LIMITS.xrayMaxWords) words.pop();
    str = words.join(" ");
    results.push({ platform: "Google X-Ray", dot: "xray", value: str });
  });

  return results.slice(0, 10);
}
function charOrWordLabel(item) {
  if (item.dot === "xray") return wordCount(item.value) + " / " + LIMITS.xrayMaxWords + " words";
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
        <h1 style="font-size:22px;font-weight:800;color:#0f1219;margin:0 0 10px;">Hi ${escHtml(greetName)} — sorry for the wait, your Boolean strings for <span style="color:#4f8ef7;">${escHtml(primaryTitle || "your role")}</span> in <span style="color:#4f8ef7;">${escHtml(primaryRegion || "your region")}</span> are finally here.</h1>
        <p style="font-size:14px;line-height:1.6;color:#4a5568;margin:0 0 4px;">We were sending these by hand — this batch got caught in the backlog. Tagged by where each one works best, so you don't hit a platform's word limit by accident.</p>
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = async (req, res) => {
  const { secret, limit } = req.query;

  if (!secret || secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const batchSize = Math.min(parseInt(limit, 10) || 15, 20); // hard cap for safety

  try {
    // Pull the next batch of never-sent requests, newest first
    // (most recent searches are freshest / most likely still job-hunting).
    const listRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/boolean_requests?pack_sent_at=is.null&select=id,email,name,titles,regions,must_skills,nice_skills&order=created_at.desc&limit=${batchSize}`,
      {
        headers: {
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization: "Bearer " + process.env.SUPABASE_SECRET_KEY,
        },
      }
    );

    if (!listRes.ok) {
      const t = await listRes.text();
      return res.status(502).json({ error: "Failed to query backlog", detail: t });
    }

    const rows = await listRes.json();

    // Also get a total remaining count so you know how much backlog is left.
    const countRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/boolean_requests?pack_sent_at=is.null&select=id`,
      {
        headers: {
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization: "Bearer " + process.env.SUPABASE_SECRET_KEY,
          Prefer: "count=exact",
          Range: "0-0",
        },
      }
    );
    const contentRange = countRes.headers.get("content-range"); // e.g. "0-0/842"
    const totalRemaining = contentRange ? parseInt(contentRange.split("/")[1], 10) : null;

    let sent = 0;
    let failed = 0;
    const errors = [];

    for (const record of rows) {
      if (!record.email) continue;

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

      try {
        const sendRes = await fetch(RESEND_API_URL, {
          method: "POST",
          headers: {
            Authorization: "Bearer " + process.env.RESEND_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: process.env.RESEND_FROM,
            to: record.email,
            reply_to: "support@thedailytalent.com",
            subject: "Your 10 Boolean strings are ready (sorry for the wait) \u2192",
            html: html,
          }),
        });

        if (sendRes.ok) {
          sent++;
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
        } else {
          failed++;
          const errText = await sendRes.text();
          errors.push({ id: record.id, email: record.email, error: errText });
        }
      } catch (e) {
        failed++;
        errors.push({ id: record.id, email: record.email, error: String(e) });
      }

      // Small delay between sends to stay well under Resend's rate limits.
      await sleep(600);
    }

    return res.status(200).json({
      processed: rows.length,
      sent,
      failed,
      remaining_after_this_batch: totalRemaining !== null ? Math.max(totalRemaining - sent, 0) : "unknown",
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    console.error("backfill error:", err);
    return res.status(500).json({ error: "Internal error", detail: String(err) });
  }
};
