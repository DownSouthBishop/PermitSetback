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

const MIC_ICON = `<svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a2 2 0 0 0-2 2v5a2 2 0 1 0 4 0V3a2 2 0 0 0-2-2z"/><path d="M3.5 7a.5.5 0 0 1 .5.5V8a4 4 0 0 0 8 0v-.5a.5.5 0 0 1 1 0V8a5 5 0 0 1-4.5 4.975V14h1.5a.5.5 0 0 1 0 1h-4a.5.5 0 0 1 0-1H7v-1.025A5 5 0 0 1 3 8v-.5a.5.5 0 0 1 .5-.5z"/></svg>`;

function micSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export async function render(container, project) {
  container.innerHTML = `
    <div class="card">
      <h3>Ask about this project</h3>
      <div id="advisorLog" style="max-height:420px;overflow-y:auto;margin-bottom:14px;"></div>
      <div id="advisorErr"></div>
      <div style="display:flex;gap:8px;">
        <input id="advisorInput" placeholder="e.g. What if I move the pool 5 feet?" style="flex:1;background:var(--paper);border:1.5px solid var(--line);color:var(--ink);border-radius:8px;padding:11px 12px;font-size:14px;">
        ${micSupported() ? `<button type="button" class="micbtn" id="advisorMic" title="Speak your question" aria-label="Speak your question">${MIC_ICON}</button>` : ''}
        <button class="btn small" id="advisorSend" style="width:auto;">Ask</button>
      </div>
      <div id="advisorMicStatus"></div>
    </div>
  `;

  const log = container.querySelector('#advisorLog');
  const input = container.querySelector('#advisorInput');
  const sendBtn = container.querySelector('#advisorSend');
  const errBox = container.querySelector('#advisorErr');
  const micBtn = container.querySelector('#advisorMic');
  const micStatus = container.querySelector('#advisorMicStatus');

  let listening = false;
  let recognizer = null;
  if (micBtn) {
    micBtn.onclick = () => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (listening) { recognizer && recognizer.stop(); return; }

      recognizer = new SR();
      recognizer.continuous = true;
      recognizer.interimResults = true;
      recognizer.lang = 'en-US';

      const baseText = input.value.trim() ? input.value.trim() + ' ' : '';
      let finalTranscript = '';

      recognizer.onstart = () => {
        listening = true;
        micBtn.classList.add('listening');
        micStatus.textContent = 'Listening — tap the mic again to stop.';
      };
      recognizer.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalTranscript += t + ' ';
          else interim += t;
        }
        input.value = (baseText + finalTranscript + interim).trim();
      };
      recognizer.onerror = (e) => {
        micStatus.textContent = e.error === 'not-allowed'
          ? 'Microphone access was denied — you can still type your question.'
          : "Didn't catch that — tap the mic to try again, or just type.";
      };
      recognizer.onend = () => {
        listening = false;
        micBtn.classList.remove('listening');
        if (micStatus.textContent.startsWith('Listening')) micStatus.textContent = '';
      };
      recognizer.start();
    };
  }

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
    sendBtn.innerHTML = `<span class="spinner"></span>Thinking...`;
    messages.push({ role: 'user', content: text });
    renderLog(messages);

    try {
      const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/conversation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      }, 160000);
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
