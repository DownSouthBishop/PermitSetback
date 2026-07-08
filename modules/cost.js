// Cost Intelligence — permit/engineering/construction cost breakdown for the
// project. Ranges only, never a fake single number (low_estimate/high_estimate
// columns exist precisely so we don't have to pretend to more precision than
// a construction estimate can actually offer).

import { esc, ICON, fetchWithTimeout, BACKEND_ORIGIN, tradeLabel, cityOf } from './shared.js';

function money(n) {
  return Number.isFinite(n) ? `$${Math.round(n).toLocaleString()}` : '—';
}

function renderCosts(container, project, costs) {
  const lowTotal = costs.reduce((sum, c) => sum + (Number.isFinite(c.lowEstimate) ? c.lowEstimate : 0), 0);
  const highTotal = costs.reduce((sum, c) => sum + (Number.isFinite(c.highEstimate) ? c.highEstimate : 0), 0);

  const rows = costs.map(c => `
    <div class="agency">
      <b>${esc(c.category)}</b>
      <p style="color:var(--ink);font-family:var(--font-mono);font-size:14px;margin:6px 0 0;">${money(c.lowEstimate)} &ndash; ${money(c.highEstimate)}</p>
      ${c.note ? `<p>${esc(c.note)}</p>` : ''}
    </div>
  `).join('');

  container.innerHTML = `
    <div class="card">
      <h3>${ICON.doc} Estimated total</h3>
      <div class="counts">
        <div class="countbox"><b>${money(lowTotal)}</b><span>Low end</span></div>
        <div class="countbox"><b>${money(highTotal)}</b><span>High end</span></div>
      </div>
    </div>
    <div class="card">
      <h3>${ICON.building} Cost breakdown</h3>
      ${rows}
    </div>
    <p class="disc">These are planning-stage ranges, not quotes — get firm numbers from your contractor and the issuing agencies before budgeting.</p>
  `;
}

export async function render(container, project) {
  container.innerHTML = `<div class="card"><p class="notbuilt">Loading cost estimate...</p></div>`;

  let costs = [];
  try {
    const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/cost`, {}, 8000);
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    ({ costs } = await res.json());
  } catch (err) {
    container.innerHTML = `<div class="card"><p class="err">Couldn't load the cost estimate — is the backend running?</p></div>`;
    return;
  }

  if (costs.length > 0) { renderCosts(container, project, costs); return; }

  container.innerHTML = `
    <div class="card">
      <h3>${ICON.doc} What this ${esc(tradeLabel(project.trade).toLowerCase())} will actually cost</h3>
      <p style="color:var(--ink-soft);font-size:13.5px;margin:0 0 14px;">A real breakdown for ${esc(cityOf(project.location)) || 'this project'} — permit fees, engineering, construction, and contingency, all as ranges, not a single made-up number.</p>
      <button class="btn" id="generate">Generate cost estimate</button>
      <div id="genStatus" aria-live="polite"></div>
    </div>
  `;

  const btn = container.querySelector('#generate');
  btn.onclick = async () => {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>Generating...`;
    const status = container.querySelector('#genStatus');
    status.innerHTML = `<p style="color:var(--ink-soft);font-size:12.5px;margin-top:8px;">This can take a minute or two.</p>`;
    try {
      const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/cost`, { method: 'POST' }, 160000);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Backend returned ${res.status}`);
      renderCosts(container, project, body.costs);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Generate cost estimate';
      status.innerHTML = `<div class="err">${esc(err.message || 'Could not generate a cost estimate right now — try again in a moment.')}</div>`;
    }
  };
}
