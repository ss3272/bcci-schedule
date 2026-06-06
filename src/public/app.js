/**
 * Frontend JS for India Cricket Dashboard.
 * Communicates with the Express API — no direct scraping from browser.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  men: [],
  women: [],
  activeTab: 'men',
  activeFilter: { men: 'all', women: 'all' },
  syncPollTimer: null,
};

// ── API Helpers ───────────────────────────────────────────────────────────────

async function apiFetch(path, opts = {}) {
  const res = await fetch('/api' + path, opts);
  if (!res.ok) throw new Error(`API ${path} returned ${res.status}`);
  return res.json();
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadAllMatches();
  // Poll sync status every 5s while sync in progress
  setInterval(checkSyncStatus, 5000);
});

async function loadAllMatches() {
  try {
    const [menData, womenData] = await Promise.all([
      apiFetch('/matches/men'),
      apiFetch('/matches/women'),
    ]);

    state.men = menData.matches || [];
    state.women = womenData.matches || [];

    renderTeam('men');
    renderTeam('women');

    updateLastSync(menData.lastSync || womenData.lastSync);
  } catch (err) {
    console.error('Failed to load matches:', err);
    showError('men');
    showError('women');
  }
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

function switchTab(team) {
  state.activeTab = team;

  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });

  document.getElementById('tab-' + team).classList.add('active');
  const panel = document.getElementById('panel-' + team);
  panel.classList.remove('hidden');
  panel.classList.add('active');
}

// ── Filter ────────────────────────────────────────────────────────────────────

function filterMatches(team, filter, btn) {
  state.activeFilter[team] = filter;

  const panel = document.getElementById('panel-' + team);
  panel.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  renderTeam(team);
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderTeam(team) {
  const matches = state[team];
  const filter = state.activeFilter[team];

  const live = matches.filter(m => m.status === 'live');
  const upcoming = matches.filter(m => m.status === 'upcoming');
  const completed = matches.filter(m => m.status === 'completed');

  // Apply filter
  let visible;
  switch (filter) {
    case 'live':      visible = live; break;
    case 'upcoming':  visible = upcoming; break;
    case 'completed': visible = completed; break;
    default:          visible = matches; break;
  }

  // Live section
  const liveSection = document.getElementById(team + '-live-series');
  const liveGrid = document.getElementById(team + '-live-matches');
  if (live.length > 0 && (filter === 'all' || filter === 'live')) {
    liveSection.classList.remove('hidden');
    liveGrid.innerHTML = live.map(renderCard).join('');
  } else {
    liveSection.classList.add('hidden');
  }

  // Upcoming section
  const upcomingGrid = document.getElementById(team + '-upcoming');
  const upcomingSection = document.getElementById(team + '-upcoming-section');
  const upcomingFiltered = filter === 'all' ? upcoming : (filter === 'upcoming' ? upcoming : []);
  if (filter === 'completed') {
    upcomingSection.classList.add('hidden');
  } else {
    upcomingSection.classList.remove('hidden');
    upcomingGrid.innerHTML = upcomingFiltered.length > 0
      ? upcomingFiltered.map(renderCard).join('')
      : emptyState(filter === 'upcoming' ? 'No upcoming matches' : 'No upcoming matches found');
  }

  // Completed section
  const completedGrid = document.getElementById(team + '-completed');
  const completedSection = document.getElementById(team + '-results-section');
  const completedFiltered = filter === 'all' ? completed.slice(-6).reverse() : (filter === 'completed' ? completed.slice().reverse() : []);
  if (filter === 'upcoming' || filter === 'live') {
    completedSection.classList.add('hidden');
  } else {
    completedSection.classList.remove('hidden');
    completedGrid.innerHTML = completedFiltered.length > 0
      ? completedFiltered.map(renderCard).join('')
      : emptyState('No recent results available');
  }
}

function renderCard(match) {
  const typeCls = matchTypeClass(match.match_type);
  const statusCls = 'status-' + match.status;

  const dateStr = match.match_date_ist || formatDateFromUtc(match.match_date) || 'Date TBD';
  const venueStr = [match.venue, match.city].filter(Boolean).join(' · ') || 'Venue TBD';

  return `
    <div class="match-card ${match.status}">
      <div class="card-top">
        <div class="series-name">${esc(match.series_name || 'India Series')}</div>
        <span class="type-badge ${typeCls}">${esc(match.match_type || '?')}</span>
      </div>

      <div class="teams">
        <div class="team-block">
          <div class="team-name">${esc(shortTeamName(match.team_home))}</div>
          ${match.score_home ? `<div class="team-score">${esc(match.score_home)}</div>` : ''}
        </div>
        <div class="vs-divider">VS</div>
        <div class="team-block">
          <div class="team-name">${esc(shortTeamName(match.team_away))}</div>
          ${match.score_away ? `<div class="team-score">${esc(match.score_away)}</div>` : ''}
        </div>
      </div>

      <div class="card-meta">
        <div class="meta-row">
          <span class="meta-icon">📅</span>
          <span>${esc(dateStr)}</span>
        </div>
        <div class="meta-row">
          <span class="meta-icon">📍</span>
          <span>${esc(venueStr)}</span>
        </div>
      </div>

      <div class="status-row">
        <span class="status-pill ${statusCls}">${statusLabel(match.status)}</span>
        ${match.result
          ? `<span class="result-text">${esc(truncate(match.result, 45))}</span>`
          : `<button class="summary-btn" onclick="openSummary('${esc(match.series_id)}', '${esc(match.series_name)}', '${state.activeTab}')">AI Summary</button>`
        }
      </div>
    </div>
  `;
}

function emptyState(msg) {
  return `
    <div class="empty-state">
      <div class="empty-icon">🏏</div>
      <h4>${msg}</h4>
      <p>Click "Sync Now" to fetch the latest schedule from BCCI.</p>
    </div>
  `;
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function triggerSync() {
  const btn = document.getElementById('sync-btn');
  const badge = document.getElementById('sync-status');

  btn.disabled = true;
  btn.querySelector('.btn-icon').classList.add('spinning');
  showBadge(badge, 'syncing', '⟳ Syncing...');

  try {
    await apiFetch('/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ team: 'both' }) });
    // Poll until done
    pollSyncUntilDone(btn, badge);
  } catch (err) {
    showBadge(badge, 'error', '✕ Sync failed');
    resetSyncBtn(btn);
    setTimeout(() => badge.classList.add('hidden'), 4000);
  }
}

function pollSyncUntilDone(btn, badge) {
  clearInterval(state.syncPollTimer);
  let pollCount = 0;

  state.syncPollTimer = setInterval(async () => {
    pollCount++;
    try {
      const { inProgress } = await apiFetch('/sync/status');
      if (!inProgress) {
        clearInterval(state.syncPollTimer);
        showBadge(badge, 'done', '✓ Sync complete');
        resetSyncBtn(btn);
        await loadAllMatches(); // Refresh data
        setTimeout(() => badge.classList.add('hidden'), 3000);
      }
    } catch {
      // Continue polling
    }
    if (pollCount > 60) { // 5 min timeout
      clearInterval(state.syncPollTimer);
      resetSyncBtn(btn);
    }
  }, 5000);
}

async function checkSyncStatus() {
  try {
    const { inProgress } = await apiFetch('/sync/status');
    const badge = document.getElementById('sync-status');
    if (inProgress && badge.classList.contains('hidden')) {
      badge.classList.remove('hidden');
      showBadge(badge, 'syncing', '⟳ Syncing...');
    }
  } catch {
    // Ignore polling errors
  }
}

function resetSyncBtn(btn) {
  btn.disabled = false;
  btn.querySelector('.btn-icon').classList.remove('spinning');
}

function showBadge(badge, type, text) {
  badge.className = 'sync-badge ' + type;
  badge.textContent = text;
}

// ── AI Series Summary Modal ───────────────────────────────────────────────────

async function openSummary(seriesId, seriesName, team) {
  const modal = document.getElementById('summary-modal');
  const titleEl = document.getElementById('modal-series-title');
  const contentEl = document.getElementById('modal-content');

  titleEl.textContent = seriesName || 'Series Summary';
  contentEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Generating AI summary...</p></div>';
  modal.classList.remove('hidden');

  try {
    const data = await apiFetch('/series/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ series_id: seriesId, team }),
    });

    contentEl.innerHTML = data.summary
      ? `<p>${esc(data.summary)}</p><p style="margin-top:.75rem;font-size:.75rem;color:var(--text-muted)">Generated by Claude AI · ${data.match_count} matches</p>`
      : '<p>No summary available.</p>';
  } catch (err) {
    contentEl.innerHTML = `<p style="color:var(--text-muted)">Failed to generate summary: ${esc(err.message)}</p><p style="margin-top:.5rem;font-size:.78rem">Make sure ANTHROPIC_API_KEY is configured.</p>`;
  }
}

function closeSummaryModal() {
  document.getElementById('summary-modal').classList.add('hidden');
}

// ── Sync Log Modal ────────────────────────────────────────────────────────────

async function showSyncLog() {
  const modal = document.getElementById('log-modal');
  const content = document.getElementById('log-content');
  content.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  modal.classList.remove('hidden');

  try {
    const { logs } = await apiFetch('/sync/log?limit=15');
    if (!logs || logs.length === 0) {
      content.innerHTML = '<p style="color:var(--text-muted);padding:1rem">No sync history yet. Click "Sync Now" to start.</p>';
      return;
    }

    content.innerHTML = `
      <table class="log-table">
        <thead>
          <tr>
            <th>Time (IST)</th>
            <th>Team</th>
            <th>Type</th>
            <th>Status</th>
            <th>New</th>
            <th>Updated</th>
            <th>Duration</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map(log => `
            <tr>
              <td>${formatDateFromUtc(log.synced_at)}</td>
              <td>${log.team}</td>
              <td>${log.sync_type}</td>
              <td class="status-${log.status}">${log.status}</td>
              <td>${log.records_inserted}</td>
              <td>${log.records_updated}</td>
              <td>${log.duration_ms ? log.duration_ms + 'ms' : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    content.innerHTML = `<p style="color:var(--text-muted)">Error loading logs: ${esc(err.message)}</p>`;
  }
}

function closeLogModal() {
  document.getElementById('log-modal').classList.add('hidden');
}

// Close modals on overlay click
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    closeSummaryModal();
    closeLogModal();
  }
});

// ── Utility ───────────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(str, len) {
  return str && str.length > len ? str.slice(0, len) + '…' : (str || '');
}

function shortTeamName(name) {
  if (!name) return '?';
  const overrides = { 'India': 'India', 'England': 'England', 'Australia': 'Australia',
    'South Africa': 'SA', 'New Zealand': 'NZ', 'West Indies': 'WI', 'Sri Lanka': 'SL',
    'Pakistan': 'Pakistan', 'Bangladesh': 'Bangladesh', 'Afghanistan': 'AFG', 'Zimbabwe': 'ZIM',
    'Ireland': 'Ireland', 'Netherlands': 'NED', 'Scotland': 'SCO' };
  return overrides[name] || (name.length > 12 ? name.slice(0, 12) + '…' : name);
}

function matchTypeClass(type) {
  if (!type) return 'type-other';
  const t = type.toLowerCase();
  if (t === 'test') return 'type-test';
  if (t === 'odi' || t === 'w-odi') return 'type-odi';
  if (t.includes('t20')) return 'type-t20i';
  return 'type-other';
}

function statusLabel(status) {
  const labels = { upcoming: 'Upcoming', live: '● Live', completed: 'Completed' };
  return labels[status] || status;
}

function formatDateFromUtc(utcStr) {
  if (!utcStr) return '';
  try {
    return new Date(utcStr).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return utcStr;
  }
}

function updateLastSync(syncTime) {
  const el = document.getElementById('last-updated');
  el.textContent = syncTime
    ? 'Last synced: ' + formatDateFromUtc(syncTime)
    : 'Not yet synced — click Sync Now';
}

function showError(team) {
  const grid = document.getElementById(team + '-upcoming');
  if (grid) grid.innerHTML = emptyState('Failed to load data');
}
