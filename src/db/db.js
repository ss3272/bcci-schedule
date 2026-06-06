const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '../../data/cricket.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db;

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initSchema();
  }
  return _db;
}

function initSchema() {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  // Split on semicolons and run each statement
  schema
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .forEach(stmt => {
      try {
        _db.exec(stmt + ';');
      } catch (err) {
        if (!err.message.includes('already exists')) {
          throw err;
        }
      }
    });
}

// ── Match queries ─────────────────────────────────────────────────────────────

function upsertMatch(table, match) {
  const db = getDb();
  const existing = db.prepare(`SELECT id, raw_data FROM ${table} WHERE match_id = ?`).get(match.match_id);

  if (existing) {
    db.prepare(`
      UPDATE ${table} SET
        series_name = ?, team_home = ?, team_away = ?, venue = ?, city = ?,
        match_date = ?, match_date_ist = ?, match_type = ?, status = ?,
        result = ?, score_home = ?, score_away = ?, winner = ?,
        series_id = ?, raw_data = ?, updated_at = datetime('now')
      WHERE match_id = ?
    `).run(
      match.series_name, match.team_home, match.team_away, match.venue, match.city,
      match.match_date, match.match_date_ist, match.match_type, match.status,
      match.result, match.score_home, match.score_away, match.winner,
      match.series_id, JSON.stringify(match.raw_data || {}), match.match_id
    );
    return 'updated';
  } else {
    db.prepare(`
      INSERT INTO ${table}
        (match_id, series_name, team_home, team_away, venue, city,
         match_date, match_date_ist, match_type, status,
         result, score_home, score_away, winner, series_id, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      match.match_id, match.series_name, match.team_home, match.team_away,
      match.venue, match.city, match.match_date, match.match_date_ist,
      match.match_type, match.status, match.result, match.score_home,
      match.score_away, match.winner, match.series_id,
      JSON.stringify(match.raw_data || {})
    );
    return 'inserted';
  }
}

function bulkUpsertMatches(table, matches) {
  const db = getDb();
  let inserted = 0;
  let updated = 0;

  const txn = db.transaction(() => {
    for (const match of matches) {
      const result = upsertMatch(table, match);
      if (result === 'inserted') inserted++;
      else updated++;
    }
  });

  txn();
  return { inserted, updated, total: matches.length };
}

function getMatches(table, filters = {}) {
  const db = getDb();
  let query = `SELECT * FROM ${table}`;
  const conditions = [];
  const params = [];

  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters.from) {
    conditions.push('match_date >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('match_date <= ?');
    params.push(filters.to);
  }
  if (filters.series_id) {
    conditions.push('series_id = ?');
    params.push(filters.series_id);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY match_date ASC';

  if (filters.limit) {
    query += ` LIMIT ${parseInt(filters.limit)}`;
  }

  return db.prepare(query).all(...params);
}

function getAllMatches(table) {
  return getDb().prepare(`SELECT * FROM ${table} ORDER BY match_date ASC`).all();
}

function getUpcomingMatches(days = 30) {
  const db = getDb();
  const now = new Date().toISOString();
  const future = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const men = db.prepare(`
    SELECT *, 'men' as team_type FROM matches_men
    WHERE match_date >= ? AND match_date <= ? AND status != 'completed'
    ORDER BY match_date ASC
  `).all(now, future);

  const women = db.prepare(`
    SELECT *, 'women' as team_type FROM matches_women
    WHERE match_date >= ? AND match_date <= ? AND status != 'completed'
    ORDER BY match_date ASC
  `).all(now, future);

  return { men, women };
}

function getLastSyncTime() {
  const db = getDb();
  const row = db.prepare(`
    SELECT synced_at FROM sync_log WHERE status != 'failed' ORDER BY synced_at DESC LIMIT 1
  `).get();
  return row ? row.synced_at : null;
}

// ── Sync log queries ──────────────────────────────────────────────────────────

function insertSyncLog(log) {
  return getDb().prepare(`
    INSERT INTO sync_log (sync_type, team, status, records_inserted, records_updated, records_total, error_message, duration_ms, snapshot_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    log.sync_type, log.team, log.status,
    log.records_inserted || 0, log.records_updated || 0, log.records_total || 0,
    log.error_message || null, log.duration_ms || null, log.snapshot_path || null
  );
}

function getSyncLogs(limit = 10) {
  return getDb().prepare(`SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT ?`).all(limit);
}

// ── AI usage log queries ──────────────────────────────────────────────────────

function insertAiUsageLog(log) {
  return getDb().prepare(`
    INSERT INTO ai_usage_log (reason, model, prompt_tokens, completion_tokens, total_tokens, team, series_id, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    log.reason, log.model || 'claude-haiku-3-5',
    log.prompt_tokens || 0, log.completion_tokens || 0, log.total_tokens || 0,
    log.team || null, log.series_id || null,
    log.success !== false ? 1 : 0,
    log.error_message || null
  );
}

function getAiUsageLogs(limit = 50) {
  return getDb().prepare(`SELECT * FROM ai_usage_log ORDER BY called_at DESC LIMIT ?`).all(limit);
}

function getAiUsageSummary() {
  return getDb().prepare(`
    SELECT
      COUNT(*) as total_calls,
      SUM(total_tokens) as total_tokens_used,
      SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successful_calls,
      reason,
      DATE(called_at) as date
    FROM ai_usage_log
    GROUP BY DATE(called_at), reason
    ORDER BY date DESC
    LIMIT 30
  `).all();
}

module.exports = {
  getDb,
  upsertMatch,
  bulkUpsertMatches,
  getMatches,
  getAllMatches,
  getUpcomingMatches,
  getLastSyncTime,
  insertSyncLog,
  getSyncLogs,
  insertAiUsageLog,
  getAiUsageLogs,
  getAiUsageSummary,
};
