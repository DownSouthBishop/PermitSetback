// Documents — permit narrative (already generated at roadmap time) plus the
// checklist/summary/questions set this module generates on demand. Each is
// copyable on its own, same interaction as the Permits module's narrative.

import { esc, ICON, fetchWithTimeout, BACKEND_ORIGIN, tradeLabel, cityOf, renderUpgradeCard, logEvent } from './shared.js';

// Confirm-before-filing hedge for the two document types that ask the
// county/HOA a direct question rather than just organizing what's already
// known — matches the same hedge the permit narrative and workspace
// disclaimers already carry elsewhere; these are the two most likely to be
// read as more authoritative than they are.
const CONFIRM_CAPTION = {
  building_dept_questions: 'Confirm before submitting — the building department has the final word.',
  hoa_questions: 'Confirm before submitting — the HOA has the final word.'
};

function docCard(doc, index) {
  const caption = CONFIRM_CAPTION[doc.docType] ? `<p style="color:var(--ink-soft);font-size:12px;margin:8px 0 0;">${esc(CONFIRM_CAPTION[doc.docType])}</p>` : '';
  return `
    <div class="card">
      <h3>${ICON.doc} ${esc(doc.title)}</h3>
      <div class="narrative" id="doc-${index}">${esc(doc.content)}</div>
      <button class="copybtn" data-idx="${index}">Copy</button>
      ${caption}
    </div>
  `;
}

// Groups the flat document list into the three-audience structure a
// contractor actually hands these to: the homeowner, the county, and
// themselves. Order within each group is the order documents arrive in
// (server-decided), not re-sorted here.
const DOC_GROUPS = [
  { heading: 'For your client', types: ['owner_summary'] },
  { heading: 'For the county', types: ['permit_narrative', 'permit_checklist', 'hoa_questions', 'building_dept_questions', 'inspection_checklist'] },
  { heading: 'For you', types: ['contractor_summary'] }
];

function groupHeadingHtml(heading) {
  return `<h4 style="font-size:12.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink-soft);margin:20px 0 8px;">${esc(heading)}</h4>`;
}

// What goes on the cover of the Client Packet PDF (Phase 2.2's print view) —
// lives here rather than its own tab since it's meaningless without the
// packet it brands. Revisable anytime; POST /api/projects/:id/branding is a
// plain update, not a one-shot grant.
function brandingFormHtml(project) {
  return `
    <div class="card" id="brandingCard">
      <h3>${ICON.doc} Put your company on the cover</h3>
      <p style="color:var(--ink-soft);font-size:13px;margin:0 0 14px;">This appears on every page of your Client Packet PDF. It should — you're the one winning the job.</p>
      <label for="brandCompanyName" style="display:block;font-size:13px;font-weight:600;margin:0 0 4px;">Company name</label>
      <input id="brandCompanyName" placeholder="e.g. Acme Contracting" value="${esc(project.companyName || '')}">
      <label for="brandCompanyContact" style="display:block;font-size:13px;font-weight:600;margin:0 0 4px;">Contact line</label>
      <input id="brandCompanyContact" placeholder="e.g. (555) 010-0100 &middot; info@acme.com" value="${esc(project.companyContact || '')}">
      <label for="brandLogoUrl" style="display:block;font-size:13px;font-weight:600;margin:0 0 4px;">Logo URL (optional)</label>
      <input id="brandLogoUrl" placeholder="https://..." value="${esc(project.companyLogoUrl || '')}">
      <div id="brandErr"></div>
      <button class="btn secondary" id="brandSave">Save branding</button>
    </div>
  `;
}

// The two zero-dependency PDFs (print-styled pages + window.print(), no PDF
// library) — see client-packet.html and submission-pack.html. Both pages
// determine white-label branding server-side from project.whiteLabel; they
// never take it as a query param or anything else client-supplied.
function printLinksHtml(project) {
  return `
    <div class="card">
      <h3>${ICON.doc} Print your packet</h3>
      <a class="btn" href="client-packet.html?id=${encodeURIComponent(project.id)}" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none;margin-bottom:8px;">Download Client Packet (PDF)</a>
      <p style="font-size:12px;color:var(--ink-soft);margin:0 0 12px;">Branded, client-facing pages only.</p>
      <a class="btn secondary" href="submission-pack.html?id=${encodeURIComponent(project.id)}" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none;">Download City Submission Pack (PDF)</a>
      <p style="font-size:12px;color:var(--ink-soft);margin:8px 0 0;">Your working file for the county.</p>
    </div>
  `;
}

function wireBrandingForm(container, project) {
  const btn = container.querySelector('#brandSave');
  if (!btn) return;
  btn.onclick = async () => {
    const companyName = container.querySelector('#brandCompanyName').value.trim();
    const companyContact = container.querySelector('#brandCompanyContact').value.trim();
    const companyLogoUrl = container.querySelector('#brandLogoUrl').value.trim();
    const errBox = container.querySelector('#brandErr');
    errBox.innerHTML = '';
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>Saving...`;
    try {
      const res = await fetchWithTimeout(`${BACKEND_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/branding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName, companyContact, companyLogoUrl })
      }, 8000);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Backend returned ${res.status}`);
      Object.assign(project, { companyName: body.companyName, companyContact: body.companyContact, companyLogoUrl: body.companyLogoUrl });
      logEvent('branding_saved', { projectId: project.id });
      btn.textContent = 'Saved';
      setTimeout(() => { btn.textContent = 'Save branding'; btn.disabled = false; }, 1500);
    } catch (err) {
      errBox.innerHTML = `<div class="err">${esc(err.message || "Couldn't save — try again.")}</div>`;
      btn.disabled = false;
      btn.textContent = 'Save branding';
    }
  };
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

function renderDocs(container, documents, project) {
  const byType = new Map();
  documents.forEach((doc, index) => {
    if (!byType.has(doc.docType)) byType.set(doc.docType, []);
    byType.get(doc.docType).push({ doc, index });
  });
  const grouped = DOC_GROUPS.map(group => {
    const entries = group.types.flatMap(t => byType.get(t) || []);
    if (!entries.length) return '';
    return groupHeadingHtml(group.heading) + entries.map(({ doc, index }) => docCard(doc, index)).join('');
  }).join('');
  container.innerHTML = brandingFormHtml(project) + printLinksHtml(project) + grouped +
    `<p class="disc">These are drafts to review and adapt, not final submissions — confirm specifics with the relevant party before sending.</p>`;
  wireBrandingForm(container, project);
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
    renderDocs(container, documents, project);
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
    container.innerHTML = brandingFormHtml(project) + printLinksHtml(project) + `
      <div class="card">
        <h3>${ICON.doc} Ready-to-hand-off paperwork</h3>
        <p style="color:var(--ink-soft);font-size:13.5px;margin:0 0 14px;">A permit checklist, owner and contractor summaries, HOA and building department questions, and the likely inspection order — all specific to this ${esc(tradeLabel(project.trade).toLowerCase())} project in ${esc(cityOf(project.location)) || 'your area'}.</p>
        <button class="btn" id="generate">Generate documents</button>
      </div>
      ${docCard(documents[0], 0)}
    `;
    wireBrandingForm(container, project);
    container.querySelector('#generate').onclick = () => generate(container, project);
    wireCopyButtons(container);
    return;
  }

  renderDocs(container, documents, project);
}
