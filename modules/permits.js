// Permit Intelligence — the reference module implementation. This is the
// existing funnel's renderFull() report (agencies/flags/risks/timeline/
// narrative + outcome reporting), migrated to the Project Workspace's
// render(container, project) contract. Copy this file's shape for new
// modules: fetch anything you need beyond the base project fields yourself,
// render into the container you're handed, don't touch anyone else's DOM.

import { esc, ICON, fetchWithTimeout, BACKEND_ORIGIN } from './shared.js';

export async function render(container, project) {
  const agencies = (project.agencies || []).map(a => `<div class="agency"><b>${esc(a.name)}</b><p>${esc(a.detail)}</p></div>`).join('');
  const flags = (project.flags || []).map(f => `<div class="flag">${esc(f)}</div>`).join('');
  const risks = (project.risks || []).map(x => `<div class="risk">${esc(x)}</div>`).join('');

  container.innerHTML = `
    <div class="card">
      <div class="section"><h3>${ICON.building} Every agency you'll answer to</h3>${agencies}</div>
      <div class="section"><h3>${ICON.flag} The rules that trip up projects like yours</h3>${flags}</div>
      <div class="section"><h3>${ICON.alert} Why projects like yours get rejected</h3>${risks}</div>
    </div>
    <div class="card"><h3>${ICON.clock} How long this will actually take</h3>
      <div class="timeline"><b>${esc(project.timeline)}</b></div>
      <p style="color:var(--ink-soft);font-size:13px;margin-top:6px;">${esc(project.timelineNote)}</p>
    </div>
    <div class="card"><h3>${ICON.doc} Your permit application, already written</h3>
      <div class="narrative" id="narr">${esc(project.narrative)}</div>
      <button class="copybtn" id="copy">Copy narrative</button>
    </div>
    <div class="card"><h3>${ICON.loop} Tell us what happened</h3>
      <p style="color:var(--ink-soft);font-size:13px;margin:0 0 12px;">This only matters once the agency has actually decided.</p>
      <div id="outcomeGate">
        ${project.outcomeStatus ? `<p style="color:var(--ink-soft);font-size:13px;margin:0;">Reported: <b>${esc(project.outcomeStatus)}</b></p>` : `
        <div class="rbtns">
          <button class="rbtn" id="notyet">Not decided yet</button>
          <button class="rbtn" id="decided">${ICON.check} It's been decided</button>
        </div>`}
      </div>
      <div id="outcomeChoices" class="hidden">
        <div class="rbtns">
          <button class="rbtn" data-o="approved">${ICON.check} Approved as drafted</button>
          <button class="rbtn" data-o="comments">${ICON.edit} Approved after comments</button>
          <button class="rbtn" data-o="rejected">${ICON.x} Rejected — needed changes</button>
        </div>
      </div>
      <div id="thanks" aria-live="polite"></div>
    </div>
    <p class="disc">This is an informational roadmap, not a permit guarantee or legal determination — confirm current requirements with the issuing agencies before submitting.</p>
  `;

  const copyBtn = container.querySelector('#copy');
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const text = container.querySelector('#narr').innerText;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = 'Copied';
        } catch (err) {
          copyBtn.textContent = 'Select the text above to copy';
        }
      } else {
        const range = document.createRange();
        range.selectNodeContents(container.querySelector('#narr'));
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        copyBtn.textContent = 'Text selected — press Ctrl+C';
      }
      setTimeout(() => { copyBtn.textContent = 'Copy narrative'; }, 2000);
    };
  }

  const notyet = container.querySelector('#notyet');
  if (notyet) notyet.onclick = () => {
    container.querySelector('#outcomeGate').innerHTML = `<p style="color:var(--ink-soft);font-size:13px;margin:0;">No problem — come back and tell us once you hear back.</p>`;
  };
  const decided = container.querySelector('#decided');
  if (decided) decided.onclick = () => {
    container.querySelector('#outcomeGate').classList.add('hidden');
    container.querySelector('#outcomeChoices').classList.remove('hidden');
  };
  container.querySelectorAll('#outcomeChoices .rbtn').forEach(b => b.onclick = async () => {
    const outcome = b.getAttribute('data-o');
    const thanks = container.querySelector('#thanks');
    container.querySelectorAll('#outcomeChoices .rbtn').forEach(x => x.disabled = true);
    thanks.innerHTML = `<p style="color:var(--ink-soft);font-size:13px;margin:0;">Saving...</p>`;
    try {
      const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/outcome`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome })
      }, 8000);
      if (!res.ok) throw new Error(`Backend returned ${res.status}`);
      thanks.innerHTML = `<div class="creditbox">Thank you. Here's <b>SETBACK15</b> — $15 off your next roadmap, redeemable at checkout.</div>`;
    } catch (err) {
      container.querySelectorAll('#outcomeChoices .rbtn').forEach(x => x.disabled = false);
      thanks.innerHTML = `<div class="err">Couldn't save that — is the backend running? Try again in a moment.</div>`;
    }
  });
}
