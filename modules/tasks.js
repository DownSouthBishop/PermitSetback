// Task Center — next actions derived from data already on the project (see
// server/routes/tasks.js). Concern tasks (from flags/feasibility/risk) can
// be checked off; step tasks ("run this module") link straight to the tab
// that clears them, via the goTo callback project.html passes in.

import { esc, ICON, fetchWithTimeout, BACKEND_ORIGIN } from './shared.js';

const LINK_LABELS = { feasibility: 'Feasibility', cost: 'Cost', timeline: 'Timeline', risk: 'Risk', documents: 'Documents' };

function taskItem(task) {
  const isStep = task.id.startsWith('missing:');
  const done = task.status === 'done';
  const checkbox = isStep ? '' : `<input type="checkbox" ${done ? 'checked' : ''} data-id="${esc(task.id)}" style="margin-top:3px;">`;
  const goBtn = isStep ? `<button class="copybtn" data-go="${esc(task.link)}" style="margin-top:8px;">Go to ${esc(LINK_LABELS[task.link] || task.link)}</button>` : '';
  return `
    <div class="${isStep ? 'flag' : 'agency'}" style="display:flex;gap:10px;align-items:flex-start;${done ? 'opacity:.55;' : ''}">
      ${checkbox}
      <div style="flex:1;">
        <b style="${done ? 'text-decoration:line-through;' : ''}">${esc(task.title)}</b>
        ${task.detail ? `<p style="margin:4px 0 0;">${esc(task.detail)}</p>` : ''}
        ${goBtn}
      </div>
    </div>
  `;
}

export async function render(container, project, goTo) {
  container.innerHTML = `<div class="card"><p style="color:var(--ink-soft);font-size:13px;">Loading next actions...</p></div>`;

  let tasks;
  try {
    const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/tasks`, {}, 8000);
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    ({ tasks } = await res.json());
  } catch (err) {
    container.innerHTML = `<div class="card"><h3>${ICON.loop} Task Center</h3><div class="err">Couldn't load tasks — is the backend running?</div></div>`;
    return;
  }

  const open = tasks.filter(t => t.status !== 'done');
  const done = tasks.filter(t => t.status === 'done');

  container.innerHTML = `
    <div class="card">
      <h3>${ICON.loop} What's next</h3>
      ${open.length ? open.map(taskItem).join('') : '<p style="color:var(--ink-soft);font-size:13px;">Nothing open — every step has been run and every flagged concern is checked off.</p>'}
    </div>
    ${done.length ? `<div class="card"><h3>${ICON.check} Done</h3>${done.map(taskItem).join('')}</div>` : ''}
  `;

  container.querySelectorAll('input[type="checkbox"][data-id]').forEach(cb => {
    cb.onchange = async () => {
      const wantDone = cb.checked;
      cb.disabled = true;
      try {
        const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(cb.dataset.id)}/status`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: wantDone ? 'done' : 'open' })
        }, 8000);
        if (!res.ok) throw new Error(`Backend returned ${res.status}`);
        // Update this one item in place instead of re-rendering the whole
        // list — a full re-render immediately moves the checked item into
        // a "Done" section that's often scrolled off-screen on a long
        // list, so the item you just checked appears to vanish. Confirmed
        // real: a checkbox that visibly worked read as "broken" to a live
        // tester because of exactly this. It'll settle into its Done/Open
        // grouping next time the tab is reloaded.
        cb.disabled = false;
        const wrapper = cb.closest('.agency, .flag');
        const title = wrapper?.querySelector('b');
        if (wrapper) wrapper.style.opacity = wantDone ? '.55' : '';
        if (title) title.style.textDecoration = wantDone ? 'line-through' : '';
      } catch (err) {
        cb.checked = !wantDone;
        cb.disabled = false;
      }
    };
  });

  container.querySelectorAll('button[data-go]').forEach(b => {
    b.onclick = () => { if (goTo) goTo(b.dataset.go); };
  });
}
