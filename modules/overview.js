// Project Overview — status, counts, and timeline pulled from fields that
// already exist on the project today. Confidence/risk scores show an honest
// "not yet scored" state until something actually computes them; no fake
// numbers.

import { esc } from './shared.js';

export async function render(container, project) {
  const title = project.name || `${project.trade} project`;
  const status = project.status || 'In progress';
  const confidence = Number.isFinite(project.confidenceScore) ? `${project.confidenceScore}/100` : 'Not yet scored';
  const risk = Number.isFinite(project.riskScore) ? `${project.riskScore}/100` : 'Not yet scored';

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
        <div class="countbox"><b>${esc(status)}</b><span>Status</span></div>
        <div class="countbox"><b>${confidence}</b><span>Confidence</span></div>
        <div class="countbox"><b>${risk}</b><span>Risk</span></div>
      </div>
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
}
