import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
dotenv.config();

const app = express();

// CORS: allow configured origins or all in dev
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['*'];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());

const META_VERSION = 'v21.0';
const META_BASE = `https://graph.facebook.com/${META_VERSION}`;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Cache-Control': 'no-cache'
};

// ── HEALTH CHECK ──────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'talency-analyzer-api' }));

// ── META TOKEN VALIDATE ───────────────────────────────────────────
app.get('/api/meta-validate', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ valid: false, error: 'Token fehlt' });
  try {
    const r = await fetch(`${META_BASE}/me?access_token=${token}`);
    const d = await r.json();
    if (d.error) return res.status(401).json({ valid: false, error: d.error.message });
    res.json({ valid: true, name: d.name });
  } catch (e) {
    res.status(500).json({ valid: false, error: e.message });
  }
});

// ── META AD LIBRARY ───────────────────────────────────────────────
app.get('/api/meta-ads', async (req, res) => {
  const { query, token, active_status = 'ALL' } = req.query;
  if (!query || !token) return res.status(400).json({ error: 'query und token erforderlich' });
  try {
    const params = new URLSearchParams({
      access_token: token,
      ad_type: 'EMPLOYMENT_ADS',
      ad_active_status: active_status,
      ad_reached_countries: 'DE',
      search_terms: query,
      fields: [
        'id', 'ad_creative_bodies', 'ad_creative_link_titles',
        'ad_creative_link_descriptions', 'page_name',
        'ad_delivery_start_time', 'ad_delivery_stop_time',
        'is_active', 'impressions', 'publisher_platforms'
      ].join(','),
      limit: 30
    });
    const r = await fetch(`${META_BASE}/ads_archive?${params}`);
    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message, code: d.error.code });
    res.json(d);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── KUNUNU SCRAPER ────────────────────────────────────────────────
app.get('/api/kununu', async (req, res) => {
  const { query, slugs: slugsParam } = req.query;
  if (!query) return res.status(400).json({ error: 'query erforderlich' });

  let slugVariants = [];
  try { slugVariants = slugsParam ? JSON.parse(slugsParam) : []; } catch {}

  // Step 1: Kununu search to find correct slug
  if (!slugVariants.length) {
    try {
      const searchResp = await axios.get(
        'https://www.kununu.com/de/search?term=' + encodeURIComponent(query),
        { headers: BROWSER_HEADERS, timeout: 8000, validateStatus: s => s < 500 }
      );
      const $s = cheerio.load(searchResp.data);
      $s('a[href^="/de/"]').each((_, el) => {
        const href = $s(el).attr('href');
        if (href && /^\/de\/[a-z0-9-]+$/.test(href) && !href.includes('search')) {
          const slug = href.replace('/de/', '');
          if (!slugVariants.includes(slug)) slugVariants.unshift(slug);
        }
      });
    } catch(e) { console.log('Kununu search failed:', e.message); }

    // Manual slug variants as fallback
    const norm = query.toLowerCase()
      .replace(/\u00e4/g,'ae').replace(/\u00f6/g,'oe').replace(/\u00fc/g,'ue').replace(/\u00df/g,'ss')
      .replace(/[^a-z0-9\s]/g,'').trim();
    const parts = norm.split(/\s+/);
    const stop = ['stadt','landkreis','kreis','gemeinde','amt','der','die','das','von'];
    const core = parts.filter(p => !stop.includes(p));
    const extras = [
      parts.join('-'), core.join('-'), parts.slice(-1)[0], core[0],
      'stadt-' + core.join('-'), 'stadtverwaltung-' + core.join('-'),
      'kreisverwaltung-' + core.join('-'), 'gemeinde-' + core.join('-'),
    ].filter((s, i, a) => s && s.length > 2 && a.indexOf(s) === i);
    extras.forEach(s => { if (!slugVariants.includes(s)) slugVariants.push(s); });
  }

  for (const slug of slugVariants) {
    const profileUrl = 'https://www.kununu.com/de/' + slug;
    try {
      const resp = await axios.get(profileUrl, {
        headers: BROWSER_HEADERS, timeout: 9000, validateStatus: s => s < 500
      });
      if (resp.status !== 200 || resp.data.length < 500) continue;

      const $ = cheerio.load(resp.data);

      // Try JSON-LD first (most reliable)
      let overallScore = null, reviewCount = 0;
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const json = JSON.parse($(el).html());
          if (json.aggregateRating) {
            overallScore = parseFloat(json.aggregateRating.ratingValue);
            reviewCount = parseInt(json.aggregateRating.reviewCount) || 0;
          }
        } catch {}
      });

      // CSS selector fallback
      if (!overallScore) {
        for (const sel of ['[data-test="score-overview-total"]','.score-overview__score','span[class*="score"]','div[class*="overall"] span']) {
          const text = $(sel).first().text().trim();
          const num = parseFloat(text.replace(',', '.'));
          if (num >= 1 && num <= 5) { overallScore = num; break; }
        }
      }

      // Review count fallback
      if (!reviewCount) {
        $('*').each((_, el) => {
          const m = $(el).clone().children().remove().end().text().match(/(\d+)\s*Bewertungen?/i);
          if (m && parseInt(m[1]) > reviewCount) reviewCount = parseInt(m[1]);
        });
      }

      // Recommend rate
      let recommendRate = null;
      const bodyText = $.text();
      const recMatch = bodyText.match(/(\d+)\s*%[^%]{0,30}(empfehlen|Weiterempfehlung)/i);
      if (recMatch) recommendRate = parseInt(recMatch[1]);

      // Review snippets
      const reviews = [];
      $('[data-test*="review"], article[class*="review"], div[class*="review-item"]').slice(0,4).each((_, el) => {
        const t = $(el).text().replace(/\s+/g,' ').trim().slice(0,200);
        if (t.length > 40) reviews.push(t);
      });

      const found = overallScore !== null || reviewCount > 0;
      if (!found) continue;

      console.log('Kununu found:', query, '-> slug:', slug, 'score:', overallScore, 'reviews:', reviewCount);

      return res.json({
        found: true, query, slug, profileUrl,
        overallScore, reviewCount, recommendRate,
        reviews: reviews.slice(0,3),
        candidateScore: Math.min(100, Math.round(
          ((overallScore || 3) / 5) * 60 +
          (recommendRate ? recommendRate * 0.3 : 15) +
          Math.min(10, reviewCount)
        ))
      });
    } catch(e) { console.log('Kununu slug failed:', slug, e.message); continue; }
  }

  console.log('Kununu: no profile found for "' + query + '", tried:', slugVariants.join(', '));
  res.json({ found: false, query, candidateScore: 0, reason: 'Kein Kununu-Profil gefunden' });
});

// ── EMPLOYER BRANDING ─────────────────────────────────────────────
app.get('/api/employer-branding', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query erforderlich' });

  const [linkedin, career, portals] = await Promise.allSettled([
    checkLinkedIn(query),
    checkCareerPage(query),
    checkJobPortals(query)
  ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : { found: false, score: 0 }));

  res.json({
    linkedin, career, portals,
    employerScore: Math.min(100, linkedin.score + career.score + portals.score)
  });
});

async function checkLinkedIn(query) {
  try {
    const slug = query.toLowerCase()
      .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue')
      .replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
    const r = await axios.get(`https://www.linkedin.com/company/${slug}`, {
      headers: BROWSER_HEADERS, timeout: 6000, validateStatus: s => s < 500
    });
    return { found: r.status === 200, score: r.status === 200 ? 35 : 5 };
  } catch { return { found: false, score: 5 }; }
}

async function checkCareerPage(query) {
  const slug = query.toLowerCase()
    .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
    .replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
  const urls = [
    `https://www.${slug}.de/karriere`,
    `https://www.${slug}.de/jobs`,
    `https://karriere.${slug}.de`,
    `https://www.${slug}.de/stellenangebote`
  ];
  for (const url of urls) {
    try {
      const r = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 5000, validateStatus: s => s < 500 });
      if (r.status === 200 && r.data.length > 500) return { found: true, url, score: 40 };
    } catch { continue; }
  }
  return { found: false, score: 8 };
}

async function checkJobPortals(query) {
  try {
    const r = await axios.get(`https://www.stepstone.de/jobs/${encodeURIComponent(query)}`, {
      headers: BROWSER_HEADERS, timeout: 6000, validateStatus: s => s < 500
    });
    const $ = cheerio.load(r.data);
    const cnt = parseInt($('[data-testid="jobs-count"]').text().replace(/\D/g,'')) || 0;
    return { found: cnt > 0, jobCount: cnt, score: Math.min(25, cnt * 3 + 5) };
  } catch { return { found: false, score: 5 }; }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Talency Analyzer API → http://localhost:${PORT}`);
  console.log(`   /api/meta-validate · /api/meta-ads · /api/kununu · /api/employer-branding`);
});
