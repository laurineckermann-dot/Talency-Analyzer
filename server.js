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

  let clientSlugs = [];
  try { clientSlugs = slugsParam ? JSON.parse(slugsParam) : []; } catch {}

  // A5: Gesamt-Zeitbudget — muss unter dem Frontend-Timeout (25s) bleiben
  const started = Date.now();
  const TIME_BUDGET_MS = 20000;

  // A4: Request-Fehler (Netzwerk/Timeout) getrennt von "kein Profil" zählen
  let attempts = 0, fetchErrors = 0;

  // Fix 1b-4: Die Kununu-Suche laeuft IMMER (sie findet den echten Slug,
  // z.B. "landeshauptstadt-muenchen"). Client-Slugs werden nur angehaengt.
  // Namens-Kernbegriffe zuerst berechnen — damit filtern wir die Suchtreffer.
  const norm = query.toLowerCase()
    .replace(/\u00e4/g,'ae').replace(/\u00f6/g,'oe').replace(/\u00fc/g,'ue').replace(/\u00df/g,'ss')
    .replace(/[^a-z0-9\s]/g,'').trim();
  const parts = norm.split(/\s+/);
  const stop = ['stadt','landkreis','kreis','gemeinde','amt','markt','der','die','das','von'];
  const core = parts.filter(p => !stop.includes(p));
  const coreTerms = core.length ? core : parts;

  let searchHits = [];
  try {
    attempts++;
    const searchResp = await axios.get(
      'https://www.kununu.com/de/search?term=' + encodeURIComponent(query),
      { headers: BROWSER_HEADERS, timeout: 6000, validateStatus: s => s < 500 }
    );
    const $s = cheerio.load(searchResp.data);
    $s('a[href^="/de/"]').each((_, el) => {
      const href = $s(el).attr('href');
      if (href && /^\/de\/[a-z0-9-]+$/.test(href) && !href.includes('search')) {
        const slug = href.replace('/de/', '');
        // Nur Treffer, die einen Kernbegriff des Namens enthalten —
        // sonst landen Navigationslinks (impressum, login, ...) in der Liste
        if (coreTerms.some(t => slug.includes(t)) && !searchHits.includes(slug)) {
          searchHits.push(slug);
        }
      }
    });
  } catch(e) { console.log('Kununu search failed:', e.message); fetchErrors++; }

  // Reihenfolge: max. 2 relevante Suchtreffer, dann manuelle Varianten, dann Client-Slugs
  let slugVariants = searchHits.slice(0, 2);
  const extras = [
    parts.join('-'), core.join('-'), parts.slice(-1)[0], core[0],
    'stadt-' + core.join('-'), 'stadtverwaltung-' + core.join('-'),
    'kreisverwaltung-' + core.join('-'), 'gemeinde-' + core.join('-'),
  ].filter((s, i, a) => s && s.length > 2 && a.indexOf(s) === i);
  extras.forEach(s => { if (!slugVariants.includes(s)) slugVariants.push(s); });
  clientSlugs.forEach(s => { if (!slugVariants.includes(s)) slugVariants.push(s); });

  // A5: maximal 5 Slug-Varianten testen (statt bis zu ~10)
  slugVariants = slugVariants.slice(0, 5);
  console.log('Kununu slugs for "' + query + '":', slugVariants.join(', '));

  for (const slug of slugVariants) {
    // A5: Zeitbudget prüfen, bevor der nächste Slug probiert wird
    if (Date.now() - started > TIME_BUDGET_MS) {
      console.log('Kununu: Zeitbudget erreicht, breche Slug-Suche ab');
      break;
    }
    const profileUrl = 'https://www.kununu.com/de/' + slug;
    try {
      attempts++;
      const resp = await axios.get(profileUrl, {
        headers: BROWSER_HEADERS, timeout: 5000, validateStatus: s => s < 500
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

      // A2: keine erfundenen Default-Werte mehr —
      // fehlender Score oder fehlende Empfehlungsrate ergeben 0 Teilpunkte
      const scorePart = overallScore !== null ? (overallScore / 5) * 60 : 0;
      const recPart = recommendRate !== null ? recommendRate * 0.3 : 0;

      return res.json({
        found: true, query, slug, profileUrl,
        overallScore, reviewCount, recommendRate,
        reviews: reviews.slice(0,3),
        candidateScore: Math.min(100, Math.round(
          scorePart + recPart + Math.min(10, reviewCount)
        ))
      });
    } catch(e) { fetchErrors++; console.log('Kununu slug failed:', slug, e.message); continue; }
  }

  // A4: unterscheiden — waren alle Requests Fehler (Netzwerk/Timeout/Block)
  // oder haben wir gültige Antworten bekommen, nur ohne passendes Profil?
  const unreachable = attempts > 0 && fetchErrors === attempts;
  console.log(
    unreachable
      ? 'Kununu UNREACHABLE for "' + query + '" (' + fetchErrors + '/' + attempts + ' Requests fehlgeschlagen)'
      : 'Kununu: no profile found for "' + query + '", tried: ' + slugVariants.join(', ')
  );
  res.json({
    found: false, query, candidateScore: 0,
    error: unreachable ? 'Kununu nicht erreichbar (Netzwerk/Timeout)' : null,
    reason: unreachable ? 'Kununu nicht erreichbar' : 'Kein Kununu-Profil gefunden'
  });
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

  // Fix 1b-2: Skala ergibt exakt 100 — Karriereseite (bis 80) + Stepstone (bis 20).
  // LinkedIn fliesst NICHT mehr ein (Fix 1b-1): der Check ist wegen der
  // Login-Wand unzuverlaessig und hat vorher jedem 35 Punkte geschenkt.
  res.json({
    linkedin, career, portals,
    employerScore: Math.min(100, career.score + portals.score)
  });
});

async function checkLinkedIn(query) {
  // Fix 1b-1: nur noch informativ, 0 Punkte. LinkedIn liefert Scrapern fast
  // immer eine Login-Wand (Status 200!) oder Status 999 — beides ist kein
  // verlaessliches Signal fuer ein gepflegtes Arbeitgeberprofil.
  try {
    const slug = query.toLowerCase()
      .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue')
      .replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
    const r = await axios.get(`https://www.linkedin.com/company/${slug}`, {
      headers: BROWSER_HEADERS, timeout: 6000, validateStatus: s => true, maxRedirects: 3
    });
    const body = typeof r.data === 'string' ? r.data.toLowerCase() : '';
    const wall = r.status === 999 || r.status === 429 ||
      body.includes('authwall') || body.includes('join linkedin') ||
      (body.includes('anmelden') && body.includes('registrieren'));
    if (wall) return { found: false, checkable: false, score: 0, note: 'LinkedIn nicht pruefbar (Login-Wand)' };
    return { found: r.status === 200 && body.length > 500, checkable: true, score: 0 };
  } catch { return { found: false, checkable: false, score: 0 }; }
}

async function checkCareerPage(query) {
  // Step 1: Google-Suche nach der echten Karriereseite
  const careerUrls = [];
  try {
    const searchQuery = encodeURIComponent(`${query} Karriere Stellenangebote`);
    const searchResp = await axios.get(
      `https://www.google.de/search?q=${searchQuery}&num=5&hl=de`,
      { headers: { ...BROWSER_HEADERS, 'Accept': 'text/html' }, timeout: 4000, validateStatus: s => s < 500 }
    );
    const $g = cheerio.load(searchResp.data);
    // Extract result URLs from Google
    $g('a[href^="/url?q="]').each((_, el) => {
      const href = $g(el).attr('href') || '';
      const match = href.match(/\/url\?q=(https?:\/\/[^&]+)/);
      if (match) {
        const url = decodeURIComponent(match[1]);
        // Only keep .de domains, skip job portals and aggregators
        if (url.includes('.de') &&
            !url.includes('google') &&
            !url.includes('stepstone') &&
            !url.includes('indeed') &&
            !url.includes('linkedin') &&
            !url.includes('kununu') &&
            !url.includes('meinestadt') &&
            !url.includes('stellenmarkt') &&
            !url.includes('jobs-beim-staat') &&
            !url.includes('wikipedia')) {
          careerUrls.push(url);
        }
      }
    });
    console.log(`Career search for "${query}": found URLs:`, careerUrls.slice(0,3));
  } catch(e) {
    console.log('Google career search failed:', e.message);
  }

  // Step 2: Fallback — klassische URL-Muster
  const slug = query.toLowerCase()
    .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
    .replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
  const core = slug.replace(/^(stadt|landkreis|kreis|gemeinde)-/,'');
  const fallbackUrls = [
    `https://www.${core}.de/rathaus-service/karriere`,
    `https://www.${core}.de/karriere`,
    `https://www.${core}.de/jobs`,
    `https://karriere.${core}.de`,
    `https://www.${core}.de/stellenangebote`,
    `https://www.${slug}.de/karriere`,
    `https://www.${slug}.de/rathaus/karriere`,
    `https://www.${slug}.de/arbeitgeber`
  ];

  // Combine: Google results first, then fallbacks — max 5 total to keep response fast
  const allUrls = [...new Set([...careerUrls.slice(0,2), ...fallbackUrls])].slice(0,5);

  for (const url of allUrls) {
    try {
      const r = await axios.get(url, { headers: BROWSER_HEADERS, timeout: 4000, validateStatus: s => s < 500 });
      if (r.status !== 200 || r.data.length < 500) continue;

      const $ = cheerio.load(r.data);
      const html = r.data.toLowerCase();
      const text = $.text().toLowerCase();

      // ── Kriterien-Bewertung ──────────────────────────────────────
      let score = 15; // Basis: Karriereseite existiert
      const criteria = [];

      // 1. Imagevideo (YouTube, Vimeo, video-Tag, iframe mit video) → +20 Punkte
      const hasVideo =
        html.includes('youtube.com/embed') ||
        html.includes('youtu.be') ||
        html.includes('vimeo.com') ||
        html.includes('<video') ||
        html.includes('recruitingfilm') ||
        html.includes('imagevideo') ||
        html.includes('arbeitgebervideo') ||
        $('iframe[src*="youtube"], iframe[src*="vimeo"], video').length > 0;
      if (hasVideo) { score += 20; criteria.push('Imagevideo vorhanden'); }
      else { criteria.push('Kein Imagevideo'); }

      // 2. Offene Stellen direkt auf der Seite → +15 Punkte
      const hasJobs =
        text.includes('stellenangebot') ||
        text.includes('offene stellen') ||
        text.includes('jetzt bewerben') ||
        text.includes('stellenausschreibung') ||
        $('a[href*="stell"], a[href*="job"], a[href*="bewerbung"]').length > 2;
      if (hasJobs) { score += 15; criteria.push('Stellenangebote sichtbar'); }
      else { criteria.push('Keine Stellenangebote sichtbar'); }

      // 3. Arbeitgeberversprechen / Benefits → +10 Punkte
      const hasBenefits =
        text.includes('benefit') ||
        text.includes('wir bieten') ||
        text.includes('ihre vorteile') ||
        text.includes('work-life') ||
        text.includes('homeoffice') ||
        text.includes('flexible arbeitszeit') ||
        text.includes('weiterbildung') ||
        text.includes('warum wir');
      if (hasBenefits) { score += 10; criteria.push('Benefits / Arbeitgeberversprechen'); }
      else { criteria.push('Keine Benefits kommuniziert'); }

      // 4. Bilder / Fotos von echten Mitarbeitern → +8 Punkte
      const hasImages =
        $('img').length > 3 &&
        (html.includes('team') || html.includes('mitarbeiter') || html.includes('kollegen'));
      if (hasImages) { score += 8; criteria.push('Team-Bilder vorhanden'); }
      else { criteria.push('Keine Team-Bilder erkannt'); }

      // 5. Kontakt / Ansprechpartner → +7 Punkte
      const hasContact =
        text.includes('ansprechpartner') ||
        text.includes('recruiter') ||
        text.includes('personalreferat') ||
        text.includes('hr-team') ||
        text.includes('bewerbung@') ||
        $('a[href^="mailto:"]').length > 0;
      if (hasContact) { score += 7; criteria.push('Ansprechpartner / Kontakt'); }
      else { criteria.push('Kein Ansprechpartner'); }

      // 6. Mobiloptimierung (viewport meta tag) → +5 Punkte
      const hasMobile = html.includes('viewport') && html.includes('width=device-width');
      if (hasMobile) { score += 5; criteria.push('Mobiloptimiert'); }
      else { criteria.push('Nicht mobiloptimiert'); }

      console.log(`Career page: ${url} → score ${score}, video: ${hasVideo}`);

      return {
        found: true,
        url,
        score: Math.min(100, score),
        hasVideo,
        hasJobs,
        hasBenefits,
        hasImages,
        hasContact,
        hasMobile,
        criteria
      };
    } catch { continue; }
  }
  return { found: false, score: 5, criteria: ['Keine Karriereseite gefunden'] };
}

async function checkJobPortals(query) {
  // Fix 1b-3: max 20 Punkte (neue EB-Skala), keine Geschenk-Punkte mehr,
  // und Abruf-Fehler werden als error markiert statt wie "0 Jobs" auszusehen.
  try {
    const r = await axios.get(`https://www.stepstone.de/jobs/${encodeURIComponent(query)}`, {
      headers: BROWSER_HEADERS, timeout: 6000, validateStatus: s => s < 500
    });
    if (r.status !== 200) {
      return { found: false, score: 0, error: 'Stepstone blockiert (Status ' + r.status + ')' };
    }
    const $ = cheerio.load(r.data);
    const el = $('[data-testid="jobs-count"]');
    if (!el.length) {
      // Selektor greift nicht — Seitenstruktur geaendert oder Bot-Wand
      return { found: false, score: 0, error: 'Stepstone-Zaehler nicht lesbar' };
    }
    const cnt = parseInt(el.text().replace(/\D/g,'')) || 0;
    return { found: cnt > 0, jobCount: cnt, score: Math.min(20, cnt * 3) };
  } catch (e) { return { found: false, score: 0, error: 'Stepstone nicht erreichbar' }; }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Talency Analyzer API → http://localhost:${PORT}`);
  console.log(`   /api/meta-validate · /api/meta-ads · /api/kununu · /api/employer-branding`);
});
