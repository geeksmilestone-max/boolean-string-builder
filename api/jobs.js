// /api/jobs.js — Vercel serverless function
// Uses Apify agentx~all-jobs-scraper (LinkedIn, Indeed, Glassdoor, Bayt, Naukri)
// Rate-limited to 200 calls/day via Supabase tool_events counter.

// Map tool regions → Apify country full names
const COUNTRY_MAP = {
  // GCC
  "UAE":              "United Arab Emirates",
  "Dubai":            "United Arab Emirates",
  "Abu Dhabi":        "United Arab Emirates",
  "Sharjah":          "United Arab Emirates",
  "United Arab Emirates": "United Arab Emirates",
  "Qatar":            "Qatar",
  "Doha":             "Qatar",
  "Saudi Arabia":     "Saudi Arabia",
  "Riyadh":           "Saudi Arabia",
  "Jeddah":           "Saudi Arabia",
  "KSA":              "Saudi Arabia",
  "Bahrain":          "Bahrain",
  "Manama":           "Bahrain",
  "Kuwait":           "Kuwait",
  "Kuwait City":      "Kuwait",
  "Oman":             "Oman",
  "Muscat":           "Oman",
  // MENA
  "Egypt":            "Egypt",
  "Cairo":            "Egypt",
  "Jordan":           "Jordan",
  "Amman":            "Jordan",
  "Lebanon":          "Lebanon",
  "Beirut":           "Lebanon",
  "Morocco":          "Morocco",
  "Casablanca":       "Morocco",
  // South Asia
  "Pakistan":         "Pakistan",
  "Karachi":          "Pakistan",
  "Lahore":           "Pakistan",
  "Islamabad":        "Pakistan",
  "India":            "India",
  "Mumbai":           "India",
  "Bangalore":        "India",
  "Delhi":            "India",
  "Sri Lanka":        "Sri Lanka",
  "Colombo":          "Sri Lanka",
  "Nepal":            "Nepal",
  // Western
  "UK":               "United Kingdom",
  "United Kingdom":   "United Kingdom",
  "London":           "United Kingdom",
  "USA":              "United States",
  "United States":    "United States",
  "Canada":           "Canada",
  "Toronto":          "Canada",
  "Australia":        "Australia",
  "Sydney":           "Australia",
  "Melbourne":        "Australia",
  "Germany":          "Germany",
  "Berlin":           "Germany",
  "France":           "France",
  "Paris":            "France",
  "Netherlands":      "Netherlands",
  "Amsterdam":        "Netherlands",
  "Singapore":        "Singapore",
  // Broad regions → best proxy country
  "GCC":              "United Arab Emirates",
  "MENA":             "United Arab Emirates",
  "Middle East":      "United Arab Emirates",
  "Global":           "United Arab Emirates",
  "Europe":           "United Kingdom",
  "Asia Pacific":     "Singapore",
};

function getCountry(region) {
  if (!region) return "United Arab Emirates";
  const r = region.trim();
  if (COUNTRY_MAP[r]) return COUNTRY_MAP[r];
  // Partial match
  const rl = r.toLowerCase();
  for (const [key, val] of Object.entries(COUNTRY_MAP)) {
    if (rl.includes(key.toLowerCase()) || key.toLowerCase().includes(rl)) return val;
  }
  return "United Arab Emirates"; // default to UAE for MENA-focused tool
}

async function checkDailyLimit(supabaseUrl, supabaseKey) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await fetch(
      `${supabaseUrl}/rest/v1/tool_events?select=id&event=eq.live_jobs_fetch&created_at=gte.${today}T00:00:00Z`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length >= 200;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://tools.thedailytalent.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { title, region } = req.query;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: "title is required", jobs: [], total_results: 0 });
  }

  const APIFY_TOKEN  = process.env.APIFY_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL  || "https://uewyupjaptelyuxtcibv.supabase.co";
  const SUPABASE_KEY = process.env.SUPABASE_KEY  || process.env.SUPABASE_ANON_KEY;

  if (!APIFY_TOKEN) {
    console.error("Missing APIFY_TOKEN env var");
    return res.status(200).json({ jobs: [], total_results: 0, error: "service_unavailable" });
  }

  // Daily rate-limit guard
  if (SUPABASE_URL && SUPABASE_KEY) {
    const limited = await checkDailyLimit(SUPABASE_URL, SUPABASE_KEY);
    if (limited) {
      return res.status(200).json({
        jobs: [], total_results: 0, fallback: true,
        message: "Daily job search limit reached. Try again tomorrow."
      });
    }
  }

  const cleanTitle  = title.trim().slice(0, 100);
  const cleanRegion = (region || "").trim().slice(0, 80);
  const country     = getCountry(cleanRegion);

  // Apify synchronous run — waits for result, returns dataset items directly
  const apifyUrl = `https://api.apify.com/v2/acts/agentx~all-jobs-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}&format=json&clean=true`;

  const input = {
    keyword:    cleanTitle,
    country:    country,
    maxResults: 6,
  };

  console.log(`Apify fetch: keyword="${cleanTitle}" country="${country}"`);

  try {
    const upstream = await fetch(apifyUrl, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(input),
      signal:  AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined, // 60s — scraper needs time
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      console.error(`Apify ${upstream.status}: ${errText.slice(0, 200)}`);
      return res.status(200).json({ jobs: [], total_results: 0, error: "upstream_error" });
    }

    const raw = await upstream.json(); // array of job objects

    if (!Array.isArray(raw) || raw.length === 0) {
      return res.status(200).json({ jobs: [], total_results: 0 });
    }

    // Normalise Apify output → our clean schema
    const jobs = raw.slice(0, 6).map((j) => ({
      title:        j.jobTitle       || j.title        || j.position    || "",
      company:      j.companyName    || j.company      || j.employer    || "",
      location:     j.jobLocation    || j.location     || j.city        || cleanRegion || "",
      redirect_url: j.jobUrl         || j.url          || j.applyUrl    || j.link      || "",
      created:      j.postedAt       || j.datePosted   || j.posted      || null,
      company_logo: j.companyLogo    || j.logo         || null,
    })).filter(j => j.title); // remove any empty results

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");
    return res.status(200).json({ jobs, total_results: jobs.length });

  } catch (err) {
    console.error("jobs.js Apify error:", err.message || err);
    return res.status(200).json({ jobs: [], total_results: 0, error: "fetch_error" });
  }
}
