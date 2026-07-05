// AI Advisor — persistent chat scoped to this project. Loads prior history
// on open, appends new turns as they happen; the backend (routes/advisor.js)
// is what actually remembers and avoids regenerating the roadmap from
// scratch on every question.

import { esc, fetchWithTimeout, BACKEND_ORIGIN } from './shared.js';

function bubble(role, content) {
  const mine = role === 'user';
  return `<div style="display:flex;justify-content:${mine ? 'flex-end' : 'flex-start'};margin-bottom:10px;">
    <div style="max-width:80%;background:${mine ? 'var(--accent-tint)' : 'var(--paper)'};border:1px solid var(--line);border-radius:10px;padding:10px 13px;font-size:13.5px;white-space:pre-wrap;">${esc(content)}</div>
  </div>`;
}

export async function render(container, project) {
  container.innerHTML = `
    <div class="card">
      <h3>Ask about this project</h3>
      <div id="advisorLog" style="max-height:420px;overflow-y:auto;margin-bottom:14px;"></div>
      <div id="advisorErr"></div>
      <div style="display:flex;gap:8px;">
        <input id="advisorInput" placeholder="e.g. What if I move the pool 5 feet?" style="flex:1;background:var(--paper);border:1.5px solid var(--line);color:var(--ink);border-radius:8px;padding:11px 12px;font-size:14px;">
        <button class="btn small" id="advisorSend" style="width:auto;">Ask</button>
      </div>
    </div>
  `;

  const log = container.querySelector('#advisorLog');
  const input = container.querySelector('#advisorInput');
  const sendBtn = container.querySelector('#advisorSend');
  const errBox = container.querySelector('#advisorErr');

  function renderLog(messages) {
    log.innerHTML = messages.length
      ? messages.map(m => bubble(m.role, m.content)).join('')
      : `<p style="color:var(--ink-soft);font-size:13px;">No questions yet — ask anything about this project's permits, timeline, or risks.</p>`;
    log.scrollTop = log.scrollHeight;
  }

  let messages = [];
  try {
    const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/conversation`, {}, 8000);
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    ({ messages } = await res.json());
  } catch (err) {
    errBox.innerHTML = `<div class="err">Couldn't load the conversation — is the backend running?</div>`;
  }
  renderLog(messages);

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    errBox.innerHTML = '';
    input.value = '';
    input.disabled = true;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Thinking...';
    messages.push({ role: 'user', content: text });
    renderLog(messages);

    try {
      const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/conversation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      }, 60000);
      if (!res.ok) throw new Error(`Backend returned ${res.status}`);
      const { reply } = await res.json();
      messages.push({ role: 'assistant', content: reply });
      renderLog(messages);
    } catch (err) {
      errBox.innerHTML = `<div class="err">The advisor didn't respond — try again in a moment.</div>`;
    } finally {
      input.disabled = false;
      sendBtn.disabled = false;
      sendBtn.textContent = 'Ask';
      input.focus();
    }
  }

  sendBtn.onclick = send;
  input.onkeydown = (e) => { if (e.key === 'Enter') send(); };
}
