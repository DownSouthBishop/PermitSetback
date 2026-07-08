// Timeline Intelligence — phase-by-phase schedule breakdown (feasibility ->
// design -> engineering -> permitting -> revision cycles -> construction ->
// inspections -> completion), with the phase(s) most likely to blow the
// schedule flagged as bottlenecks. Supersedes the flat timeline/timelineNote
// strings on the project — those stay put for the Permits module, this is
// the richer replacement other modules can adopt later.

import { esc, ICON, fetchWithTimeout, BACKEND_ORIGIN, tradeLabel, cityOf, renderUpgradeCard } from './shared.js';

function phaseCard(phase) {
  const cls = phase.isBottleneck ? 'risk' : 'agency';
  return `
    <div class="${cls}">
      <b>${esc(phase.name)}</b>${phase.isBottleneck ? ` <span style="color:var(--risk);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;">${ICON.alert} Bottleneck risk</span>` : ''}
      ${phase.estimatedDuration ? `<p style="margin:4px 0 0;font-family:var(--font-mono);font-size:13px;">${esc(phase.estimatedDuration)}</p>` : ''}
      ${phase.note ? `<p style="color:var(--ink-soft);font-size:13px;margin:4px 0 0;">${esc(phase.note)}</p>` : ''}
    </div>
  `;
}

function renderEmpty(container, project) {
  container.innerHTML = `
    <div class="card">
      <h3>${ICON.clock} How long ${esc(cityOf(project.location)) || 'this'} actually takes</h3>
      <p style="color:var(--ink-soft);font-size:13.5px;margin:0 0 14px;">Break this ${esc(tradeLabel(project.trade).toLowerCase())} project down into its real phases — feasibility, design, permitting, construction, and beyond — with the phase most likely to slip flagged up front.</p>
      <button class="btn" id="genBtn">Generate timeline</button>
      <div id="genStatus" aria-live="polite"></div>
    </div>
  `;
  container.querySelector('#genBtn').onclick = async () => {
    const btn = container.querySelector('#genBtn');
    const status = container.querySelector('#genStatus');
    btn.disabled = true;
    status.innerHTML = `<p style="color:var(--ink-soft);font-size:13px;margin-top:10px;"><span class="spinner"></span>Generating... this can take a minute or two.</p>`;
    try {
      const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, 160000);
      if (!res.ok) throw new Error(`Backend returned ${res.status}`);
      const data = await res.json();
      renderPhases(container, project, data.phases);
    } catch (err) {
      btn.disabled = false;
      status.innerHTML = `<div class="err">Couldn't generate a timeline — is the backend running? Try again in a moment.</div>`;
    }
  };
}

function renderPhases(container, project, phases) {
  const bottlenecks = phases.filter(p => p.isBottleneck);
  container.innerHTML = `
    <div class="card">
      <h3>${ICON.clock} Phase-by-phase schedule</h3>
      ${phases.map(phaseCard).join('')}
    </div>
    ${bottlenecks.length ? `
    <div class="card">
      <h3>${ICON.alert} Most likely to blow the schedule</h3>
      ${bottlenecks.map(p => `<div class="flag"><b>${esc(p.name)}</b>${p.note ? ` — ${esc(p.note)}` : ''}</div>`).join('')}
    </div>` : ''}
    <p class="disc">These are realistic ranges, not guarantees — actual timing depends on the reviewing agency's current workload and how quickly you respond to any comments.</p>
  `;
}

export async function render(container, project) {
  container.innerHTML = `<p style="color:var(--ink-soft);font-size:13.5px;">Loading timeline...</p>`;
  try {
    const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/timeline`, {}, 8000);
    if (res.status === 402) { renderUpgradeCard(container, project, 'Timeline Intelligence', ICON.clock); return; }
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    const { phases } = await res.json();
    if (phases.length > 0) {
      renderPhases(container, project, phases);
    } else {
      renderEmpty(container, project);
    }
  } catch (err) {
    container.innerHTML = `<div class="card"><div class="err">Couldn't load the timeline — is the backend running? Try again in a moment.</div></div>`;
  }
}
