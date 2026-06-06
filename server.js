require('dotenv').config();

const express = require('express');
const path = require('path');
const { getDb } = require('./src/db/db');
const apiRoutes = require('./src/api/routes');
const { start: startCron, getStatus: getCronStatus } = require('./src/scheduler/cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'src/public')));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api', apiRoutes);

// Cron status endpoint
app.get('/api/cron/status', (req, res) => {
  res.json(getCronStatus());
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src/public/index.html'));
});

// ── Start server ──────────────────────────────────────────────────────────────
function start() {
  // Initialize DB (creates tables if needed)
  try {
    getDb();
    console.log('[DB] Database initialized');
  } catch (err) {
    console.error('[DB] Failed to initialize database:', err.message);
    process.exit(1);
  }

  // Start cron scheduler
  if (process.env.DISABLE_CRON !== 'true') {
    startCron();
  }

  app.listen(PORT, () => {
    console.log(`\n🏏 India Cricket Dashboard`);
    console.log(`   Server running at http://localhost:${PORT}`);
    console.log(`   API health: http://localhost:${PORT}/api/health`);
    console.log(`   Press Ctrl+C to stop\n`);
  });
}

start();

module.exports = app;
