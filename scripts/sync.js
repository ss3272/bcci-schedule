/**
 * Standalone sync script — run via `npm run sync` or GitHub Actions.
 * Scrapes both teams and writes to the database, then exits.
 */

require('dotenv').config();

const { runSync } = require('../src/scheduler/cron');

console.log('[Sync Script] Starting manual sync...');

runSync('manual')
  .then(results => {
    console.log('[Sync Script] Complete:', JSON.stringify(results, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error('[Sync Script] Fatal error:', err.message);
    process.exit(1);
  });
