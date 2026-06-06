/**
 * Cricket schedule scraper.
 *
 * Source priority (each team):
 *  1. CricAPI (cricapi.com)   — free tier, works from any IP including GitHub Actions
 *  2. ESPN Cricinfo JSON API  — structured, blocked on cloud IPs
 *  3. Playwright on bcci.tv   — headless browser for JS-rendered page
 *  4. AI fallback             — Claude Haiku parses whatever HTML we got
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { buildMatch, parseScheduleHtml } = require('./parser');
const { extractMatchesFromHtml } = require('./ai-fallback');

const SNAPSHOTS_DIR = path.join(__dirname, '../../snapshots');
fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

// ESPN Cricinfo team IDs
const ESPN_TEAM_IDS = { men: 6, women: 289119 };

const DELAY_MS = 2000;
const AXIOS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/html, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function saveSnapshot(content, team, source) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const ext = typeof content === 'object' ? 'json' : 'html';
  const filename = `${team}-${source}-${ts}.${ext}`;
  try {
    const data = typeof content === 'object' ? JSON.stringify(content, null, 2) : content;
    fs.writeFileSync(path.join(SNAPSHOTS_DIR, filename), data, 'utf8');
    return path.join(SNAPSHOTS_DIR, filename);
  } catch { return null; }
}

// ── CricAPI (cricapi.com) ─────────────────────────────────────────────────────

function parseCricApiMatch(m, team) {
  const name = m.name || '';
  const teams = name.split(' vs ').map(s => s.trim());
  const india = teams.find(t => /india/i.test(t)) || 'India';
  const opponent = teams.find(t => !/india/i.test(t)) || '';

  // Filter: women's team check
  const isWomensMatch = /women/i.test(name) || /women/i.test(m.series || '');
  if (team === 'women' && !isWomensMatch) return null;
  if (team === 'men' && isWomensMatch) return null;

  const dateStr = m.date || m.dateTimeGMT || '';
  const dateUtc = dateStr ? new Date(dateStr).toISOString() : null;

  const formatMap = { 'TEST': 'Test', 'ODI': 'ODI', 'T20I': 'T20I', 'T20': 'T20', 'IT20': 'T20I' };
  const rawType = (m.matchType || '').toUpperCase();
  const matchType = formatMap[rawType] || m.matchType || 'T20I';

  let status = 'upcoming';
  const statusText = m.status || '';
  if (/won|lost|drew|tied|abandoned|no result/i.test(statusText)) status = 'completed';
  else if (/live|progress|inning/i.test(statusText)) status = 'live';
  else if (dateUtc && new Date(dateUtc) < new Date()) status = 'completed';

  const venue = m.venue || '';
  const seriesName = m.series || `India ${matchType} Series`;

  return buildMatch({
    series: seriesName,
    teams: [india, opponent].filter(Boolean),
    venue,
    dateStr: dateStr,
    matchType,
    statusStr: status === 'completed' ? (statusText || 'Result') : status,
    scoreHome: m.score?.[0] ? `${m.score[0].r}/${m.score[0].w}` : '',
    scoreAway: m.score?.[1] ? `${m.score[1].r}/${m.score[1].w}` : '',
    seriesId: String(m.id || ''),
  });
}

async function tryCricApi(team) {
  const key = process.env.CRICAPI_KEY;
  if (!key) {
    console.log('[Scraper] CRICAPI_KEY not set — skipping CricAPI');
    return null;
  }

  const endpoints = [
    `https://api.cricapi.com/v1/matches?apikey=${key}&offset=0`,
    `https://api.cricapi.com/v1/cricScore?apikey=${key}`,
  ];

  for (const url of endpoints) {
    try {
      console.log(`[Scraper] Trying CricAPI: ${url.replace(key, 'REDACTED')}`);
      const res = await axios.get(url, {
        timeout: 15000,
        headers: { ...AXIOS_HEADERS },
      });
      const data = res.data;

      if (data?.status !== 'success' && data?.status !== 'ok' && !Array.isArray(data?.data)) {
        console.log(`[Scraper] CricAPI response status: ${data?.status}`);
        if (data?.status === 'failure') {
          console.log(`[Scraper] CricAPI error: ${data?.reason || 'unknown'}`);
          break; // Bad key — no point retrying other endpoint
        }
        continue;
      }

      const rawMatches = Array.isArray(data?.data) ? data.data : [];
      const indiaMatches = rawMatches.filter(m => {
        const name = (m.name || '').toLowerCase();
        return name.includes('india');
      });

      if (indiaMatches.length > 0) {
        const matches = indiaMatches
          .map(m => parseCricApiMatch(m, team))
          .filter(Boolean);

        if (matches.length > 0) {
          console.log(`[Scraper] CricAPI returned ${matches.length} India ${team} matches`);
          return matches;
        }
      }

      console.log(`[Scraper] CricAPI: no India matches found in ${rawMatches.length} total matches`);
    } catch (err) {
      console.log(`[Scraper] CricAPI endpoint failed: ${err.message}`);
    }
    await delay(1000);
  }

  // Try the upcoming/recent matches endpoint
  try {
    const seriesUrl = `https://api.cricapi.com/v1/series?apikey=${key}&offset=0`;
    console.log(`[Scraper] Trying CricAPI series endpoint`);
    const res = await axios.get(seriesUrl, { timeout: 15000, headers: AXIOS_HEADERS });
    const data = res.data;

    if (data?.status === 'success' && Array.isArray(data?.data)) {
      const indiaSeries = data.data.filter(s => /india/i.test(s.name || ''));
      if (indiaSeries.length > 0) {
        const matches = [];
        for (const series of indiaSeries.slice(0, 5)) {
          const isWomens = /women/i.test(series.name || '');
          if (team === 'women' && !isWomens) continue;
          if (team === 'men' && isWomens) continue;

          try {
            const infoUrl = `https://api.cricapi.com/v1/series_info?apikey=${key}&id=${series.id}`;
            const infoRes = await axios.get(infoUrl, { timeout: 10000, headers: AXIOS_HEADERS });
            const info = infoRes.data;
            if (info?.status === 'success' && Array.isArray(info?.data?.matchList)) {
              for (const m of info.data.matchList) {
                const parsed = parseCricApiMatch({ ...m, series: series.name }, team);
                if (parsed) matches.push(parsed);
              }
            }
          } catch {}
          await delay(500);
        }

        if (matches.length > 0) {
          console.log(`[Scraper] CricAPI series endpoint returned ${matches.length} matches`);
          return matches;
        }
      }
    }
  } catch (err) {
    console.log(`[Scraper] CricAPI series endpoint failed: ${err.message}`);
  }

  return null;
}

// ── ESPN Cricinfo JSON API ─────────────────────────────────────────────────────

function parseEspnMatch(m, team) {
  const teams = (m.teams || []).map(t => t.team?.longName || t.team?.abbreviation || '');
  const india = teams.find(t => /india/i.test(t)) || 'India';
  const opponent = teams.find(t => !/india/i.test(t)) || '';

  const startDate = m.startDate || m.match?.startDate;
  const dateUtc = startDate ? new Date(startDate).toISOString() : null;

  const formatMap = { 'TEST': 'Test', 'ODI': 'ODI', 'T20I': 'T20I', 'T20': 'T20', 'IT20': 'T20I' };
  const matchFormat = m.matchFormat || m.international?.matchFormat || '';
  const matchType = formatMap[matchFormat.toUpperCase()] || matchFormat || 'T20I';

  const statusText = m.statusText || m.match?.statusText || '';
  let status = 'upcoming';
  if (/result|won|drew|tied|abandoned/i.test(statusText)) status = 'completed';
  else if (/live|progress|stumps/i.test(statusText)) status = 'live';
  else if (dateUtc && new Date(dateUtc) < new Date()) status = 'completed';

  const venue = m.ground?.longName || m.ground?.name || '';
  const city = m.ground?.city?.name || m.ground?.town?.name || '';
  const seriesName = m.series?.longName || m.series?.name || `India ${matchType} Series`;
  const seriesId = String(m.series?.objectId || m.series?.id || '');

  return buildMatch({
    series: seriesName,
    teams: [india, opponent].filter(Boolean),
    venue: [venue, city].filter(Boolean).join(', '),
    dateStr: startDate || '',
    matchType,
    statusStr: status === 'completed' ? (statusText || 'Result') : status,
    scoreHome: m.teams?.[0]?.score?.[0]?.runs != null
      ? `${m.teams[0].score[0].runs}/${m.teams[0].score[0].wickets}` : '',
    scoreAway: m.teams?.[1]?.score?.[0]?.runs != null
      ? `${m.teams[1].score[0].runs}/${m.teams[1].score[0].wickets}` : '',
    seriesId,
  });
}

async function tryEspnApi(team) {
  const teamId = ESPN_TEAM_IDS[team];

  const endpoints = [
    `https://hs-consumer-api.espncricinfo.com/v1/pages/team/schedule?lang=en&teamId=${teamId}`,
    `https://hs-consumer-api.espncricinfo.com/v1/pages/team/results?lang=en&teamId=${teamId}`,
  ];

  for (const url of endpoints) {
    try {
      console.log(`[Scraper] Trying ESPN API: ${url}`);
      const res = await axios.get(url, {
        timeout: 15000,
        headers: { ...AXIOS_HEADERS, 'Referer': 'https://www.espncricinfo.com/' },
      });
      const data = res.data;

      const rawMatches =
        data?.content?.matches ||
        data?.content?.recentFixtures ||
        data?.content?.upcomingFixtures ||
        data?.fixtures ||
        data?.matches ||
        [];

      if (rawMatches.length > 0) {
        console.log(`[Scraper] ESPN API returned ${rawMatches.length} matches`);
        return rawMatches.map(m => parseEspnMatch(m, team));
      }
    } catch (err) {
      console.log(`[Scraper] ESPN API endpoint failed: ${err.message}`);
    }
    await delay(1000);
  }
  return null;
}

// ── Playwright scraper ────────────────────────────────────────────────────────

async function scrapeWithPlaywright(url, team) {
  const playwright = require('playwright');
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    });
    const page = await context.newPage();

    const apiResponses = [];
    page.on('response', async response => {
      const resUrl = response.url();
      if (resUrl.includes('/api/') || resUrl.includes('schedule') || resUrl.includes('match')) {
        try {
          const ct = response.headers()['content-type'] || '';
          if (ct.includes('json')) {
            const json = await response.json().catch(() => null);
            if (json) apiResponses.push({ url: resUrl, json });
          }
        } catch {}
      }
    });

    await page.route('**/*', route => {
      const rt = route.request().resourceType();
      if (['image', 'font', 'media'].includes(rt)) return route.abort();
      return route.continue();
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 35000 });
    await page.waitForTimeout(3000);

    for (const { url: apiUrl, json } of apiResponses) {
      const matches =
        json?.matches || json?.data?.matches || json?.schedule?.matches ||
        json?.fixtures || json?.data?.fixtures || [];
      if (matches.length > 0) {
        console.log(`[Scraper] Playwright intercepted API at ${apiUrl} with ${matches.length} matches`);
        return { type: 'json', data: matches };
      }
    }

    const html = await page.content();
    return { type: 'html', data: html };
  } finally {
    await browser.close();
  }
}

// ── Main scrape function ──────────────────────────────────────────────────────

async function scrapeSchedule(team = 'men') {
  console.log(`[Scraper] Starting scrape for ${team}'s team`);
  let snapshotPath = null;
  let lastHtml = null;

  // ── Step 1: CricAPI ──
  try {
    const matches = await tryCricApi(team);
    if (matches && matches.length > 0) {
      return { matches, snapshotPath: null, source: 'cricapi', warning: null };
    }
  } catch (err) {
    console.log(`[Scraper] CricAPI error: ${err.message}`);
  }

  await delay(DELAY_MS);

  // ── Step 2: ESPN Cricinfo JSON API ──
  try {
    const matches = await tryEspnApi(team);
    if (matches && matches.length > 0) {
      return { matches, snapshotPath: null, source: 'espn-api', warning: null };
    }
  } catch (err) {
    console.log(`[Scraper] ESPN API error: ${err.message}`);
  }

  await delay(DELAY_MS);

  // ── Step 3: Playwright on bcci.tv ──
  try {
    console.log(`[Scraper] Trying Playwright on bcci.tv for ${team}...`);
    const result = await scrapeWithPlaywright(`https://www.bcci.tv/matches/schedule/${team}`, team);

    if (result.type === 'json' && result.data.length > 0) {
      const matches = result.data.map(m => buildMatch({
        series: m.series?.name || m.seriesName || 'India Series',
        teams: [m.teams?.[0]?.name, m.teams?.[1]?.name].filter(Boolean),
        venue: m.venue?.name || '',
        dateStr: m.startDateTime || m.matchDate || '',
        matchType: m.matchFormat || m.type || 'T20I',
        statusStr: m.status || m.result || '',
      }));
      return { matches, snapshotPath: null, source: 'playwright-bcci-api', warning: null };
    }

    if (result.type === 'html' && result.data.length > 500) {
      lastHtml = result.data;
      snapshotPath = saveSnapshot(lastHtml, team, 'playwright');
      console.log(`[Scraper] Playwright HTML: ${lastHtml.length} bytes`);

      const parsed = parseScheduleHtml(lastHtml, team);
      if (parsed.matches.length > 0) {
        return { matches: parsed.matches, snapshotPath, source: 'playwright-bcci-html', warning: null };
      }
    }
  } catch (err) {
    console.log(`[Scraper] Playwright failed: ${err.message}`);
  }

  await delay(DELAY_MS);

  // ── Step 4: AI fallback (only when all structured sources failed) ──
  if (lastHtml && lastHtml.length > 500) {
    console.log(`[Scraper] All parsers failed — activating AI fallback`);
    try {
      const aiMatches = await extractMatchesFromHtml(lastHtml, team);
      if (aiMatches.length > 0) {
        const matches = aiMatches.map(m => buildMatch({
          series: m.series_name, teams: [m.team_home, m.team_away].filter(Boolean),
          venue: m.venue, dateStr: m.match_date, matchType: m.match_type,
          statusStr: m.result || m.status,
        }));
        console.log(`[Scraper] AI fallback extracted ${matches.length} matches`);
        return { matches, snapshotPath, source: 'ai-fallback', warning: 'Used AI fallback parser' };
      }
    } catch (err) {
      console.log(`[Scraper] AI fallback error: ${err.message}`);
    }
  }

  return {
    matches: [],
    snapshotPath,
    source: 'failed',
    warning: 'All sources failed. Set these GitHub secrets: CRICAPI_KEY (get free key at cricapi.com), ANTHROPIC_API_KEY (for AI fallback).',
  };
}

async function scrapeAll() {
  const men = await scrapeSchedule('men');
  await delay(DELAY_MS);
  const women = await scrapeSchedule('women');
  return { men, women };
}

module.exports = { scrapeSchedule, scrapeAll };
