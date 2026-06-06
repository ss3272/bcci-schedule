/**
 * Static export script — reads from SQLite DB and writes JSON data files
 * to docs/data/ for GitHub Pages hosting.
 * Run after sync: npm run export
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../src/db/db');

const OUT_DIR = path.join(__dirname, '../docs/data');
fs.mkdirSync(OUT_DIR, { recursive: true });

function write(filename, data) {
  const fullPath = path.join(OUT_DIR, filename);
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`[Export] Written: docs/data/${filename} (${JSON.stringify(data).length} bytes)`);
}

function parseRaw(matches) {
  return matches.map(m => ({
    ...m,
    raw_data: m.raw_data ? (() => { try { return JSON.parse(m.raw_data); } catch { return {}; } })() : {},
  }));
}

function main() {
  console.log('[Export] Exporting DB to static JSON files...');

  const men = parseRaw(db.getAllMatches('matches_men'));
  const women = parseRaw(db.getAllMatches('matches_women'));

  write('matches-men.json', { success: true, team: 'men', count: men.length, matches: men });
  write('matches-women.json', { success: true, team: 'women', count: women.length, matches: women });

  const syncLogs = db.getSyncLogs(15);
  write('sync-log.json', { success: true, count: syncLogs.length, logs: syncLogs });

  const aiLogs = db.getAiUsageLogs(50);
  const aiSummary = db.getAiUsageSummary();
  write('ai-usage.json', { success: true, logs: aiLogs, summary: aiSummary });

  const meta = {
    lastSync: db.getLastSyncTime(),
    exportedAt: new Date().toISOString(),
    counts: { men: men.length, women: women.length },
  };
  write('meta.json', meta);

  console.log(`[Export] Done. ${men.length} men's, ${women.length} women's matches exported.`);
}

main();
