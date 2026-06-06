/**
 * Static frontend for GitHub Pages.
 * Reads pre-generated JSON data files from docs/data/ instead of a live API.
 * Data is refreshed daily via GitHub Actions.
 */

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  men: [],
  women: [],
  activeTab: 'men',
  activeFilter: { men: 'all', women: 'all' },
};

// ── Data Fetch ────────────────────────────────────────────────────────────────

async function loadJson(filename) {
  // Cache-bust with today's date so browsers re-fetch after daily sync
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch(`data/${filename}?v=${today}`);
  if (!res.ok) throw new Error(`Failed to load ${filename}: ${res.status}`);
  return res.json();
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  loadAllMatches();
});

async function loadAllMatches() {
  try {
    const [menData, womenData, meta] = await Promise.all([
      loadJson('matches-men.json'),
      loadJson('matches-women.json'),
      loadJson('meta.json'),
    ]);

    state.men = menData.matches || [];
    state.women = womenData.matches || [];

    renderTeam('men');
    renderTeam('women');
    updateLastSync(meta.lastSync || meta.exportedAt);
  } catch (err) {
    console.error('Failed to load match data:', err);
    showError('men');
    showError('women');
    document.getElementById('last-updated').textContent = 'Data unavailable — sync pending';
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
      : emptyState(filter === 'upcoming' ? 'No upcoming matches scheduled' : 'No upcoming matches found');
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
        <div class="meta-row"><span class="meta-icon">📅</span><span>${esc(dateStr)}</span></div>
        <div class="meta-row"><span class="meta-icon">📍</span><span>${esc(venueStr)}</span></div>
      </div>
      <div class="status-row">
        <span class="status-pill ${statusCls}">${statusLabel(match.status)}</span>
        ${match.result ? `<span class="result-text">${esc(truncate(match.result, 45))}</span>` : ''}
      </div>
    </div>
  `;
}

function emptyState(msg) {
  return `
    <div class="empty-state">
      <div class="empty-icon">🏏</div>
      <h4>${msg}</h4>
      <p>Data updates daily at 7:00 AM IST via GitHub Actions.</p>
    </div>
  `;
}

// ── Sync Log Modal ────────────────────────────────────────────────────────────

async function showSyncLog() {
  const modal = document.getElementById('log-modal');
  const content = document.getElementById('log-content');
  content.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  modal.classList.remove('hidden');

  try {
    const { logs } = await loadJson('sync-log.json');
    if (!logs || logs.length === 0) {
      content.innerHTML = '<p style="color:var(--text-muted);padding:1rem">No sync history yet.</p>';
      return;
    }
    content.innerHTML = `
      <table class="log-table">
        <thead>
          <tr><th>Time (IST)</th><th>Team</th><th>Type</th><th>Status</th><th>New</th><th>Updated</th></tr>
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
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    content.innerHTML = `<p style="color:var(--text-muted)">Could not load sync log.</p>`;
  }
}

function closeLogModal() {
  document.getElementById('log-modal').classList.add('hidden');
}

// Summary modal not used in static mode — remove the button from cards
function closeSummaryModal() {
  document.getElementById('summary-modal').classList.add('hidden');
}

document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    closeSummaryModal();
    closeLogModal();
  }
});

// ── Utilities ─────────────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function truncate(str, len) {
  return str && str.length > len ? str.slice(0, len) + '…' : (str || '');
}

function shortTeamName(name) {
  if (!name) return '?';
  const overrides = {
    'India': 'India', 'England': 'England', 'Australia': 'Australia',
    'South Africa': 'SA', 'New Zealand': 'NZ', 'West Indies': 'WI',
    'Sri Lanka': 'SL', 'Pakistan': 'Pakistan', 'Bangladesh': 'Bangladesh',
    'Afghanistan': 'AFG', 'Zimbabwe': 'ZIM', 'Ireland': 'Ireland',
  };
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
  return { upcoming: 'Upcoming', live: '● Live', completed: 'Completed' }[status] || status;
}

function formatDateFromUtc(utcStr) {
  if (!utcStr) return '';
  try {
    return new Date(utcStr).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return utcStr; }
}

function updateLastSync(syncTime) {
  const el = document.getElementById('last-updated');
  el.textContent = syncTime
    ? 'Last synced: ' + formatDateFromUtc(syncTime)
    : 'Not yet synced';
}

function showError(team) {
  const grid = document.getElementById(team + '-upcoming');
  if (grid) grid.innerHTML = emptyState('Could not load schedule data');
}
