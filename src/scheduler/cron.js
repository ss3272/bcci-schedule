/**
 * Daily cron scheduler — runs at 7:00 AM IST (01:30 UTC).
 * Scrapes both Men's and Women's schedules and updates the DB.
 * Does NOT call AI on routine runs.
 */

const cron = require('node-cron');
const { scrapeSchedule } = require('../scraper/bcci-scraper');
const { bulkUpsertMatches, insertSyncLog } = require('../db/db');

// 7:00 AM IST = 01:30 UTC
const DEFAULT_CRON = process.env.CRON_TIME || '30 1 * * *';

let cronJob = null;
let lastRunAt = null;
let isRunning = false;

async function runSync(syncType = 'cron') {
  if (isRunning) {
    console.log('[Cron] Sync already in progress, skipping');
    return;
  }

  isRunning = true;
  const startTime = Date.now();
  const teams = ['men', 'women'];
  const results = {};

  console.log(`[Cron] Starting ${syncType} sync at ${new Date().toISOString()}`);

  for (const team of teams) {
    const teamStart = Date.now();
    try {
      const scrapeResult = await scrapeSchedule(team);
      const table = team === 'men' ? 'matches_men' : 'matches_women';
      let stats = { inserted: 0, updated: 0, total: 0 };

      if (scrapeResult.matches.length > 0) {
        stats = bulkUpsertMatches(table, scrapeResult.matches);
      }

      results[team] = { ...stats, warning: scrapeResult.warning, source: scrapeResult.source };

      insertSyncLog({
        sync_type: syncType,
        team,
        status: scrapeResult.warning && scrapeResult.matches.length === 0 ? 'failed' : 'success',
        records_inserted: stats.inserted,
        records_updated: stats.updated,
        records_total: stats.total,
        error_message: scrapeResult.warning || null,
        duration_ms: Date.now() - teamStart,
        snapshot_path: scrapeResult.snapshotPath,
      });

      console.log(`[Cron] ${team}: inserted=${stats.inserted}, updated=${stats.updated}, source=${scrapeResult.source}`);
    } catch (err) {
      console.error(`[Cron] ${team} sync failed:`, err.message);
      results[team] = { error: err.message };

      insertSyncLog({
        sync_type: syncType,
        team,
        status: 'failed',
        error_message: err.message,
        duration_ms: Date.now() - teamStart,
      });
    }
  }

  lastRunAt = new Date().toISOString();
  const totalMs = Date.now() - startTime;
  console.log(`[Cron] Sync completed in ${totalMs}ms. Results:`, JSON.stringify(results));
  isRunning = false;

  return results;
}

function start() {
  if (cronJob) {
    console.log('[Cron] Job already running');
    return;
  }

  if (!cron.validate(DEFAULT_CRON)) {
    console.error(`[Cron] Invalid cron expression: ${DEFAULT_CRON}`);
    return;
  }

  cronJob = cron.schedule(DEFAULT_CRON, () => {
    runSync('cron').catch(err => console.error('[Cron] Unhandled error:', err));
  }, {
    timezone: 'UTC',
  });

  console.log(`[Cron] Scheduler started — runs at: ${DEFAULT_CRON} UTC (7:00 AM IST)`);
  return cronJob;
}

function stop() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log('[Cron] Scheduler stopped');
  }
}

function getStatus() {
  return {
    running: !!cronJob,
    isCurrentlySyncing: isRunning,
    lastRunAt,
    nextRun: DEFAULT_CRON,
    cronExpression: DEFAULT_CRON,
  };
}

module.exports = { start, stop, runSync, getStatus };
