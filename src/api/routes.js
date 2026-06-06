const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { scrapeAll, scrapeSchedule } = require('../scraper/bcci-scraper');
const { generateSeriesSummary } = require('../scraper/ai-fallback');

let syncInProgress = false;

// ── Helper ────────────────────────────────────────────────────────────────────

function formatMatchesResponse(matches) {
  return matches.map(m => ({
    ...m,
    raw_data: m.raw_data ? (() => { try { return JSON.parse(m.raw_data); } catch { return {}; } })() : {},
  }));
}

// ── GET /api/matches/men ──────────────────────────────────────────────────────

router.get('/matches/men', (req, res) => {
  try {
    const { status, limit } = req.query;
    const matches = db.getMatches('matches_men', { status, limit: limit ? parseInt(limit) : undefined });
    res.json({
      success: true,
      team: 'men',
      count: matches.length,
      lastSync: db.getLastSyncTime(),
      matches: formatMatchesResponse(matches),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/matches/women ────────────────────────────────────────────────────

router.get('/matches/women', (req, res) => {
  try {
    const { status, limit } = req.query;
    const matches = db.getMatches('matches_women', { status, limit: limit ? parseInt(limit) : undefined });
    res.json({
      success: true,
      team: 'women',
      count: matches.length,
      lastSync: db.getLastSyncTime(),
      matches: formatMatchesResponse(matches),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/matches/upcoming ─────────────────────────────────────────────────

router.get('/matches/upcoming', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const { men, women } = db.getUpcomingMatches(days);
    res.json({
      success: true,
      days,
      lastSync: db.getLastSyncTime(),
      men: formatMatchesResponse(men),
      women: formatMatchesResponse(women),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/matches/all ──────────────────────────────────────────────────────

router.get('/matches/all', (req, res) => {
  try {
    const men = db.getAllMatches('matches_men');
    const women = db.getAllMatches('matches_women');
    res.json({
      success: true,
      lastSync: db.getLastSyncTime(),
      men: formatMatchesResponse(men),
      women: formatMatchesResponse(women),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/sync ────────────────────────────────────────────────────────────

router.post('/sync', async (req, res) => {
  if (syncInProgress) {
    return res.status(409).json({ success: false, error: 'Sync already in progress' });
  }

  syncInProgress = true;
  const startTime = Date.now();
  const team = req.body?.team || 'both'; // 'men', 'women', or 'both'

  // Respond immediately so client knows sync started
  res.json({ success: true, message: 'Sync started', team });

  try {
    const teams = team === 'both' ? ['men', 'women'] : [team];
    let totalInserted = 0;
    let totalUpdated = 0;
    let allWarnings = [];

    for (const t of teams) {
      try {
        const result = await scrapeSchedule(t);
        if (result.matches.length > 0) {
          const table = t === 'men' ? 'matches_men' : 'matches_women';
          const stats = db.bulkUpsertMatches(table, result.matches);
          totalInserted += stats.inserted;
          totalUpdated += stats.updated;

          db.insertSyncLog({
            sync_type: 'manual',
            team: t,
            status: result.warning ? 'partial' : 'success',
            records_inserted: stats.inserted,
            records_updated: stats.updated,
            records_total: stats.total,
            error_message: result.warning || null,
            duration_ms: Date.now() - startTime,
            snapshot_path: result.snapshotPath,
          });
        } else {
          db.insertSyncLog({
            sync_type: 'manual',
            team: t,
            status: result.warning ? 'failed' : 'success',
            records_inserted: 0,
            records_updated: 0,
            records_total: 0,
            error_message: result.warning || 'No matches returned',
            duration_ms: Date.now() - startTime,
            snapshot_path: result.snapshotPath,
          });
        }

        if (result.warning) allWarnings.push(`${t}: ${result.warning}`);
        console.log(`[Sync] ${t} — inserted: ${totalInserted}, updated: ${totalUpdated}`);
      } catch (teamErr) {
        console.error(`[Sync] ${t} team sync error:`, teamErr.message);
        db.insertSyncLog({
          sync_type: 'manual',
          team: t,
          status: 'failed',
          error_message: teamErr.message,
          duration_ms: Date.now() - startTime,
        });
      }
    }
  } catch (err) {
    console.error('[Sync] Unexpected error:', err.message);
    db.insertSyncLog({
      sync_type: 'manual',
      team,
      status: 'failed',
      error_message: err.message,
      duration_ms: Date.now() - startTime,
    });
  } finally {
    syncInProgress = false;
  }
});

// ── GET /api/sync/status ──────────────────────────────────────────────────────

router.get('/sync/status', (req, res) => {
  res.json({ inProgress: syncInProgress });
});

// ── GET /api/sync/log ─────────────────────────────────────────────────────────

router.get('/sync/log', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const logs = db.getSyncLogs(limit);
    res.json({ success: true, count: logs.length, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/ai-usage ─────────────────────────────────────────────────────────

router.get('/ai-usage', (req, res) => {
  try {
    const logs = db.getAiUsageLogs(50);
    const summary = db.getAiUsageSummary();
    res.json({ success: true, logs, summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/series/summary ──────────────────────────────────────────────────

router.post('/series/summary', async (req, res) => {
  const { series_id, team = 'men' } = req.body;
  if (!series_id) return res.status(400).json({ success: false, error: 'series_id required' });

  try {
    const table = team === 'men' ? 'matches_men' : 'matches_women';
    const matches = db.getMatches(table, { series_id });
    if (matches.length === 0) {
      return res.status(404).json({ success: false, error: 'Series not found' });
    }

    const seriesName = matches[0].series_name;
    const summary = await generateSeriesSummary(seriesName, matches, team);

    res.json({ success: true, series_id, series_name: seriesName, summary, match_count: matches.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/health ───────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  try {
    const menCount = db.getMatches('matches_men').length;
    const womenCount = db.getMatches('matches_women').length;
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      matches: { men: menCount, women: womenCount },
      lastSync: db.getLastSyncTime(),
      syncInProgress,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

module.exports = router;
