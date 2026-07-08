// Shared helpers for Project Workspace modules (modules/*.js). Every module
// renders into a container it's handed and talks to its own backend routes
// directly — this file only holds the bits that are genuinely common
// (fetch plumbing, escaping, icons), so tracks aren't copy-pasting them.

// Same origin as whatever served this page — the Node backend serves this
// frontend itself (see server/static.js), so there is nothing to configure
// after deploy.
export const BACKEND_ORIGIN = window.location.origin;

export async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export function esc(s) {
  return String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export function logEvent(name, properties) {
  fetch(`${BACKEND_ORIGIN}/api/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, properties })
  }).catch(() => {});
}

// Same trade labels projects.html uses for its dashboard cards — kept in
// sync by hand since that file is a plain script, not a module, and can't
// import this. If they ever drift, that's the tell to actually share them.
const TRADE_LABELS = {
  pool: 'Pool', deck: 'Deck', roof: 'Roof', solar: 'Solar', fence: 'Fence',
  addition: 'Addition', 'garage/adu': 'Garage/ADU', other: 'Project'
};

// A project's name is null until someone explicitly names it — every
// project today falls into that bucket. "${trade} project" (e.g. "garage/adu
// project") reads like a database enum, not something a contractor would
// call their own job. Built from the same data, but from what they actually
// told us (trade + city) rather than a raw category slug.
export function deriveProjectName(project) {
  if (project.name) return project.name;
  const label = TRADE_LABELS[project.trade] || 'Project';
  const city = (project.location || '').split(',')[0].trim();
  return city ? `${label} — ${city}` : label;
}

export function tradeLabel(trade) {
  return TRADE_LABELS[trade] || 'project';
}

export function cityOf(location) {
  return (location || '').split(',')[0].trim();
}

// Every Full-Workspace-gated module (Feasibility, Cost, Risk, Documents,
// Advisor, Timeline, Overview, Tasks) 402s the same way for a Roadmap-tier
// project — this renders that as an upgrade offer instead of each module
// independently reporting it as an outage ("is the backend running?"),
// which is what a paying customer clicking a paid-only tab used to see.
export function renderUpgradeCard(container, project, moduleLabel, icon) {
  container.innerHTML = `
    <div class="card">
      <h3>${icon || ''} ${esc(moduleLabel)}</h3>
      <p style="color:var(--ink-soft);font-size:13px;">${esc(moduleLabel)} is part of the Full Workspace — this project was unlocked at the Roadmap tier ($49). Upgrade for the $48 difference to unlock it, along with Cost, Risk, Tasks, Documents, and the AI Advisor.</p>
      <button class="btn" id="upgradeBtn" style="margin-top:4px;">Upgrade to Full Workspace — $48</button>
      <div id="upgradeErr"></div>
    </div>
  `;
  container.querySelector('#upgradeBtn').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>Redirecting to Stripe...`;
    try {
      const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/create-checkout-session`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'full' })
      }, 15000);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Backend returned ${res.status}`);
      if (data.url) { window.location.href = data.url; return; }
      // No url means the upgrade was free (active subscription or unredeemed
      // referral code already priced Full Workspace at what was already
      // paid) and the project is unlocked already — nothing left to redirect to.
      window.location.reload();
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = 'Upgrade to Full Workspace — $48';
      container.querySelector('#upgradeErr').innerHTML = `<div class="err">${esc(err.message || "Couldn't start checkout — try again in a moment.")}</div>`;
    }
  };
}

export const ICON = {
  building: `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h.01M15 17h.01"/></svg>`,
  flag: `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21V4m0 0h13l-2 4 2 4H4"/></svg>`,
  alert: `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/></svg>`,
  clock: `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`,
  doc: `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/></svg>`,
  loop: `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h5M20 20v-5h-5M4 9a9 9 0 0 1 15-4l1 1M20 15a9 9 0 0 1-15 4l-1-1"/></svg>`,
  check: `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  edit: `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  x: `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`
};
