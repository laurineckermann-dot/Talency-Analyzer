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

// ╔════════════════════════════════════════════════════════════════════╗
// ║  META TOKEN — HIER EINFÜGEN                                         ║
// ║  Trage deinen langlebigen Meta-Token zwischen die Anführungszeichen ║
// ║  in der nächsten Zeile ein und lass ihn dort stehen.                ║
// ║  Beispiel:  const META_TOKEN = 'EAAxxxxxxxxxxxxxxxxxxxx';           ║
// ║  (Sicherer wäre eine .env-Variable META_TOKEN — beides wird unten   ║
// ║   automatisch genutzt; die .env hat Vorrang.)                       ║
// ╚════════════════════════════════════════════════════════════════════╝
const META_TOKEN = process.env.META_TOKEN || '';

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
  const token = req.query.token || META_TOKEN;   // Server-Token als Fallback
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
  const { query, active_status = 'ALL' } = req.query;
  const token = req.query.token || META_TOKEN;   // Server-Token als Fallback
  if (!query) return res.status(400).json({ error: 'query erforderlich' });
  if (!token) return res.status(400).json({ error: 'Kein Meta-Token gesetzt (Server-Token leer und keiner übergeben)' });
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
// "Steckverbindung" (Interface), an die sich JEDE Kununu-Quelle halten muss:
//   Treffer:      { found:true, slug, profileUrl, overallScore, reviewCount, recommendRate, reviews:[] }
//   kein Treffer: { found:false }
// Um später den bezahlten Anbieter anzubinden: neue Funktion mit GENAU dieser
// Rückgabe schreiben und bei KUNUNU_SOURCE eintragen — der Endpoint bleibt gleich.

// Slug-Kandidaten aus dem Namen bauen (Fallback, wenn keine Slugs mitgegeben werden)
function buildKununuSlugs(query) {
  const norm = query.toLowerCase()
    .replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss')
    .replace(/[^a-z0-9\s]/g,'').trim();
  const parts = norm.split(/\s+/);
  const stop = ['stadt','landkreis','kreis','gemeinde','amt','der','die','das','von'];
  const core = parts.filter(p => !stop.includes(p));
  return [
    parts.join('-'), core.join('-'), parts.slice(-1)[0], core[0],
    'stadt-' + core.join('-'), 'stadtverwaltung-' + core.join('-'),
    'kreisverwaltung-' + core.join('-'), 'gemeinde-' + core.join('-'),
  ].filter((s, i, a) => s && s.length > 2 && a.indexOf(s) === i);
}

// ▸ AKTIVE QUELLE: Scraping (bisherige Logik, in eine austauschbare Funktion gekapselt)
async function kununuSourceScrape(query, slugsParam) {
  let slugVariants = [];
  try { slugVariants = slugsParam ? JSON.parse(slugsParam) : []; } catch {}

  // Kununu-Suche nach korrektem Slug, falls keiner mitgegeben
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

    buildKununuSlugs(query).forEach(s => { if (!slugVariants.includes(s)) slugVariants.push(s); });
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

      if (!(overallScore !== null || reviewCount > 0)) continue;

      console.log('Kununu found:', query, '-> slug:', slug, 'score:', overallScore, 'reviews:', reviewCount);
      return { found: true, slug, profileUrl, overallScore, reviewCount, recommendRate, reviews: reviews.slice(0,3) };
    } catch(e) { console.log('Kununu slug failed:', slug, e.message); continue; }
  }
  return { found: false };
}

// ▸ HIER die Quelle wechseln (heute: Scraping; später: bezahlter Anbieter mit gleicher Rückgabe)
const KUNUNU_SOURCE = kununuSourceScrape;

// Score-Berechnung bleibt zentral, unabhängig von der Quelle
function kununuCandidateScore(d) {
  return Math.min(100, Math.round(
    ((d.overallScore || 3) / 5) * 60 +
    (d.recommendRate ? d.recommendRate * 0.3 : 15) +
    Math.min(10, d.reviewCount || 0)
  ));
}

// ── KUNUNU ENDPOINT (stabil — ruft nur den Adapter) ──────────────
app.get('/api/kununu', async (req, res) => {
  const { query, slugs: slugsParam } = req.query;
  if (!query) return res.status(400).json({ error: 'query erforderlich' });
  try {
    const d = await KUNUNU_SOURCE(query, slugsParam);
    if (!d || !d.found) {
      console.log('Kununu: no profile found for "' + query + '"');
      return res.json({ found: false, query, candidateScore: 0, reason: 'Kein Kununu-Profil gefunden' });
    }
    return res.json({ ...d, query, candidateScore: kununuCandidateScore(d) });
  } catch (e) {
    console.log('Kununu adapter error:', e.message);
    return res.json({ found: false, query, candidateScore: 0, reason: 'Kununu-Abfrage fehlgeschlagen' });
  }
});

// ── EMPLOYER BRANDING ─────────────────────────────────────────────
app.get('/api/employer-branding', async (req, res) => {
  const { query } = req.query;
  if (!query) return res.status(400).json({ error: 'query erforderlich' });

  // LinkedIn entfernt (unzuverlässiges Signal / aktiv blockiert). Nur Karriereseite + Jobportale.
  const [career, portals] = await Promise.allSettled([
    checkCareerPage(query),
    checkJobPortals(query)
  ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : { found: false, score: 0 }));

  // Fallback bei 0 Arbeitsagentur-Treffern: eigene Karriereseite der Behörde prüfen
  // (least-risk: es ist die eigene öffentliche Seite; wird ohnehin schon geladen).
  // Wir erkennen nur das VORHANDENSEIN von Stellen, keine exakte Zahl -> moderater Basiswert.
  if ((portals.jobCount || 0) === 0 && career && career.hasJobs) {
    portals.found = true;
    portals.viaCareerPage = true;
    portals.score = Math.max(portals.score || 0, 8);
  }

  res.json({ career, portals });
});

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
      if (hasVideo) { score += 20; criteria.push('📹 Imagevideo vorhanden'); }
      else { criteria.push('❌ Kein Imagevideo'); }

      // 2. Offene Stellen direkt auf der Seite → +15 Punkte
      const hasJobs =
        text.includes('stellenangebot') ||
        text.includes('offene stellen') ||
        text.includes('jetzt bewerben') ||
        text.includes('stellenausschreibung') ||
        $('a[href*="stell"], a[href*="job"], a[href*="bewerbung"]').length > 2;
      if (hasJobs) { score += 15; criteria.push('✅ Stellenangebote sichtbar'); }
      else { criteria.push('❌ Keine Stellenangebote sichtbar'); }

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
      if (hasBenefits) { score += 10; criteria.push('✅ Benefits / Arbeitgeberversprechen'); }
      else { criteria.push('❌ Keine Benefits kommuniziert'); }

      // 4. Bilder / Fotos von echten Mitarbeitern → +8 Punkte
      const hasImages =
        $('img').length > 3 &&
        (html.includes('team') || html.includes('mitarbeiter') || html.includes('kollegen'));
      if (hasImages) { score += 8; criteria.push('✅ Team-Bilder vorhanden'); }
      else { criteria.push('❌ Keine Team-Bilder erkannt'); }

      // 5. Kontakt / Ansprechpartner → +7 Punkte
      const hasContact =
        text.includes('ansprechpartner') ||
        text.includes('recruiter') ||
        text.includes('personalreferat') ||
        text.includes('hr-team') ||
        text.includes('bewerbung@') ||
        $('a[href^="mailto:"]').length > 0;
      if (hasContact) { score += 7; criteria.push('✅ Ansprechpartner / Kontakt'); }
      else { criteria.push('❌ Kein Ansprechpartner'); }

      // 6. Mobiloptimierung (viewport meta tag) → +5 Punkte
      const hasMobile = html.includes('viewport') && html.includes('width=device-width');
      if (hasMobile) { score += 5; criteria.push('✅ Mobiloptimiert'); }
      else { criteria.push('❌ Nicht mobiloptimiert'); }

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
  return { found: false, score: 5, criteria: ['❌ Keine Karriereseite gefunden'] };
}

// Stellenanzeigen-Reichweite über die OFFIZIELLE Arbeitsagentur-Jobsuche-API.
// WICHTIG: Der arbeitgeber-Filter matcht nur den EXAKTEN offiziellen Namen
// (z.B. "Stadt Coburg" => 0, aber "Stadt Coburg Personal- und Organisationsamt" => 3).
// Deshalb kombinieren wir zwei Wege und nehmen das Maximum:
//   A) Ort-Scan (wo=Ort) + unscharfer Filter (Kern-Ort + Typ-Wort, ohne Firmen wie GmbH)
//   B) exakte Namensvarianten (fängt Großstädte, die im Scan zu spät kämen)
// Live getestet: Coburg 3 · München 5 · Nürnberg 7 · Köln 12.
const AA_BASE = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobs';
const AA_KEY = process.env.ARBEITSAGENTUR_KEY || 'jobboerse-jobsuche';

async function aaQuery(params) {
  const r = await axios.get(AA_BASE, {
    params, headers: { 'X-API-Key': AA_KEY, 'Accept': 'application/json' },
    timeout: 9000, validateStatus: s => s < 500
  });
  return r.data || {};
}

async function checkJobPortals(query) {
  try {
    const q = query.toLowerCase();
    const TYPE = ['landeshauptstadt','landkreis','kreisverwaltung','kreisfreie','stadtverwaltung',
      'gemeindeverwaltung','landratsamt','stadt','gemeinde','markt','kreis','verbandsgemeinde',
      'samtgemeinde','magistrat','verwaltung','der','die','das','bei','am','an','im','von'];
    const cls = (q.includes('landkreis') || q.includes('kreis')) ? 'landkreis'
      : (['stadt','landeshauptstadt','gemeinde','markt','magistrat'].some(w => q.includes(w)) ? 'stadt' : null);
    const tokens = q.replace(/[^a-z0-9äöüß ]/g,' ').split(/\s+/).filter(t => t && !TYPE.includes(t));
    const core = tokens[0] || q.trim();

    const LK = ['landkreis','landratsamt','kreisverwaltung','kreisausschuss'];
    const ST = ['stadt','landeshauptstadt','gemeinde','markt','magistrat','stadtverwaltung','gemeindeverwaltung'];
    const EXCLUDE = ['gmbh','mbh',' ag','e.v','e. v','holding','klinik','sparkasse','stiftung'];

    // A) Ort-Scan (max. 2 Seiten à 100), Arbeitgeber unscharf zuordnen
    const employers = {};
    for (const page of [1,2]) {
      const d = await aaQuery({ wo: core, umkreis: 0, size: 100, page });
      for (const s of (d.stellenangebote || [])) {
        const ag = (s.arbeitgeber || '').trim(), l = ag.toLowerCase();
        if (!l.includes(core)) continue;
        if (EXCLUDE.some(x => l.includes(x))) continue;
        if (cls === 'landkreis' && !LK.some(m => l.includes(m))) continue;
        if (cls === 'stadt' && (!ST.some(m => l.includes(m)) || LK.some(m => l.includes(m)))) continue;
        if (cls === null && !LK.concat(ST).some(m => l.includes(m))) continue;
        employers[ag] = (employers[ag] || 0) + 1;
      }
      if ((parseInt(d.maxErgebnisse) || 0) <= page * 100) break;
    }
    const scanCount = Object.values(employers).reduce((a,b) => a + b, 0);

    // B) exakte Namensvarianten (deckt Großstädte ab)
    const cap = core.charAt(0).toUpperCase() + core.slice(1);
    const variants = [query];
    if (cls === 'stadt') variants.push(`Stadt ${cap}`, `Landeshauptstadt ${cap}`, `Gemeinde ${cap}`, `Markt ${cap}`);
    if (cls === 'landkreis') variants.push(`Landkreis ${cap}`, `Landratsamt ${cap}`, `Kreisverwaltung ${cap}`);
    let exactBest = 0;
    for (const v of [...new Set(variants)]) {
      try { const d = await aaQuery({ arbeitgeber: v, size: 1 }); exactBest = Math.max(exactBest, parseInt(d.maxErgebnisse) || 0); }
      catch {}
    }

    const jobCount = Math.max(scanCount, exactBest);
    console.log(`Arbeitsagentur "${query}": core=${core} typ=${cls} scan=${scanCount} exakt=${exactBest} => ${jobCount}`);
    return {
      found: jobCount > 0,
      jobCount,
      matchedEmployers: Object.keys(employers).slice(0,5),
      score: Math.min(25, jobCount * 3 + 5)
    };
  } catch (e) {
    console.log('Arbeitsagentur query failed:', e.message);
    return { found: false, score: 5 };
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Talency Analyzer API → http://localhost:${PORT}`);
  console.log(`   /api/meta-validate · /api/meta-ads · /api/kununu · /api/employer-branding`);
});
