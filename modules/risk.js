// Risk Intelligence — every risk carries likelihood, impact, priority,
// mitigation, and confidence, distinct from Feasibility's go/no-go concerns.
// Findings are generated on demand and persisted, so a later visit just
// lists them.

import { esc, ICON, fetchWithTimeout, BACKEND_ORIGIN } from './shared.js';

function riskUrl(project) {
  return `${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/risk`;
}

function renderFindings(container, project, findings) {
  const items = findings.map(f => `
    <div class="${f.priority === 'high' ? 'risk' : 'flag'}">
      <b>${esc(f.label)}</b>${f.priority ? ` <span style="text-transform:uppercase;font-size:11px;">(${esc(f.priority)} priority)</span>` : ''}
      <p style="margin:4px 0 0;">${esc(f.detail)}</p>
      <p style="color:var(--ink-soft);font-size:11.5px;margin:4px 0 0;">
        ${f.likelihood ? `Likelihood: ${esc(f.likelihood)} &middot; ` : ''}${f.impact ? `Impact: ${esc(f.impact)}` : ''}${f.confidence ? ` &middot; Confidence: ${esc(f.confidence)}` : ''}
      </p>
      ${f.mitigation ? `<p style="margin:6px 0 0;"><b>Mitigation:</b> ${esc(f.mitigation)}</p>` : ''}
    </div>`).join('');

  container.innerHTML = `
    <div class="card">
      <h3>${ICON.alert} Risks to plan around</h3>
      ${items || '<p style="color:var(--ink-soft);font-size:13px;">No notable risks identified for this project.</p>'}
      <button class="copybtn" id="rerun">Run again</button>
    </div>
    <p class="disc">This is an informational risk assessment, not a legal, financial, or engineering determination — confirm specifics with the relevant professionals before proceeding.</p>
  `;
  container.querySelector('#rerun').onclick = () => runCheck(container, project);
}

async function runCheck(container, project) {
  const card = container.querySelector('.card') || container;
  card.innerHTML = `<h3>${ICON.alert} Risk Intelligence</h3><p style="color:var(--ink-soft);font-size:13px;">Assessing permitting, cost, schedule, and compliance risk for this project...</p>`;
  try {
    const res = await fetchWithTimeout(riskUrl(project), { method: 'POST' }, 60000);
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    const { findings } = await res.json();
    renderFindings(container, project, findings);
  } catch (err) {
    container.innerHTML = `
      <div class="card"><h3>${ICON.alert} Risk Intelligence</h3><div class="err">Couldn't run the risk assessment — is the backend running? Try again in a moment.</div></div>
    `;
  }
}

export async function render(container, project) {
  container.innerHTML = `<div class="card"><p style="color:var(--ink-soft);font-size:13px;">Loading risk findings...</p></div>`;

  let findings;
  try {
    const res = await fetchWithTimeout(riskUrl(project), {}, 8000);
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    ({ findings } = await res.json());
  } catch (err) {
    container.innerHTML = `<div class="card"><h3>${ICON.alert} Risk Intelligence</h3><div class="err">Couldn't load risk findings — is the backend running?</div></div>`;
    return;
  }

  if (findings.length === 0) {
    container.innerHTML = `
      <div class="card">
        <h3>${ICON.alert} Risk Intelligence</h3>
        <p style="color:var(--ink-soft);font-size:13px;">Assess permitting, cost, schedule, and compliance risk before they turn into delays or overruns.</p>
        <button class="btn" id="run" style="margin-top:4px;">Run risk assessment</button>
      </div>
    `;
    container.querySelector('#run').onclick = () => runCheck(container, project);
    return;
  }

  renderFindings(container, project, findings);
}
