// Feasibility Intelligence — concerns the user should see before permits are
// even discussed: flood zones, wetlands, HOA, historic district, lot
// restrictions, utilities, environmental and zoning concerns. Findings are
// generated on demand and persisted, so a later visit just lists them.

import { esc, ICON, fetchWithTimeout, BACKEND_ORIGIN } from './shared.js';

function findingsUrl(project) {
  return `${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/feasibility`;
}

function renderFindings(container, project, findings) {
  const items = findings.map(f => `
    <div class="${f.impact === 'high' ? 'risk' : 'flag'}">
      <b>${esc(f.label)}</b>${f.impact ? ` <span style="text-transform:uppercase;font-size:11px;">(${esc(f.impact)} impact)</span>` : ''}
      <p style="margin:4px 0 0;">${esc(f.detail)}</p>
      ${f.confidence ? `<p style="color:var(--ink-soft);font-size:11.5px;margin:4px 0 0;">Confidence: ${esc(f.confidence)}</p>` : ''}
    </div>`).join('');

  container.innerHTML = `
    <div class="card">
      <h3>${ICON.alert} Before you get to permits</h3>
      ${items || '<p style="color:var(--ink-soft);font-size:13px;">No feasibility concerns identified for this project.</p>'}
      <button class="copybtn" id="rerun">Run again</button>
    </div>
    <p class="disc">This is an informational feasibility check, not a legal or environmental determination — confirm specifics with local agencies before proceeding.</p>
  `;
  container.querySelector('#rerun').onclick = () => runCheck(container, project);
}

async function runCheck(container, project) {
  const card = container.querySelector('.card') || container;
  card.innerHTML = `<h3>${ICON.alert} Feasibility Intelligence</h3><p style="color:var(--ink-soft);font-size:13px;"><span class="spinner"></span>Checking for flood zones, wetlands, HOA rules, historic districts, lot restrictions, utilities, and other concerns... this can take a minute or two.</p>`;
  try {
    const res = await fetchWithTimeout(findingsUrl(project), { method: 'POST' }, 160000);
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    const { findings } = await res.json();
    renderFindings(container, project, findings);
  } catch (err) {
    container.innerHTML = `
      <div class="card"><h3>${ICON.alert} Feasibility Intelligence</h3><div class="err">Couldn't run the feasibility check — is the backend running? Try again in a moment.</div></div>
    `;
  }
}

export async function render(container, project) {
  container.innerHTML = `<div class="card"><p style="color:var(--ink-soft);font-size:13px;">Loading feasibility findings...</p></div>`;

  let findings;
  try {
    const res = await fetchWithTimeout(findingsUrl(project), {}, 8000);
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    ({ findings } = await res.json());
  } catch (err) {
    container.innerHTML = `<div class="card"><h3>${ICON.alert} Feasibility Intelligence</h3><div class="err">Couldn't load feasibility findings — is the backend running?</div></div>`;
    return;
  }

  if (findings.length === 0) {
    container.innerHTML = `
      <div class="card">
        <h3>${ICON.alert} Feasibility Intelligence</h3>
        <p style="color:var(--ink-soft);font-size:13px;">Check for flood zones, wetlands, HOA rules, historic districts, lot restrictions, utilities, and other concerns before you get to permits.</p>
        <button class="btn" id="run" style="margin-top:4px;">Run feasibility check</button>
      </div>
    `;
    container.querySelector('#run').onclick = () => runCheck(container, project);
    return;
  }

  renderFindings(container, project, findings);
}
