// Documents — permit narrative (already generated at roadmap time) plus the
// checklist/summary/questions set this module generates on demand. Each is
// copyable on its own, same interaction as the Permits module's narrative.

import { esc, ICON, fetchWithTimeout, BACKEND_ORIGIN, tradeLabel, cityOf, renderUpgradeCard } from './shared.js';

function docCard(doc, index) {
  return `
    <div class="card">
      <h3>${ICON.doc} ${esc(doc.title)}</h3>
      <div class="narrative" id="doc-${index}">${esc(doc.content)}</div>
      <button class="copybtn" data-idx="${index}">Copy</button>
    </div>
  `;
}

function wireCopyButtons(container) {
  container.querySelectorAll('button[data-idx]').forEach(btn => {
    btn.onclick = async () => {
      const text = container.querySelector(`#doc-${btn.dataset.idx}`).innerText;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(text);
          btn.textContent = 'Copied';
        } catch (err) {
          btn.textContent = 'Select the text above to copy';
        }
      }
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    };
  });
}

function renderDocs(container, documents) {
  container.innerHTML = documents.map(docCard).join('') +
    `<p class="disc">These are drafts to review and adapt, not final submissions — confirm specifics with the relevant party before sending.</p>`;
  wireCopyButtons(container);
}

async function generate(container, project) {
  container.innerHTML = `<div class="card"><p style="color:var(--ink-soft);font-size:13px;"><span class="spinner"></span>Generating your document set — checklist, owner and contractor summaries, HOA and building department questions, inspection order... this can take a couple of minutes.</p></div>`;
  try {
    // Six full documents in one generation legitimately takes longer than
    // the usual 8-60s calls elsewhere in the app.
    const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/documents`, { method: 'POST' }, 160000);
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    const { documents } = await res.json();
    renderDocs(container, documents);
  } catch (err) {
    container.innerHTML = `<div class="card"><h3>${ICON.doc} Documents</h3><div class="err">Couldn't generate documents — is the backend running? Try again in a moment.</div></div>`;
  }
}

export async function render(container, project) {
  container.innerHTML = `<div class="card"><p style="color:var(--ink-soft);font-size:13px;">Loading documents...</p></div>`;

  let documents;
  try {
    const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/documents`, {}, 8000);
    if (res.status === 402) { renderUpgradeCard(container, project, 'Documents', ICON.doc); return; }
    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    ({ documents } = await res.json());
  } catch (err) {
    container.innerHTML = `<div class="card"><h3>${ICON.doc} Documents</h3><div class="err">Couldn't load documents — is the backend running?</div></div>`;
    return;
  }

  // Only the narrative (always present) means the rest hasn't been generated yet.
  if (documents.length <= 1) {
    container.innerHTML = `
      <div class="card">
        <h3>${ICON.doc} Ready-to-hand-off paperwork</h3>
        <p style="color:var(--ink-soft);font-size:13.5px;margin:0 0 14px;">A permit checklist, owner and contractor summaries, HOA and building department questions, and the likely inspection order — all specific to this ${esc(tradeLabel(project.trade).toLowerCase())} project in ${esc(cityOf(project.location)) || 'your area'}.</p>
        <button class="btn" id="generate">Generate documents</button>
      </div>
      ${docCard(documents[0], 0)}
    `;
    container.querySelector('#generate').onclick = () => generate(container, project);
    wireCopyButtons(container);
    return;
  }

  renderDocs(container, documents);
}
