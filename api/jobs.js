// /api/jobs.js — Vercel serverless function
// Proxies Adzuna job search securely. Credentials via Vercel env vars.
// Rate-limited to 200 calls/day via Supabase tool_events counter.

const COUNTRY_MAP = {
  "UAE": "ae", "Dubai": "ae", "Abu Dhabi": "ae",
  "Qatar": "qa", "Doha": "qa",
  "Saudi Arabia": "sa", "Riyadh": "sa", "Jeddah": "sa",
  "Bahrain": "bh", "Kuwait": "kw", "Oman": "om",
  "UK": "gb", "London": "gb", "United Kingdom": "gb",
  "USA": "us", "United States": "us",
  "India": "in", "Pakistan": "pk",
  "Canada": "ca", "Australia": "au",
  "Germany": "de", "France": "fr", "Netherlands": "nl",
};

function getCountry(region) {
  if (!region) return "ae";
  // Direct match
  if (COUNTRY_MAP[region]) return COUNTRY_MAP[region];
  // Partial match — iterate keys
  const r = region.toLowerCase();
  for (const [key, code] of Object.entries(COUNTRY_MAP)) {
    if (r.includes(key.toLowerCase()) || key.toLowerCase().includes(r)) return code;
  }
  // GCC / MENA / Global → default ae (largest GCC job market on Adzuna)
  return "ae";
}

async function checkDailyLimit(supabaseUrl, supabaseKey) {
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const res = await fetch(
      `${supabaseUrl}/rest/v1/tool_events?select=id&event=eq.live_jobs_fetch&created_at=gte.${today}T00:00:00Z`,
      { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } }
    );
    if (!res.ok) return false; // If check fails, allow through
    const rows = await res.json();
    return Array.isArray(rows) && rows.length >= 200;
  } catch {
    return false; // Fail open — never block users on a counter error
  }
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "https://tools.thedailytalent.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const { title, region } = req.query;

  if (!title || !title.trim()) {
    return res.status(400).json({ error: "title is required", jobs: [], total_results: 0 });
  }

  const ADZUNA_APP_ID  = process.env.ADZUNA_APP_ID;
  const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY;
  const SUPABASE_URL   = process.env.SUPABASE_URL   || "https://uewyupjaptelyuxtcibv.supabase.co";
  const SUPABASE_KEY   = process.env.SUPABASE_KEY   || process.env.SUPABASE_ANON_KEY;

  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) {
    console.error("Missing ADZUNA_APP_ID or ADZUNA_APP_KEY env vars");
    return res.status(200).json({ jobs: [], total_results: 0, error: "service_unavailable" });
  }

  // Daily rate-limit guard (200 calls/day)
  if (SUPABASE_URL && SUPABASE_KEY) {
    const limited = await checkDailyLimit(SUPABASE_URL, SUPABASE_KEY);
    if (limited) {
      return res.status(200).json({
        jobs: [],
        total_results: 0,
        fallback: true,
        message: "Daily job search limit reached. Try again tomorrow."
      });
    }
  }

  const country = getCountry(region);
  const cleanTitle = title.trim().slice(0, 100);
  const cleanRegion = (region || "").trim().slice(0, 80);

  // Build Adzuna API URL
  const params = new URLSearchParams({
    app_id: ADZUNA_APP_ID,
    app_key: ADZUNA_APP_KEY,
    results_per_page: "6",
    what: cleanTitle,
    content_type: "application/json",
  });
  if (cleanRegion && !["MENA","GCC","Global"].includes(cleanRegion)) {
    params.set("where", cleanRegion);
  }

  const adzunaUrl = `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params.toString()}`;

  try {
    const upstream = await fetch(adzunaUrl, {
      headers: { Accept: "application/json" },
      // 8s timeout
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => "");
      console.error(`Adzuna ${upstream.status}: ${errText.slice(0, 200)}`);
      return res.status(200).json({ jobs: [], total_results: 0, error: "upstream_error" });
    }

    const data = await upstream.json();
    const raw = data.results || [];

    // Normalise to clean schema
    const jobs = raw.map((j) => ({
      title:        j.title        || "",
      company:      j.company?.display_name || "",
      location:     j.location?.display_name || "",
      redirect_url: j.redirect_url  || "",
      created:      j.created       || null,
      company_logo: null, // Adzuna doesn't provide logos — reserved for future enrichment
    }));

    // Cache for 10 min (Vercel edge / CDN)
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=300");

    return res.status(200).json({
      jobs,
      total_results: data.count || jobs.length,
    });

  } catch (err) {
    console.error("jobs.js fetch error:", err.message || err);
    return res.status(200).json({ jobs: [], total_results: 0, error: "fetch_error" });
  }
}
