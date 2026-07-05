// Project Overview — the guided home screen. Shows real journey progress
// (not permanently-fake "Not yet scored" placeholders) and one clear next
// action, via server/routes/overview.js.

import { esc, ICON, fetchWithTimeout, BACKEND_ORIGIN } from './shared.js';

const LINK_LABELS = { feasibility: 'Feasibility', permits: 'Permits', cost: 'Cost', timeline: 'Timeline', risk: 'Risk', documents: 'Documents' };

function stepRow(step) {
  return `
    <div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);">
      <span style="color:${step.done ? 'var(--good)' : 'var(--ink-soft)'};flex:none;">${step.done ? ICON.check : '○'}</span>
      <span style="flex:1;font-size:13.5px;${step.done ? '' : 'color:var(--ink-soft);'}">${esc(step.label)}</span>
      ${step.done ? '<span style="font-size:11px;color:var(--good);text-transform:uppercase;letter-spacing:.03em;">Done</span>' : ''}
    </div>
  `;
}

export async function render(container, project, goTo) {
  container.innerHTML = `<div class="card"><p style="color:var(--ink-soft);font-size:13px;">Loading overview...</p></div>`;

  let overview;
  try {
    const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/overview`, {}, 8000);
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    overview = await res.json();
  } catch (err) {
    container.innerHTML = `<div class="card"><div class="err">Couldn't load the overview — is the backend running?</div></div>`;
    return;
  }

  const title = project.name || `${project.trade} project`;
  const riskText = overview.riskScore === null ? 'Not yet scored' : `${overview.riskScore}/100`;

  container.innerHTML = `
    <div class="card">
      <h3>Project</h3>
      <p style="font-size:17px;font-weight:700;margin:0 0 4px;">${esc(title)}</p>
      <p style="color:var(--ink-soft);font-size:13.5px;margin:0 0 14px;">${esc(project.location)}</p>
      <p style="font-size:13.5px;margin:0;">${esc(project.description)}</p>
    </div>
    <div class="card">
      <h3>Status</h3>
      <div class="counts">
        <div class="countbox"><b>${esc(overview.status)}</b><span>Status</span></div>
        <div class="countbox"><b>${overview.confidenceScore}/100</b><span>Confidence</span></div>
        <div class="countbox"><b>${riskText}</b><span>Risk</span></div>
      </div>
      <p style="color:var(--ink-soft);font-size:11.5px;margin:10px 0 0;">
        Confidence is ${overview.doneCount} of ${overview.totalSteps} intelligence steps run so far.
        ${overview.riskScoreBasis ? `Risk score is based on ${esc(overview.riskScoreBasis)}.` : 'Risk isn’t scored until Feasibility or Risk has been run.'}
      </p>
    </div>
    <div class="card">
      <h3>${ICON.loop} Your journey</h3>
      ${overview.steps.map(stepRow).join('')}
      ${overview.nextStep
        ? `<button class="btn" id="continueBtn" style="margin-top:14px;">Continue: ${esc(LINK_LABELS[overview.nextStep.link] || overview.nextStep.label)}</button>`
        : `<p style="color:var(--good);font-size:13px;margin:14px 0 0;">${ICON.check} Every step has been run. Check Tasks for anything still open, or ask the AI Advisor a question.</p>`}
    </div>
    <div class="card">
      <h3>At a glance</h3>
      <div class="counts">
        <div class="countbox"><b>${(project.agencies || []).length}</b><span>Agencies</span></div>
        <div class="countbox"><b>${(project.flags || []).length}</b><span>Jurisdiction flags</span></div>
        <div class="countbox"><b>${(project.risks || []).length}</b><span>Rejection risks</span></div>
      </div>
      <p style="color:var(--ink-soft);font-size:13px;margin-top:10px;">Estimated timeline: <b>${esc(project.timeline)}</b></p>
    </div>
  `;

  const continueBtn = container.querySelector('#continueBtn');
  if (continueBtn) continueBtn.onclick = () => { if (goTo) goTo(overview.nextStep.link); };
}
