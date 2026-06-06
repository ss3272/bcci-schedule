/**
 * BCCI schedule scraper.
 * Primary: Playwright (headless Chromium) for JS-rendered pages.
 * Fallback: Axios + Cheerio for static HTML.
 * AI fallback: Claude Haiku when both fail or return empty data.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { parseScheduleHtml } = require('./parser');
const { extractMatchesFromHtml, categorizeSeries } = require('./ai-fallback');

const SNAPSHOTS_DIR = path.join(__dirname, '../../snapshots');
fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });

const BCCI_URLS = {
  men: 'https://www.bcci.tv/matches/schedule/men',
  women: 'https://www.bcci.tv/matches/schedule/women',
};

// ESPN Cricinfo fallback
const ESPN_URLS = {
  men: 'https://www.espncricinfo.com/cricket-schedule/international/india',
  women: 'https://www.espncricinfo.com/cricket-schedule/international/india/women',
};

const DELAY_MS = 2500; // Respectful delay between requests

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function saveSnapshot(html, team, source) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${team}-${source}-${ts}.html`;
  const fullPath = path.join(SNAPSHOTS_DIR, filename);
  try {
    fs.writeFileSync(fullPath, html, 'utf8');
    return fullPath;
  } catch {
    return null;
  }
}

// ── Playwright scraper ────────────────────────────────────────────────────────

async function scrapeWithPlaywright(url, team) {
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    throw new Error('Playwright not installed');
  }

  const browser = await playwright.chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    // Block images, fonts, and trackers to speed up loading
    await page.route('**/*', route => {
      const rt = route.request().resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(rt)) {
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for content to render
    await page.waitForTimeout(2000);

    // Try to wait for schedule-specific elements
    try {
      await page.waitForSelector('[class*="match"], [class*="fixture"], [class*="schedule"]', { timeout: 5000 });
    } catch {
      // Continue even if selector not found
    }

    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}

// ── Axios fallback scraper ────────────────────────────────────────────────────

async function scrapeWithAxios(url) {
  const response = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'keep-alive',
    },
    maxRedirects: 5,
  });
  return response.data;
}

// ── BCCI API endpoint probe ────────────────────────────────────────────────────

async function tryBcciApi(team) {
  const endpoints = [
    `https://www.bcci.tv/api/schedule/${team}`,
    `https://www.bcci.tv/api/matches/${team}/schedule`,
    `https://api.bcci.tv/schedule/${team}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await axios.get(endpoint, {
        timeout: 8000,
        headers: { 'Accept': 'application/json' },
      });
      if (res.data && typeof res.data === 'object') {
        return res.data;
      }
    } catch {
      // Try next endpoint
    }
  }
  return null;
}

// ── Main scrape function ──────────────────────────────────────────────────────

/**
 * Scrapes the BCCI schedule for the given team.
 * Returns { matches, snapshotPath, source, warning }
 */
async function scrapeSchedule(team = 'men') {
  const url = BCCI_URLS[team];
  let html = null;
  let source = 'unknown';
  let snapshotPath = null;
  let warning = null;

  console.log(`[Scraper] Starting scrape for ${team}'s team from ${url}`);

  // Step 1: Try BCCI JSON API first (fast and structured)
  try {
    const apiData = await tryBcciApi(team);
    if (apiData && apiData.matches?.length > 0) {
      const { parseScheduleJson } = require('./parser');
      const matches = parseScheduleJson(apiData);
      if (matches.length > 0) {
        console.log(`[Scraper] BCCI API returned ${matches.length} matches for ${team}`);
        return { matches, snapshotPath: null, source: 'bcci-api', warning: null };
      }
    }
  } catch (err) {
    console.log(`[Scraper] BCCI API not available: ${err.message}`);
  }

  // Step 2: Try Playwright (handles JS-rendered content)
  try {
    console.log(`[Scraper] Trying Playwright for ${team}...`);
    html = await scrapeWithPlaywright(url, team);
    source = 'playwright-bcci';
    snapshotPath = saveSnapshot(html, team, 'playwright');
    console.log(`[Scraper] Playwright fetched ${html.length} bytes`);
  } catch (err) {
    console.log(`[Scraper] Playwright failed: ${err.message}`);
  }

  await delay(DELAY_MS);

  // Step 3: Axios fallback if Playwright failed or returned short HTML
  if (!html || html.length < 1000) {
    try {
      console.log(`[Scraper] Trying Axios for ${team}...`);
      html = await scrapeWithAxios(url);
      source = 'axios-bcci';
      snapshotPath = saveSnapshot(html, team, 'axios');
      console.log(`[Scraper] Axios fetched ${html.length} bytes`);
    } catch (err) {
      console.log(`[Scraper] Axios BCCI failed: ${err.message}`);
    }
  }

  await delay(DELAY_MS);

  // Step 4: Try ESPN Cricinfo if BCCI is blocked
  if (!html || html.length < 1000) {
    try {
      console.log(`[Scraper] Trying ESPN Cricinfo fallback for ${team}...`);
      html = await scrapeWithAxios(ESPN_URLS[team]);
      source = 'espn-cricinfo';
      snapshotPath = saveSnapshot(html, team, 'espn');
      console.log(`[Scraper] ESPN fetched ${html.length} bytes`);
    } catch (err) {
      console.log(`[Scraper] ESPN fallback failed: ${err.message}`);
      warning = 'Both BCCI and ESPN scraping failed';
    }
  }

  if (!html) {
    console.log(`[Scraper] All HTTP sources failed for ${team}`);
    return { matches: [], snapshotPath: null, source: 'failed', warning: 'All sources failed' };
  }

  // Step 5: Parse the HTML
  const parseResult = parseScheduleHtml(html, team);
  console.log(`[Scraper] Parser (${parseResult.strategy}) found ${parseResult.matches.length} matches`);

  // Step 6: AI fallback if parser returned nothing (keeps costs minimal)
  if (parseResult.matches.length === 0 && parseResult.warning) {
    console.log(`[Scraper] Parser empty — activating AI fallback`);
    const aiMatches = await extractMatchesFromHtml(html, team);
    if (aiMatches.length > 0) {
      const { buildMatch } = require('./parser');
      const matches = aiMatches.map(m => buildMatch({
        series: m.series_name,
        teams: [m.team_home, m.team_away].filter(Boolean),
        venue: m.venue,
        dateStr: m.match_date,
        matchType: m.match_type,
        statusStr: m.result || m.status,
      }));
      console.log(`[Scraper] AI fallback extracted ${matches.length} matches`);
      return { matches, snapshotPath, source: source + '+ai', warning: parseResult.warning };
    }
  }

  return {
    matches: parseResult.matches,
    snapshotPath,
    source,
    warning: warning || parseResult.warning,
  };
}

/**
 * Scrape both teams with a delay between requests.
 */
async function scrapeAll() {
  const results = {};

  results.men = await scrapeSchedule('men');
  await delay(DELAY_MS);
  results.women = await scrapeSchedule('women');

  return results;
}

module.exports = { scrapeSchedule, scrapeAll };
