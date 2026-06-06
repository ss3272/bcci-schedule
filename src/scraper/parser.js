/**
 * HTML/JSON parser for BCCI schedule data.
 * Tries multiple CSS selector strategies since BCCI's HTML changes periodically.
 */

const cheerio = require('cheerio');
const crypto = require('crypto');

// ── Utilities ─────────────────────────────────────────────────────────────────

function hashMatchId(series, teams, date) {
  const raw = `${series}|${teams}|${date}`;
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 16);
}

function normalizeMatchType(raw = '') {
  const s = raw.toUpperCase().replace(/[^A-Z0-9\s]/g, '').trim();
  if (s.includes('TEST')) return 'Test';
  if (s.includes('T20I') || (s.includes('T20') && s.includes('INT'))) return 'T20I';
  if (s.includes('T20')) return 'T20';
  if (s.includes('ODI') || s.includes('ONE DAY')) return 'ODI';
  if (s.includes('WODI') || s.includes('WOMEN') && s.includes('ODI')) return 'W-ODI';
  if (s.includes('WT20')) return 'W-T20I';
  return raw.trim() || 'T20';
}

function parseIstToUtc(dateStr) {
  if (!dateStr) return null;
  try {
    // BCCI typically shows dates like "12 Jun, 2025" or "Jun 12, 2025"
    // and times like "7:00 PM IST"
    const cleaned = dateStr.replace(/\s+/g, ' ').trim();
    // Remove IST suffix and parse as UTC+5:30
    const withoutIst = cleaned.replace(/\s*IST/i, '');
    const date = new Date(withoutIst);
    if (isNaN(date.getTime())) return null;
    // Subtract 5:30 to convert IST → UTC
    return new Date(date.getTime() - 5.5 * 60 * 60 * 1000).toISOString();
  } catch {
    return null;
  }
}

function formatIst(utcIso) {
  if (!utcIso) return '';
  try {
    const date = new Date(utcIso);
    return date.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return utcIso;
  }
}

function inferStatus(dateUtc, rawStatus = '') {
  const s = rawStatus.toLowerCase();
  if (s.includes('live') || s.includes('in progress')) return 'live';
  if (s.includes('result') || s.includes('completed') || s.includes('won') || s.includes('drawn')) return 'completed';
  if (!dateUtc) return 'upcoming';
  const matchTime = new Date(dateUtc);
  const now = new Date();
  if (matchTime > now) return 'upcoming';
  // If match was more than 2 days ago and no explicit status, mark completed
  if (now - matchTime > 2 * 24 * 60 * 60 * 1000) return 'completed';
  return 'live';
}

// ── BCCI HTML parsing strategies ──────────────────────────────────────────────

/**
 * Strategy 1: Parse BCCI's typical match-card structure
 * Selectors as of 2024-2025 BCCI site
 */
function parseBcciCards($) {
  const matches = [];

  // BCCI uses divs with class patterns like 'match-card', 'fixture-card', etc.
  const cardSelectors = [
    '.match-card',
    '.fixture-item',
    '.fixtures-card',
    '[class*="match-card"]',
    '[class*="fixture"]',
    '.uk-card',
    '.schedule-card',
    '[data-match-id]',
  ];

  let cards = $();
  for (const sel of cardSelectors) {
    cards = $(sel);
    if (cards.length > 0) break;
  }

  cards.each((_, card) => {
    const $card = $(card);
    const raw = {};

    // Try to extract series name
    raw.series = $card.find('[class*="series"], [class*="tournament"], h2, h3, h4').first().text().trim()
      || $card.closest('[class*="series"]').find('h2, h3').first().text().trim();

    // Teams
    raw.teams = $card.find('[class*="team"], [class*="opponent"]')
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);

    // Venue
    raw.venue = $card.find('[class*="venue"], [class*="ground"], [class*="stadium"]').first().text().trim();

    // Date/Time
    raw.dateStr = $card.find('[class*="date"], [class*="time"], time').first().text().trim();

    // Match type
    raw.matchType = $card.find('[class*="match-type"], [class*="format"], [class*="type"]').first().text().trim();

    // Status / result
    raw.statusStr = $card.find('[class*="status"], [class*="result"]').first().text().trim();

    // Match number / ID from DOM
    raw.matchNum = $card.attr('data-match-id') || $card.attr('id') || '';

    if (raw.series || raw.teams.length || raw.dateStr) {
      matches.push(buildMatch(raw));
    }
  });

  return matches;
}

/**
 * Strategy 2: Parse JSON-LD or inline JSON data that BCCI sometimes embeds
 */
function parseBcciJsonLd($) {
  const matches = [];
  $('script[type="application/ld+json"], script[type="application/json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const events = data['@graph'] || (data['@type'] === 'SportsEvent' ? [data] : []);
      for (const ev of events) {
        if (!ev) continue;
        matches.push(buildMatch({
          series: ev.name || '',
          teams: [ev.homeTeam?.name, ev.awayTeam?.name].filter(Boolean),
          venue: ev.location?.name || '',
          dateStr: ev.startDate || '',
          matchType: ev.additionalType || '',
          statusStr: ev.eventStatus || '',
        }));
      }
    } catch {
      // Ignore parse failures on individual script tags
    }
  });
  return matches;
}

/**
 * Strategy 3: Brute-force extraction from any table rows
 */
function parseBcciTable($) {
  const matches = [];
  $('table tbody tr, .schedule-row, [class*="schedule"] li').each((_, row) => {
    const $row = $(row);
    const cells = $row.find('td, th, [class*="cell"]').map((_, td) => $(td).text().trim()).get();
    if (cells.length < 2) return;

    const raw = {
      series: cells[0] || '',
      teams: cells[1] ? cells[1].split(' vs ') : [],
      venue: cells[2] || '',
      dateStr: cells[3] || cells[4] || '',
      matchType: cells[5] || '',
      statusStr: $row.find('[class*="status"]').text().trim(),
    };
    if (raw.series || raw.teams.length) matches.push(buildMatch(raw));
  });
  return matches;
}

function buildMatch(raw) {
  const teams = raw.teams || [];
  const teamHome = teams[0] || 'India';
  const teamAway = teams[1] || '';

  const dateUtc = parseIstToUtc(raw.dateStr) || (raw.dateStr ? new Date(raw.dateStr).toISOString() : null);
  const status = inferStatus(dateUtc, raw.statusStr || '');
  const matchType = normalizeMatchType(raw.matchType || raw.series || '');

  const seriesId = hashMatchId(raw.series || '', teams.join('-'), raw.dateStr || '');
  const matchId = hashMatchId(raw.series || '', teams.join('-'), raw.dateStr || (Date.now().toString()));

  return {
    match_id: matchId,
    series_name: raw.series || 'India Series',
    team_home: teamHome,
    team_away: teamAway,
    venue: raw.venue || '',
    city: extractCity(raw.venue || ''),
    match_date: dateUtc,
    match_date_ist: formatIst(dateUtc),
    match_type: matchType,
    status,
    result: raw.statusStr || null,
    score_home: raw.scoreHome || null,
    score_away: raw.scoreAway || null,
    winner: extractWinner(raw.statusStr || ''),
    series_id: seriesId,
    raw_data: raw,
  };
}

function extractCity(venue) {
  if (!venue) return '';
  // "Eden Gardens, Kolkata" → "Kolkata"
  const parts = venue.split(',');
  return parts[parts.length - 1].trim();
}

function extractWinner(result) {
  if (!result) return null;
  const m = result.match(/^(.*?)\s+(?:won|beat)/i);
  return m ? m[1].trim() : null;
}

// ── Main parse entry point ────────────────────────────────────────────────────

/**
 * Parses raw HTML from BCCI schedule page.
 * Tries strategies in order, returns best result.
 */
function parseScheduleHtml(html, team = 'men') {
  if (!html || html.trim().length < 200) {
    return { matches: [], strategy: 'none', warning: 'HTML too short or empty' };
  }

  const $ = cheerio.load(html);

  // Remove scripts and styles for cleaner parsing
  $('script:not([type*="json"]), style, noscript').remove();

  // Strategy 1: card-based
  let matches = parseBcciCards($);
  if (matches.length > 0) {
    return { matches: dedup(matches), strategy: 'card', warning: null };
  }

  // Strategy 2: JSON-LD
  matches = parseBcciJsonLd($);
  if (matches.length > 0) {
    return { matches: dedup(matches), strategy: 'json-ld', warning: null };
  }

  // Strategy 3: table
  matches = parseBcciTable($);
  if (matches.length > 0) {
    return { matches: dedup(matches), strategy: 'table', warning: null };
  }

  return {
    matches: [],
    strategy: 'none',
    warning: 'No matches found — HTML structure may have changed. AI fallback recommended.',
  };
}

/**
 * Parses structured JSON from BCCI API endpoints (if available)
 */
function parseScheduleJson(json) {
  if (!json || !json.matches) return [];
  return json.matches.map(m => buildMatch({
    series: m.series?.name || m.seriesName || '',
    teams: [m.teams?.[0]?.name, m.teams?.[1]?.name].filter(Boolean),
    venue: m.venue?.name || m.venueName || '',
    dateStr: m.startDateTime || m.matchDate || '',
    matchType: m.matchFormat || m.matchType || '',
    statusStr: m.status || m.matchResult || '',
    scoreHome: m.teams?.[0]?.score || '',
    scoreAway: m.teams?.[1]?.score || '',
  }));
}

function dedup(matches) {
  const seen = new Set();
  return matches.filter(m => {
    if (seen.has(m.match_id)) return false;
    seen.add(m.match_id);
    return true;
  });
}

module.exports = {
  parseScheduleHtml,
  parseScheduleJson,
  buildMatch,
  normalizeMatchType,
  formatIst,
  parseIstToUtc,
};
