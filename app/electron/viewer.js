let allActivities = [];
let currentFilter = null;

function initializeViewer() {
  bindControls();
  setBriefingDate();
  loadBriefing();
  loadActivities();
}

function bindControls() {
  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab, button));
  });

  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      const filterValue = button.dataset.filter;
      filterByKind(filterValue === 'all' ? null : filterValue, button);
    });
  });

  const deleteButton = document.querySelector('[data-action="delete-all"]');
  if (deleteButton) {
    deleteButton.addEventListener('click', deleteAllData);
  }
}

async function loadBriefing() {
  try {
    const briefing = await window.electronAPI.getBriefing();
    document.querySelector('#briefing').innerHTML = briefing
      ? `<div class="briefing-text">${escapeHtml(briefing)}</div>`
      : '<div class="empty-state"><p>No briefing available yet.</p></div>';
  } catch (error) {
    console.error('Failed to load briefing:', error);
    document.querySelector('#briefing').innerHTML =
      '<div class="empty-state"><p>Error loading briefing.</p></div>';
  }
}

async function loadActivities() {
  try {
    const activities = await window.electronAPI.getActivities();
    allActivities = activities;
    renderActivities();
  } catch (error) {
    console.error('Failed to load activities:', error);
    document.querySelector('#activities-list').innerHTML =
      '<div class="empty-state"><p>Error loading activities.</p></div>';
  }
}

async function deleteAllData() {
  const confirmed = confirm(
    'This will permanently delete all local Ember data, including the database, briefings, screenshots, and debug logs. Continue?',
  );
  if (!confirmed) {
    return;
  }

  try {
    await window.electronAPI.deleteAllData();
    allActivities = [];
    currentFilter = null;
    loadBriefing();
    renderActivities();
    alert('All local Ember data was deleted.');
  } catch (error) {
    alert(`Delete failed: ${error.message}`);
  }
}

function renderActivities() {
  const filtered = currentFilter
    ? allActivities.filter((activity) => activity.kind === currentFilter)
    : allActivities;

  renderSummary(filtered);

  if (filtered.length === 0) {
    document.querySelector('#activities-list').innerHTML =
      '<div class="empty-state"><p>No activities found.</p></div>';
    return;
  }

  document.querySelector('#activities-list').innerHTML = filtered
    .map((activity) => createActivityCard(activity))
    .join('');
}

function renderSummary(rows) {
  const counts = rows.reduce((accumulator, row) => {
    accumulator[row.kind] = (accumulator[row.kind] || 0) + 1;
    return accumulator;
  }, {});

  const latestApp = rows.find((row) => row.kind === 'app' || row.kind === 'session');
  const cards = [
    { label: 'Total', value: rows.length },
    { label: 'Apps', value: counts.app || 0 },
    { label: 'Sessions', value: counts.session || 0 },
    { label: 'Snapshots', value: counts['app-list'] || 0 },
    { label: 'Clipboard', value: counts.clipboard || 0 },
  ];

  document.querySelector('#activity-summary').innerHTML = `
    ${cards
      .map(
        (card) => `
          <div class="summary-card">
            <div class="summary-label">${card.label}</div>
            <div class="summary-value">${card.value}</div>
          </div>
        `,
      )
      .join('')}
    ${latestApp ? `
      <div class="summary-card full">
        <div class="summary-label">Latest app or session</div>
        <div class="summary-value large">${escapeHtml(latestApp.app_name || latestApp.title || latestApp.kind)}</div>
      </div>
    ` : ''}
  `;
}

function createActivityCard(activity) {
  const date = new Date(activity.occurred_at);
  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const durationStr =
    activity.kind === 'session' && activity.metadata?.duration_seconds
      ? ` • ${formatDuration(activity.metadata.duration_seconds)}`
      : '';
  const kindLabel = {
    app: 'App focus',
    session: 'Session',
    'app-list': 'Open apps',
    window: 'Window',
    clipboard: 'Clipboard',
  }[activity.kind] || activity.kind;

  return `
    <div class="activity-card">
      <div class="activity-header">
        <span class="activity-kind kind-${activity.kind}">${kindLabel}</span>
        <span class="activity-time">${timeStr}${durationStr}</span>
      </div>
      ${activity.title ? `<div class="activity-title">${escapeHtml(activity.title)}</div>` : ''}
      ${activity.app_name ? `<div class="activity-meta">📱 ${escapeHtml(activity.app_name)}</div>` : ''}
      ${activity.metadata?.window_title ? `<div class="activity-meta">🪟 ${escapeHtml(activity.metadata.window_title)}</div>` : ''}
      ${
        activity.kind === 'app-list' && activity.metadata?.apps?.length
          ? `<div class="activity-meta">📋 ${activity.metadata.apps.length} app(s) open</div>`
          : ''
      }
    </div>
  `;
}

function formatDuration(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function escapeHtml(text) {
  const element = document.createElement('div');
  element.textContent = text;
  return element.innerHTML;
}

function switchTab(tab, button) {
  document.querySelectorAll('.tab-content').forEach((tabContent) => tabContent.classList.remove('active'));
  document.querySelectorAll('.tab-button').forEach((tabButton) => tabButton.classList.remove('active'));
  document.getElementById(tab).classList.add('active');
  if (button) {
    button.classList.add('active');
  }

  if (tab === 'activities') {
    loadActivities();
  }
}

function filterByKind(kind, button) {
  currentFilter = kind;
  document.querySelectorAll('.filter-button').forEach((filterButton) => filterButton.classList.remove('active'));
  if (button) {
    button.classList.add('active');
  }
  renderActivities();
}

function setBriefingDate() {
  const today = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  document.getElementById('briefing-date').textContent = today;
}

initializeViewer();
