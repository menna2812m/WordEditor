(() => {
'use strict';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const doc = $('#doc'), pagesEl = $('#pages'), scaler = $('#scaler'), holder = $('#holder'), canvas = $('#canvas');
const TW = 15;                       // twips per CSS px at 96 dpi
const GAP = 22;                      // gap between pages, px
const CM = 37.7953;                  // px per cm
const PT = 4 / 3;                    // px per pt
const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,blockquote,li,td,th,div';

/* Hosted (?host=1 inside an iframe): the platform page sends the document and receives saves via postMessage,
   and the mode/role come from the URL instead of the demo switch. */
const QS = new URLSearchParams(location.search);
const HOSTED = QS.get('host') === '1' && window.parent !== window;
const CE_MODE = QS.get('mode') || window.CE_MODE;
const MODE = ['comment', 'review', 'view'].includes(CE_MODE) ? CE_MODE : 'full';
const toHost = (msg, transfer) => window.parent.postMessage(msg, location.origin, transfer || []);
const DRAFT_KEY = 'contractseditor-draft-v1-' + MODE;
const state = {
  track: false, markup: 'all', role: 'initiator', roleNames: { initiator: 'Sara (Initiator)', approver: 'Khalid (Approver)' }, activeTc: null,
  page: { w: 11906, h: 16838, top: 1440, right: 1440, bottom: 1440, left: 1440, orient: 'portrait' },
  comments: [], title: 'Services Agreement (sample)', author: 'You',
  zoom: 1, fit: null, ruler: true, marks: false, spell: false,
  fc: '#C00000', hl: '#FFFF00', painter: null, pendingSize: null, activeCid: null, side: null,
  pageCount: 1, downloads: null, loading: false, dirty: false, saving: false
};
if (QS.get('role') === 'approver') state.role = 'approver';
const pageW = () => state.page.w / TW, pageH = () => state.page.h / TW;
const contentW = () => (state.page.w - state.page.left - state.page.right) / TW;
const contentH = () => (state.page.h - state.page.top - state.page.bottom) / TW;

/* ---------- fonts & sizes ---------- */
const FONTS = ['Calibri', 'Calibri Light', 'Arial', 'Times New Roman', 'Cambria', 'Georgia', 'Verdana', 'Tahoma', 'Segoe UI', 'Courier New', 'Lora', 'Amiri', 'Noto Naskh Arabic', 'Cairo', 'Tajawal', 'IBM Plex Sans Arabic', 'Traditional Arabic', 'Simplified Arabic'];
const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
$('#fontName').innerHTML = FONTS.map(f => `<option style="font-family:'${f}'">${f}</option>`).join('');
$('#fontSize').innerHTML = SIZES.map(s => `<option>${s}</option>`).join(''); $('#fontSize').value = '11';

const STYLES = [
  { k: 'p', name: 'Normal', css: 'font-size:11pt' },
  { k: 'title', name: 'Title', css: "font:20pt/1 'Calibri Light',Carlito,Arial" },
  { k: 'subtitle', name: 'Subtitle', css: 'font-size:12pt;color:#595959' },
  { k: 'h1', name: 'Heading 1', css: 'font-size:15pt;color:#1f3864;font-weight:700' },
  { k: 'h2', name: 'Heading 2', css: 'font-size:13pt;color:#2e4a7d;font-weight:700' },
  { k: 'h3', name: 'Heading 3', css: 'font-size:12pt;color:#2e4a7d;font-weight:700' },
  { k: 'blockquote', name: 'Quote', css: 'font-style:italic;color:#404040' }
];
$('#styles').innerHTML = STYLES.map(s => `<button class="sty" data-style="${s.k}" title="${s.name}"><span class="s" style="${s.css}">AaBbCc</span><small>${s.name}</small></button>`).join('');

/* ---------- selection helpers ---------- */
let saved = null;
function inDoc(n) { return n && (n === doc || doc.contains(n)); }
function curRange() { const s = getSelection(); if (s.rangeCount && inDoc(s.anchorNode)) return s.getRangeAt(0); return saved; }
function restore() {
  const wasIn = document.activeElement === doc;
  if (!wasIn) doc.focus({ preventScroll: true });
  const s = getSelection();
  if (saved && (!wasIn || !(s.rangeCount && inDoc(s.anchorNode)))) { s.removeAllRanges(); s.addRange(saved); }
}
function selectRange(r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); saved = r.cloneRange(); }
function blockOf(n) { while (n && n !== doc) { if (n.nodeType === 1 && n.matches(BLOCKS) && !n.querySelector(':scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > blockquote')) return n; n = n.parentNode; } return null; }
function selBlocks() {
  const r = curRange(); if (!r) return [];
  if (r.collapsed) { const b = blockOf(r.startContainer); return b ? [b] : []; }
  const all = [...doc.querySelectorAll(BLOCKS)].filter(b => !b.querySelector('p,h1,h2,h3,h4,h5,h6,blockquote,li,table'));
  return all.filter(b => r.intersectsNode(b));
}
function textIndex() {
  const nodes = [], w = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT); let s = '', n;
  while ((n = w.nextNode())) { nodes.push({ n, start: s.length }); s += n.data; }
  return { s, nodes };
}
function pointAt(ix, off, preferEnd) {
  for (let i = 0; i < ix.nodes.length; i++) {
    const { n, start } = ix.nodes[i], end = start + n.data.length;
    if (off < end || (off === end && (preferEnd || i === ix.nodes.length - 1))) return [n, Math.max(0, off - start)];
  }
  return [doc, doc.childNodes.length];
}
function rangeFromOffsets(a, b, ix) {
  ix = ix || textIndex(); const r = document.createRange();
  const [sn, so] = pointAt(ix, a, false), [en, eo] = pointAt(ix, b, true);
  try { r.setStart(sn, so); r.setEnd(en, eo); } catch (e) { r.selectNodeContents(doc); r.collapse(false); }
  return r;
}
function offsetsOf(r) {
  const ix = textIndex(); const pos = (node, off) => {
    if (node.nodeType === 3) { const e = ix.nodes.find(x => x.n === node); return e ? e.start + off : 0; }
    const pre = document.createRange(); pre.setStart(doc, 0); pre.setEnd(node, off); return pre.toString().length;
  };
  return [pos(r.startContainer, r.startOffset), pos(r.endContainer, r.endOffset)];
}

/* ---------- history (own stack so table/comment/page edits undo too) ---------- */
const hist = { stack: [], idx: -1, t: 0 };
function cleanHTML() {
  const c = doc.cloneNode(true);
  c.querySelectorAll('[data-pg]').forEach(e => { e.removeAttribute('data-pg'); e.style.removeProperty('--pg'); e.style.removeProperty('--m0'); if (!e.getAttribute('style')) e.removeAttribute('style'); });
  c.querySelectorAll('.img-sel,.cmt.active').forEach(e => e.classList.remove('img-sel', 'active'));
  c.querySelectorAll('[class=""]').forEach(e => e.removeAttribute('class'));
  return c.innerHTML;
}
function snap() { const r = curRange(); return { html: cleanHTML(), sel: r ? offsetsOf(r) : [0, 0], comments: JSON.stringify(state.comments), page: JSON.stringify(state.page), dir: doc.getAttribute('dir') || '' }; }
function commit() {
  clearTimeout(hist.t);
  const s = snap(), top = hist.stack[hist.idx];
  if (top && top.html === s.html && top.comments === s.comments && top.page === s.page && top.dir === s.dir) { top.sel = s.sel; return; }
  hist.stack = hist.stack.slice(0, hist.idx + 1); hist.stack.push(s);
  if (hist.stack.length > 300) hist.stack.shift();
  hist.idx = hist.stack.length - 1;
  changed();
}
function commitSoon() { clearTimeout(hist.t); hist.t = setTimeout(commit, 450); }
function applySnap(s) {
  doc.innerHTML = s.html; state.comments = JSON.parse(s.comments); state.page = JSON.parse(s.page);
  if (s.dir) doc.setAttribute('dir', s.dir); else doc.removeAttribute('dir');
  layout(); renderSide();
  doc.focus({ preventScroll: true }); selectRange(rangeFromOffsets(s.sel[0], s.sel[1]));
  changed(true);
}
function undo() { commit(); if (hist.idx > 0) applySnap(hist.stack[--hist.idx]); }
function redo() { commit(); if (hist.idx < hist.stack.length - 1) applySnap(hist.stack[++hist.idx]); }

/* ---------- autosave draft (this browser only) ---------- */
let draftT = 0;
function changed(fromHistory) {
  if (HOSTED) {
    if (!state.loading && !state.dirty) { state.dirty = true; toHost({ type: 'ce:dirty', dirty: true }); }
    if (!state.saving) $('#savestate').textContent = state.dirty ? 'Unsaved changes' : 'All changes saved';
    schedLayout(); updateStatus(); return;
  }
  $('#savestate').textContent = 'Saving…';
  clearTimeout(draftT);
  draftT = setTimeout(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ html: cleanHTML(), comments: state.comments, page: state.page, title: state.title, author: state.author, dir: doc.getAttribute('dir') || '' })); $('#savestate').textContent = 'Saved in this browser'; }
    catch (e) { $('#savestate').textContent = 'Not saved — browser storage is off'; }
  }, 700);
  schedLayout(); updateStatus();
}

/* ---------- layout: zoom, pages, pagination, ruler ---------- */
let layT = 0;
function schedLayout() { cancelAnimationFrame(layT); layT = requestAnimationFrame(layout); }
function units() {
  const u = [];
  for (const c of doc.children) { if (c.tagName === 'UL' || c.tagName === 'OL') u.push(...[...c.children].filter(x => x.tagName === 'LI')); else u.push(c); }
  return u;
}
function paginate() {
  doc.querySelectorAll('[data-pg]').forEach(e => { e.removeAttribute('data-pg'); e.style.removeProperty('--pg'); e.style.removeProperty('--m0'); if (!e.getAttribute('style')) e.removeAttribute('style'); });
  const ph = pageH(), ch = contentH(), stride = ph + GAP;
  const startY = k => k * stride;      // content top of page k, in doc coordinates
  let page = 0, force = false, prev = null;
  for (let b of units()) {
    if (b.tagName === 'HR' && b.classList.contains('page-break')) { force = true; prev = null; continue; }
    let top = b.offsetTop, bottom = top + b.offsetHeight;
    while (top >= startY(page) + ch && !force) page++;      // already pushed below by earlier spacing
    if (force || (bottom > startY(page) + ch + 0.5 && top > startY(page) + 1)) {
      // keep a heading with the paragraph that follows it, as Word's "keep with next" does
      if (!force && prev && /^H[1-6]$/.test(prev.tagName) && prev.offsetTop > startY(page) + 1 && !prev.hasAttribute('data-pg')) b = prev;
      page++; force = false;
      const m0 = parseFloat(getComputedStyle(b).marginTop) || 0;
      b.style.setProperty('--m0', m0 + 'px'); b.style.setProperty('--pg', '0px'); b.setAttribute('data-pg', '');
      for (let k = 0; k < 2; k++) { const d = startY(page) - b.offsetTop; if (Math.abs(d) < 0.5) break; b.style.setProperty('--pg', (parseFloat(b.style.getPropertyValue('--pg')) + d) + 'px'); }
    }
    prev = b;
  }
  const last = doc.lastElementChild;
  const endY = last ? last.offsetTop + last.offsetHeight : 0;
  return Math.max(page + 1, Math.floor(Math.max(0, endY - 1) / stride) + 1);
}
function layout() {
  const p = state.page, pw = pageW(), ph = pageH();
  scaler.style.width = pw + 'px';
  doc.style.margin = `${p.top / TW}px ${p.right / TW}px 0 ${p.left / TW}px`;
  doc.style.minHeight = contentH() + 'px';
  const n = paginate(); state.pageCount = n;
  if (pagesEl.children.length !== n || pagesEl.dataset.k !== pw + 'x' + ph) {
    pagesEl.innerHTML = Array.from({ length: n }, (_, i) => `<div class="pg" style="top:${i * (ph + GAP)}px;width:${pw}px;height:${ph}px"><div class="no">${i + 1}</div></div>`).join('');
    pagesEl.dataset.k = pw + 'x' + ph;
  }
  const H = n * ph + (n - 1) * GAP;
  scaler.style.height = H + 'px';
  if (state.fit) state.zoom = fitZoom(state.fit);
  const z = state.zoom;
  scaler.style.transform = `scale(${z})`;
  holder.style.width = pw * z + 'px'; holder.style.height = H * z + 'px';
  $('#zRange').value = Math.round(z * 100); $('#zVal').textContent = Math.round(z * 100) + '%';
  drawRuler(); updateStatus();
}
function fitZoom(mode) {
  const avail = canvas.clientWidth - 32;
  if (mode === 'width') return Math.max(0.3, Math.min(2, avail / pageW()));
  return Math.max(0.3, Math.min(2, Math.min(avail / pageW(), (canvas.clientHeight - 70) / pageH())));
}
function setZoom(z, fit) { state.fit = fit || null; state.zoom = fit ? fitZoom(fit) : Math.max(0.3, Math.min(2, z)); layout(); }
function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function drawRuler() {
  const bar = $('#rulerbar'); bar.hidden = !state.ruler; if (!state.ruler) return;
  const cv = $('#ruler'), z = state.zoom, w = pageW() * z, dpr = window.devicePixelRatio || 1;
  cv.style.width = w + 'px'; cv.style.height = '22px'; cv.width = Math.round(w * dpr); cv.height = Math.round(22 * dpr);
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const L = state.page.left / TW * z, R = w - state.page.right / TW * z;
  c.fillStyle = css('--line'); c.fillRect(0, 0, w, 22);
  c.fillStyle = css('--surface'); c.fillRect(L, 0, R - L, 22);
  c.strokeStyle = c.fillStyle = css('--muted'); c.lineWidth = 1; c.font = '10px ' + css('--ui'); c.textAlign = 'center'; c.textBaseline = 'middle';
  const step = CM * z / 4;
  for (let dir of [1, -1]) for (let i = dir === 1 ? 0 : 1; ; i++) {
    const x = L + dir * i * step; if (x < 0 || x > w) break;
    if (i % 4 === 0) { if (i) c.fillText(String(i / 4), x, 11); }
    else { const h = i % 2 ? 3 : 6; c.beginPath(); c.moveTo(Math.round(x) + .5, 11 - h / 2); c.lineTo(Math.round(x) + .5, 11 + h / 2); c.stroke(); }
  }
}

/* ---------- status ---------- */
function updateStatus() {
  const ix = textIndex(); const words = (ix.s.match(/[^\s​]+/g) || []).length;
  $('#stWords').textContent = words.toLocaleString() + (words === 1 ? ' word' : ' words');
  const r = curRange(); let pg = 1;
  if (r) { const rc = (r.getClientRects()[0] || (r.startContainer.nodeType === 1 ? r.startContainer.getBoundingClientRect() : r.startContainer.parentElement.getBoundingClientRect())); const top = scaler.getBoundingClientRect().top; pg = Math.min(state.pageCount, Math.max(1, Math.floor((rc.top - top) / state.zoom / (pageH() + GAP)) + 1)); }
  $('#stPage').textContent = `Page ${pg} of ${state.pageCount}`;
  const b = r && blockOf(r.startContainer);
  $('#stLang').textContent = b && /[؀-ۿ]/.test(b.textContent) ? 'Arabic (Saudi Arabia)' : 'English (US)';
}

/* ---------- ribbon state ---------- */
function rgbToHex(c) { const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || ''); return m ? '#' + [m[1], m[2], m[3]].map(v => (+v).toString(16).padStart(2, '0')).join('') : c; }
function updateState() {
  const r = curRange(); if (!r) return;
  const q = c => { try { return document.queryCommandState(c); } catch (e) { return false; } };
  ['bold', 'italic', 'underline', 'strikeThrough', 'subscript', 'superscript', 'insertUnorderedList', 'insertOrderedList'].forEach(c => $$(`[data-cmd="${c}"]`).forEach(b => b.classList.toggle('on', q(c))));
  const el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
  if (!el || !inDoc(el)) return;
  const cs = getComputedStyle(el);
  const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
  const fsel = $('#fontName');
  if (![...fsel.options].some(o => o.value === fam)) fsel.add(new Option(fam, fam));
  fsel.value = fam;
  const pt = Math.round(parseFloat(cs.fontSize) / PT * 2) / 2;
  const ssel = $('#fontSize'); if (![...ssel.options].some(o => +o.value === pt)) ssel.add(new Option(pt, pt)); ssel.value = String(pt);
  const b = blockOf(el);
  const bcs = b ? getComputedStyle(b) : cs;
  const rtl = bcs.direction === 'rtl';
  let ta = bcs.textAlign; if (ta === 'start') ta = rtl ? 'right' : 'left'; if (ta === 'end') ta = rtl ? 'left' : 'right';
  [['justifyLeft', 'left'], ['justifyCenter', 'center'], ['justifyRight', 'right'], ['justifyFull', 'justify']].forEach(([c, v]) => $(`[data-cmd="${c}"]`).classList.toggle('on', ta === v));
  $('[data-cmd="rtl"]').classList.toggle('on', rtl); $('[data-cmd="ltr"]').classList.toggle('on', !rtl);
  const key = !b ? 'p' : /^H[1-3]$/.test(b.tagName) ? b.tagName.toLowerCase() : b.tagName === 'BLOCKQUOTE' ? 'blockquote' : b.classList.contains('title') ? 'title' : b.classList.contains('subtitle') ? 'subtitle' : 'p';
  $$('.sty').forEach(s => s.classList.toggle('on', s.dataset.style === key));
  if (b && document.activeElement && !document.activeElement.classList.contains('num')) {
    $('#spB').value = Math.round(parseFloat(bcs.marginTop) / PT); $('#spA').value = Math.round(parseFloat(bcs.marginBottom) / PT);
    $('#indL').value = (parseFloat(rtl ? bcs.marginRight : bcs.marginLeft) / CM).toFixed(2).replace(/\.?0+$/, '') || 0;
    $('#indF').value = (parseFloat(bcs.textIndent) / CM).toFixed(2).replace(/\.?0+$/, '') || 0;
  }
  // contextual tabs
  const inTable = !!el.closest('td,th');
  const img = doc.querySelector('img.img-sel');
  showCtx('table', inTable && !!P().format); showCtx('picture', !!img && !!P().format);
  const tcEl = el.closest('ins.tc,del.tc,[data-tc-mark]'); if (tcEl) { if (state.activeTc !== tcEl.dataset.tc) highlightChange(tcEl.dataset.tc, false); } else if (state.activeTc && !(state.side === 'changes')) highlightChange(null);
  // comments
  const cm = el.closest('.cmt'); setActiveComment(cm ? cm.dataset.cid : null, false);
}
function showCtx(name, on) {
  const t = $(`.tab[data-tab="${name}"]`); if (t.hidden === !on) return;
  t.hidden = !on;
  if (!on && t.getAttribute('aria-selected') === 'true') selectTab('home');
  if (on && name === 'picture') selectTab('picture');
}
function selectTab(name) {
  $$('.tab[data-tab]').forEach(t => t.setAttribute('aria-selected', t.dataset.tab === name ? 'true' : 'false'));
  $$('.panel').forEach(p => p.hidden = p.dataset.panel !== name);
}

/* ---------- formatting commands ---------- */
function ex(cmd, val, css) { restore(); try { document.execCommand('styleWithCSS', false, !!css); } catch (e) { } document.execCommand(cmd, false, val); }
function normalizeFonts(pt) {
  const made = [];
  doc.querySelectorAll('font[size="7"]').forEach(f => {
    const s = document.createElement('span'); s.style.fontSize = (pt || state.pendingSize || 11) + 'pt';
    while (f.firstChild) s.appendChild(f.firstChild);
    if (f.getAttribute('face')) s.style.fontFamily = f.getAttribute('face');
    if (f.getAttribute('color')) s.style.color = f.getAttribute('color');
    f.replaceWith(s); s.querySelectorAll('[style*="font-size"]').forEach(x => { x.style.fontSize = ''; if (!x.getAttribute('style')) x.removeAttribute('style'); });
    made.push(s);
  });
  return made;
}
function setFontSize(pt) {
  pt = Math.max(1, Math.min(400, +pt)); if (!pt) return;
  restore(); const r = curRange();
  state.pendingSize = pt;
  ex('fontSize', '7', false);
  const made = normalizeFonts(pt);
  if (made.length && r && !r.collapsed) { const nr = document.createRange(); nr.setStartBefore(made[0]); nr.setEndAfter(made[made.length - 1]); selectRange(nr); }
  commit(); updateState();
}
function stepSize(dir) {
  const cur = +$('#fontSize').value || 11;
  const next = dir > 0 ? (SIZES.find(s => s > cur) || cur + 10) : ([...SIZES].reverse().find(s => s < cur) || Math.max(1, cur - 1));
  setFontSize(next);
}
function setBlockStyle(k) {
  restore();
  const tag = { p: 'p', title: 'p', subtitle: 'p', h1: 'h1', h2: 'h2', h3: 'h3', blockquote: 'blockquote' }[k];
  const before = selBlocks();
  const inList = before.some(b => b.tagName === 'LI');
  if (!inList) ex('formatBlock', tag);
  selBlocks().forEach(b => { b.classList.remove('title', 'subtitle'); if (k === 'title' || k === 'subtitle') b.classList.add(k); if (!b.className) b.removeAttribute('class'); });
  commit(); updateState();
}
function setDir(dir) {
  restore(); const bs = selBlocks(); if (!bs.length) return;
  bs.forEach(b => {
    const t = b.closest('ul,ol') && b.tagName === 'LI' ? b : b;
    if (dir === 'rtl') { t.setAttribute('dir', 'rtl'); if (!t.style.textAlign || t.style.textAlign === 'left') t.style.textAlign = 'right'; }
    else { t.setAttribute('dir', 'ltr'); if (t.style.textAlign === 'right') t.style.textAlign = 'left'; }
    if ((doc.getAttribute('dir') || 'ltr') === dir) t.removeAttribute('dir');
  });
  commit(); updateState();
}
function indentBlocks(delta) {
  restore(); const bs = selBlocks();
  if (bs.some(b => b.tagName === 'LI')) { ex(delta > 0 ? 'indent' : 'outdent'); commit(); return; }
  bs.forEach(b => { const cur = parseFloat(b.style.marginInlineStart) || 0; const v = Math.max(0, cur + delta * 36); b.style.marginInlineStart = v ? v + 'pt' : ''; if (!b.getAttribute('style')) b.removeAttribute('style'); });
  commit(); updateState();
}
function setBlockCss(prop, val) { restore(); selBlocks().forEach(b => { b.style[prop] = val; if (!b.getAttribute('style')) b.removeAttribute('style'); }); commit(); updateState(); }
function clearFormat() {
  restore(); ex('removeFormat');
  const r = curRange();
  if (r && !r.collapsed) doc.querySelectorAll('span[style],font').forEach(s => { if (r.intersectsNode(s) && !s.classList.contains('cmt') && !s.classList.contains('tab')) { s.removeAttribute('style'); if (s.tagName === 'FONT' || !s.attributes.length) s.replaceWith(...s.childNodes); } });
  selBlocks().forEach(b => { if (b.tagName !== 'LI' && b.tagName !== 'TD' && b.tagName !== 'TH' && b.tagName !== 'P') { const p = document.createElement('p'); while (b.firstChild) p.appendChild(b.firstChild); b.replaceWith(p); } else b.classList.remove('title', 'subtitle'); });
  commit(); updateState();
}
function insertHTML(html) { restore(); ex('insertHTML', html); commit(); }

/* ---------- format painter ---------- */
function capturePainter() {
  const r = curRange(); if (!r) return;
  const el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement;
  const cs = getComputedStyle(el); let bg = null;
  for (let e = el; e && e !== doc; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c) && !e.classList.contains('cmt')) { bg = rgbToHex(c); break; } }
  const q = c => document.queryCommandState(c);
  state.painter = { bold: q('bold'), italic: q('italic'), underline: q('underline'), strikeThrough: q('strikeThrough'), color: rgbToHex(cs.color), bg, size: Math.round(parseFloat(cs.fontSize) / PT * 2) / 2, font: cs.fontFamily.split(',')[0].replace(/["']/g, '') };
  document.body.classList.add('painter'); $('[data-cmd="painter"]').classList.add('on');
  toast('Select the text you want to format.');
}
function applyPainter() {
  const p = state.painter; state.painter = null; document.body.classList.remove('painter'); $('[data-cmd="painter"]').classList.remove('on');
  const r = curRange(); if (!r || r.collapsed) return;
  ['bold', 'italic', 'underline', 'strikeThrough'].forEach(c => { if (document.queryCommandState(c) !== p[c]) ex(c); });
  ex('foreColor', p.color, true); ex('hiliteColor', p.bg || 'transparent', true); ex('fontName', p.font, false);
  setFontSize(p.size);
}

/* ---------- comments ---------- */
function wrapRange(r, make) {
  const root = r.commonAncestorContainer.nodeType === 3 ? r.commonAncestorContainer.parentNode : r.commonAncestorContainer;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); const list = []; let n;
  while ((n = w.nextNode())) if (r.intersectsNode(n) && n.data.length) list.push(n);
  const out = [];
  list.forEach(t => {
    let s = t === r.startContainer ? r.startOffset : 0, e = t === r.endContainer ? r.endOffset : t.data.length;
    if (e <= s) return;
    if (e < t.data.length) t.splitText(e);
    if (s > 0) t = t.splitText(s);
    if (!t.data.trim() && t.parentElement && t.parentElement.matches('tr,tbody,table,ul,ol')) return;
    const span = make(); t.parentNode.insertBefore(span, t); span.appendChild(t); out.push(span);
  });
  return out;
}
function newComment() {
  restore(); let r = curRange(); if (!r) return;
  if (r.collapsed) { const s = getSelection(); s.modify && (s.modify('move', 'backward', 'word'), s.modify('extend', 'forward', 'word')); r = s.rangeCount ? s.getRangeAt(0) : r; }
  if (r.collapsed || !r.toString().trim()) { toast('Select some text to comment on.'); return; }
  const id = 'c' + Date.now().toString(36);
  const spans = wrapRange(r, () => { const s = document.createElement('span'); s.className = 'cmt'; s.dataset.cid = id; return s; });
  if (!spans.length) return;
  state.comments.push({ id, author: currentAuthor(), date: new Date().toISOString(), text: '', draft: true });
  openSide('comments'); setActiveComment(id, false); renderSide(id);
}
function commentOrder() {
  const order = [...new Set([...doc.querySelectorAll('.cmt')].map(s => s.dataset.cid))];
  return order.map(id => state.comments.find(c => c.id === id)).filter(Boolean);
}
function setActiveComment(id, scroll) {
  if (state.activeCid === id && !scroll) return;
  state.activeCid = id;
  doc.querySelectorAll('.cmt.active').forEach(s => s.classList.remove('active'));
  if (id) doc.querySelectorAll(`.cmt[data-cid="${id}"]`).forEach(s => s.classList.add('active'));
  $$('.card[data-cid]').forEach(c => c.classList.toggle('on', c.dataset.cid === id));
  if (scroll && id) { const s = doc.querySelector(`.cmt[data-cid="${id}"]`); if (s) s.scrollIntoView({ block: 'center', behavior: 'smooth' }); const card = $(`.card[data-cid="${id}"]`); if (card) card.scrollIntoView({ block: 'nearest' }); }
}
function removeComment(id) {
  doc.querySelectorAll(`.cmt[data-cid="${id}"]`).forEach(s => s.replaceWith(...s.childNodes));
  doc.normalize();
  state.comments = state.comments.filter(c => c.id !== id);
  if (state.activeCid === id) state.activeCid = null;
  commit(); renderSide();
}
function stepComment(dir) {
  const list = commentOrder(); if (!list.length) { toast('This document has no comments.'); return; }
  openSide('comments');
  let i = list.findIndex(c => c.id === state.activeCid); i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  setActiveComment(list[i].id, true);
}
const initials = n => ((n || '').match(/[\p{L}\p{N}]+/gu) || ['?']).map(s => s[0]).join('').slice(0, 2).toUpperCase();
function when(iso) { if (!iso) return ''; const d = new Date(iso); if (isNaN(d)) return ''; return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }

/* ---------- side pane ---------- */
function openSide(kind) { state.side = kind; $('#side').hidden = false; renderSide(); requestAnimationFrame(() => { if (state.fit) layout(); }); }
function closeSide() { if (state.side === 'comments') state.comments = state.comments.filter(c => !c.draft || c.text); state.side = null; $('#side').hidden = true; clearFind(); if (state.fit) layout(); }
function renderSide(focusId) {
  if (!state.side) return;
  const body = $('#sideBody');
  if (state.side === 'comments') {
    $('#sideTitle').textContent = 'Comments';
    const list = commentOrder();
    if (!list.length) { body.innerHTML = '<div class="empty">No comments yet. Select some text and choose <b>New comment</b>, or press Ctrl+Alt+M.</div>'; return; }
    body.innerHTML = '';
    list.forEach(c => {
      const quote = [...doc.querySelectorAll(`.cmt[data-cid="${c.id}"]`)].map(s => s.textContent).join('').trim();
      const card = document.createElement('div'); card.className = 'card' + (c.id === state.activeCid ? ' on' : ''); card.dataset.cid = c.id;
      card.innerHTML = `<div class="card-h"><span class="avatar"></span><div><b></b><time></time></div></div><div class="quote"></div>`;
      card.querySelector('.avatar').textContent = initials(c.author); card.querySelector('b').textContent = c.author; card.querySelector('time').textContent = when(c.date);
      card.querySelector('.quote').textContent = quote;
      if (c.draft) {
        const ta = document.createElement('textarea'); ta.placeholder = 'Add a comment'; ta.value = c.text; ta.id = 'cm-' + c.id; ta.setAttribute('aria-label', 'Comment text');
        const acts = document.createElement('div'); acts.className = 'acts';
        acts.innerHTML = '<button class="btn" data-a="cancel">Cancel</button><button class="btn primary" data-a="post">Post</button>';
        card.append(ta, acts);
        acts.onclick = e => { const a = e.target.closest('[data-a]'); if (!a) return; if (a.dataset.a === 'cancel') { removeComment(c.id); } else { if (!ta.value.trim()) { ta.focus(); return; } c.text = ta.value.trim(); delete c.draft; commit(); renderSide(); } };
        ta.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) acts.querySelector('[data-a="post"]').click(); if (e.key === 'Escape') acts.querySelector('[data-a="cancel"]').click(); };
        if (focusId === c.id) setTimeout(() => ta.focus(), 30);
      } else {
        const p = document.createElement('p'); p.textContent = c.text; p.dir = 'auto';
        const acts = document.createElement('div'); acts.className = 'acts';
        acts.innerHTML = '<button class="btn" data-a="edit">Edit</button><button class="btn" data-a="del">Resolve</button>';
        acts.onclick = e => { e.stopPropagation(); const a = e.target.closest('[data-a]'); if (!a) return; if (a.dataset.a === 'del') removeComment(c.id); else { c.draft = true; renderSide(c.id); } };
        card.append(p, acts);
      }
      card.addEventListener('click', e => { if (e.target.closest('textarea,.acts')) return; setActiveComment(c.id, true); });
      body.appendChild(card);
    });
  } else if (state.side === 'find') renderFind();
  else if (state.side === 'changes') renderChanges();
}

/* ---------- find & replace ---------- */
const find = { q: '', matches: [], cur: -1, caseSensitive: false, replace: false };
function renderFind() {
  $('#sideTitle').textContent = find.replace ? 'Find and replace' : 'Find';
  const body = $('#sideBody');
  if (!body.querySelector('#fQ')) {
    body.innerHTML = `<label class="field">Find what<input type="text" id="fQ" autocomplete="off"></label>
      <label class="field" id="fRwrap">Replace with<input type="text" id="fR" autocomplete="off"></label>
      <label class="chk"><input type="checkbox" id="fCase"> Match case</label>
      <div class="find-nav"><span class="find-count" id="fCount">Type to search</span><span class="row"><button class="rb" id="fPrev" title="Previous result"><svg class="i" viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg></button><button class="rb" id="fNext" title="Next result"><svg class="i" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></button></span></div>
      <div class="row" id="fActs" style="gap:6px"><button class="btn" id="fOne">Replace</button><button class="btn" id="fAll">Replace all</button></div>`;
    $('#fQ').oninput = e => { find.q = e.target.value; runFind(); };
    $('#fQ').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); } };
    $('#fCase').onchange = e => { find.caseSensitive = e.target.checked; runFind(); };
    $('#fPrev').onclick = () => stepFind(-1); $('#fNext').onclick = () => stepFind(1);
    $('#fOne').onclick = replaceOne; $('#fAll').onclick = replaceAll;
  }
  $('#fRwrap').hidden = !find.replace; $('#fActs').hidden = !find.replace;
  $('#fQ').value = find.q; runFind();
}
function clearFind() { find.matches = []; if (window.CSS && CSS.highlights) { CSS.highlights.delete('find'); CSS.highlights.delete('find-cur'); } }
function runFind() {
  clearFind(); const cnt = $('#fCount');
  if (!find.q) { if (cnt) cnt.textContent = 'Type to search'; return; }
  const ix = textIndex(); const hay = find.caseSensitive ? ix.s : ix.s.toLowerCase(), needle = find.caseSensitive ? find.q : find.q.toLowerCase();
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + Math.max(1, needle.length))) find.matches.push(rangeFromOffsets(i, i + needle.length, ix));
  if (window.CSS && CSS.highlights && window.Highlight) CSS.highlights.set('find', new Highlight(...find.matches));
  find.cur = find.matches.length ? Math.max(0, Math.min(find.cur, find.matches.length - 1)) : -1;
  showCur(false);
}
function showCur(sel) {
  const cnt = $('#fCount'); if (!cnt) return;
  cnt.textContent = find.matches.length ? `${find.cur + 1} of ${find.matches.length} results` : 'No results';
  const r = find.matches[find.cur]; if (!r) return;
  if (window.CSS && CSS.highlights && window.Highlight) CSS.highlights.set('find-cur', new Highlight(r));
  const el = r.startContainer.parentElement; if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  if (sel) selectRange(r.cloneRange());
}
function stepFind(d) { if (!find.matches.length) return; find.cur = (find.cur + d + find.matches.length) % find.matches.length; showCur(true); }
function replaceOne() {
  const r = find.matches[find.cur]; if (!r) return;
  if (!P().edit) { toast('Editing is turned off in this mode.'); return; }
  if (state.track) { const v = $('#fR').value; if (v) { selectRange(r.cloneRange()); tcInsertText(v); } else tcDeleteRange(r, 'back'); commit(); runFind(); return; }
  r.deleteContents(); r.insertNode(document.createTextNode($('#fR').value)); doc.normalize(); commit(); runFind();
}
function replaceAll() {
  if (!find.matches.length) return; const n = find.matches.length, val = $('#fR').value;
  if (!P().edit) { toast('Editing is turned off in this mode.'); return; }
  if (state.track) { [...find.matches].reverse().forEach(r => { selectRange(r.cloneRange()); if (val) tcInsertText(val); else tcDeleteRange(r, 'back'); }); commit(); runFind(); toast(`Suggested ${n} ${n === 1 ? 'replacement' : 'replacements'}.`); return; }
  [...find.matches].reverse().forEach(r => { r.deleteContents(); r.insertNode(document.createTextNode(val)); });
  doc.normalize(); commit(); runFind(); toast(`Replaced ${n} ${n === 1 ? 'match' : 'matches'}.`);
}
function openFind(replace, q) {
  find.replace = replace; if (q !== undefined) find.q = q;
  else { const r = curRange(); const t = r && r.toString(); if (t && t.length < 80 && !/\n/.test(t)) find.q = t; }
  openSide('find'); setTimeout(() => { const i = $('#fQ'); if (i) { i.focus(); i.select(); } }, 20);
}

/* ---------- tables ---------- */
function tableHTML(rows, cols) {
  const w = Math.floor(contentW() / cols);
  return `<table><colgroup>${('<col style="width:' + w + 'px">').repeat(cols)}</colgroup><tbody>${('<tr>' + '<td><br></td>'.repeat(cols) + '</tr>').repeat(rows)}</tbody></table><p><br></p>`;
}
function curCell() { const r = curRange(); if (!r) return null; const el = r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement; return el && el.closest('td,th'); }
function tableCmd(cmd) {
  const cell = curCell(); if (!cell) return; const tr = cell.parentElement, table = cell.closest('table');
  const idx = [...tr.children].indexOf(cell);
  const blankRow = () => { const nr = document.createElement('tr'); [...tr.children].forEach(c => { const n = document.createElement(c.tagName === 'TH' && cmd !== 'rowAbove' && cmd !== 'rowBelow' ? 'th' : 'td'); if (c.colSpan > 1) n.colSpan = c.colSpan; n.innerHTML = '<br>'; nr.appendChild(n); }); return nr; };
  const rows = [...table.rows];
  const cols = () => { let cg = table.querySelector('colgroup'); return cg; };
  const rescale = () => { const cg = cols(); if (!cg) return; const cs = [...cg.children]; const w = Math.floor(contentW() / cs.length); cs.forEach(c => c.style.width = w + 'px'); };
  if (cmd === 'rowAbove' || cmd === 'rowBelow') { const nr = blankRow(); nr.querySelectorAll('th').forEach(t => { const d = document.createElement('td'); d.innerHTML = '<br>'; t.replaceWith(d); }); tr.parentNode.insertBefore(nr, cmd === 'rowAbove' ? tr : tr.nextSibling); }
  if (cmd === 'colLeft' || cmd === 'colRight') {
    rows.forEach(row => { const ref = row.children[Math.min(idx, row.children.length - 1)]; const n = document.createElement(ref && ref.tagName === 'TH' ? 'th' : 'td'); n.innerHTML = '<br>'; row.insertBefore(n, cmd === 'colLeft' ? ref : ref ? ref.nextSibling : null); });
    const cg = cols(); if (cg) { const ref = cg.children[idx]; const c = document.createElement('col'); cg.insertBefore(c, cmd === 'colLeft' ? ref : ref ? ref.nextSibling : null); rescale(); }
  }
  if (cmd === 'delRow') { if (rows.length === 1) return tableCmd('delTable'); tr.remove(); }
  if (cmd === 'delCol') {
    if (tr.children.length === 1) return tableCmd('delTable');
    rows.forEach(row => { const c = row.children[idx]; if (c) c.remove(); }); const cg = cols(); if (cg && cg.children[idx]) { cg.children[idx].remove(); rescale(); }
  }
  if (cmd === 'delTable') { const p = document.createElement('p'); p.innerHTML = '<br>'; table.replaceWith(p); const r = document.createRange(); r.setStart(p, 0); r.collapse(true); selectRange(r); }
  if (cmd === 'headerRow') {
    const first = rows[0], isHead = [...first.children].every(c => c.tagName === 'TH');
    [...first.children].forEach(c => { const n = document.createElement(isHead ? 'td' : 'th'); [...c.attributes].forEach(a => n.setAttribute(a.name, a.value)); while (c.firstChild) n.appendChild(c.firstChild); c.replaceWith(n); });
  }
  commit(); updateState();
}
function moveCell(dir) {
  const cell = curCell(); if (!cell) return false;
  const all = [...cell.closest('table').querySelectorAll('td,th')]; let i = all.indexOf(cell) + dir;
  if (i >= all.length) { tableCmd('rowBelow'); return moveCell(1); }
  if (i < 0) return true;
  const r = document.createRange(); r.selectNodeContents(all[i]); selectRange(r); return true;
}

/* ---------- images ---------- */
function readImage(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader(); fr.onerror = () => rej(new Error('Could not read that image.'));
    fr.onload = () => {
      const img = new Image(); img.onload = () => {
        let src = fr.result, w = img.naturalWidth, h = img.naturalHeight;
        if (file.size > 1.5e6 || w > 2000) { const s = Math.min(1, 1800 / w); const cv = document.createElement('canvas'); cv.width = Math.round(w * s); cv.height = Math.round(h * s); cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); src = cv.toDataURL('image/jpeg', 0.85); }
        const dw = Math.min(w, contentW()), dh = Math.round(h * dw / w);
        res({ src, w: Math.round(dw), h: dh });
      }; img.onerror = () => rej(new Error('That file is not an image this editor can read.')); img.src = fr.result;
    }; fr.readAsDataURL(file);
  });
}
async function insertImageFile(file) {
  try { const im = await readImage(file); insertHTML(`<img src="${im.src}" width="${im.w}" height="${im.h}" alt="">`); }
  catch (e) { toast(e.message); }
}
function selImg() { return doc.querySelector('img.img-sel'); }
function imgCmd(cmd) {
  const img = selImg(); if (!img) return;
  if (cmd === 'imgDelete') { img.remove(); showCtx('picture', false); commit(); return; }
  const m = /^img(\d+)$/.exec(cmd);
  if (m) { const ratio = (+img.getAttribute('height') || img.naturalHeight) / (+img.getAttribute('width') || img.naturalWidth || 1); const w = Math.round(contentW() * m[1] / 100); img.setAttribute('width', w); img.setAttribute('height', Math.round(w * ratio)); }
  else { const b = blockOf(img); if (b) b.style.textAlign = { imgLeft: 'left', imgCenter: 'center', imgRight: 'right' }[cmd]; }
  commit();
}

/* ---------- popovers ---------- */
const pop = $('#pop'); let popFor = null;
function closePop() { pop.hidden = true; popFor = null; }
function showPop(anchor, html, bind) {
  if (popFor === anchor) { closePop(); return; }
  pop.innerHTML = html; pop.hidden = false; popFor = anchor;
  const a = anchor.getBoundingClientRect(), p = pop.getBoundingClientRect();
  let x = Math.min(a.left, window.innerWidth - p.width - 8), y = a.bottom + 4;
  if (y + p.height > window.innerHeight - 8) y = Math.max(8, a.top - p.height - 4);
  pop.style.left = Math.max(8, x) + 'px'; pop.style.top = y + 'px';
  bind && bind(pop);
}
function mix(hex, t, w) { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = n >> 8 & 255, b = n & 255; const m = c => Math.round(w > 0 ? c + (255 - c) * w : c * (1 + w)); return '#' + [m(r), m(g), m(b)].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase(); }
const THEME = ['#FFFFFF', '#000000', '#E8E6E1', '#2F3A45', '#0F6B5C', '#C2571A', '#7A7F87', '#D9A21B', '#2E6FB5', '#5B8C3A'];
const STANDARD = ['#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0'];
const HILITE = ['#FFFF00', '#00FF00', '#00FFFF', '#FF00FF', '#0000FF', '#FF0000', '#000080', '#008080', '#008000', '#800080', '#800000', '#808000', '#808080', '#C0C0C0', '#000000'];
function palette(withTints, colors) {
  const sw = c => `<button data-c="${c}" title="${c}" style="background:${c}"></button>`;
  if (!withTints) return `<div class="pal" style="grid-template-columns:repeat(5,22px)">${colors.map(sw).join('').replace(/18px/g, '22px')}</div>`;
  let h = '<h4>Theme colors</h4><div class="pal">' + THEME.map(sw).join('') + '</div><div class="pal" style="margin-top:6px">';
  [[.8], [.6], [.4], [-.25], [-.5]].forEach(([w]) => { h += THEME.map(c => sw(mix(c, 0, (c === '#FFFFFF' && w > 0) ? -w / 4 : (c === '#000000' && w < 0) ? -w * .9 : w))).join(''); });
  return h + '</div><h4>Standard colors</h4><div class="pal">' + STANDARD.map(sw).join('') + '</div>';
}
function openPop(name, anchor) {
  if (name === 'color') return showPop(anchor, `<button class="item" data-c="auto">Automatic</button>${palette(true)}`, p => p.onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; const c = b.dataset.c === 'auto' ? '#000000' : b.dataset.c; state.fc = c; $('#fcBar').style.background = c; ex('foreColor', c, true); commit(); closePop(); });
  if (name === 'highlight') return showPop(anchor, `${palette(false, HILITE)}<button class="item" data-c="none">No color</button>`, p => p.onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; const c = b.dataset.c === 'none' ? 'transparent' : b.dataset.c; if (c !== 'transparent') { state.hl = c; $('#hlBar').style.background = c; } ex('hiliteColor', c, true); commit(); closePop(); });
  if (name === 'shade') return showPop(anchor, `<button class="item" data-c="none">No color</button>${palette(true)}`, p => p.onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; const cell = curCell(); if (cell) { cell.style.backgroundColor = b.dataset.c === 'none' ? '' : b.dataset.c; if (!cell.getAttribute('style')) cell.removeAttribute('style'); commit(); } closePop(); });
  if (name === 'spacing') {
    const cur = selBlocks()[0]; const lh = cur ? (parseFloat(cur.style.lineHeight) || 1.08) : 1.08;
    return showPop(anchor, [1, 1.08, 1.15, 1.5, 2, 2.5, 3].map(v => `<button class="item${Math.abs(v - lh) < .01 ? ' on' : ''}" data-v="${v}">${v === 1.08 ? '1.08 (default)' : v.toFixed(v % 1 ? 2 : 1).replace(/0$/, '')}</button>`).join('') + '<h4>Paragraph</h4><button class="item" data-sp="before">Add 12 pt before</button><button class="item" data-sp="after">Remove space after</button>',
      p => p.onclick = e => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.v) setBlockCss('lineHeight', b.dataset.v === '1.08' ? '' : b.dataset.v); else if (b.dataset.sp === 'before') setBlockCss('marginTop', '12pt'); else setBlockCss('marginBottom', '0pt'); closePop(); });
  }
  if (name === 'table') {
    let h = '<h4 id="tg-l">Insert table</h4><div class="grid-pick" id="tg">'; for (let r = 0; r < 8; r++) for (let c = 0; c < 10; c++) h += `<i data-r="${r + 1}" data-c="${c + 1}"></i>`;
    return showPop(anchor, h + '</div>', p => {
      const g = p.querySelector('#tg');
      g.onmousemove = e => { const t = e.target.closest('i'); if (!t) return; const R = +t.dataset.r, C = +t.dataset.c; g.querySelectorAll('i').forEach(i => i.classList.toggle('on', +i.dataset.r <= R && +i.dataset.c <= C)); p.querySelector('#tg-l').textContent = `${C} × ${R} table`; };
      g.onclick = e => { const t = e.target.closest('i'); if (!t) return; closePop(); insertHTML(tableHTML(+t.dataset.r, +t.dataset.c)); };
    });
  }
  if (name === 'symbol') {
    const S = ['§', '¶', '©', '®', '™', '°', '±', '×', '÷', '≈', '≠', '≤', '≥', '€', '£', '$', '﷼', '¥', '•', '…', '–', '—', '«', '»', '“', '”', '‘', '’', '√', '∞', '→', '←', '✓', '✗', '★', '☐', '☑', '٪', '،', '؛'];
    return showPop(anchor, '<div class="sym">' + S.map(s => `<button data-s="${s}">${s}</button>`).join('') + '</div>', p => p.onclick = e => { const b = e.target.closest('[data-s]'); if (!b) return; closePop(); insertHTML(b.dataset.s.replace('&', '&amp;')); });
  }
  if (name === 'margins') {
    const M = [['Normal', 2.54, 2.54], ['Narrow', 1.27, 1.27], ['Moderate', 2.54, 1.91], ['Wide', 2.54, 5.08], ['Arabic (Saudi) default', 2.54, 3.17]];
    return showPop(anchor, M.map(([n, tb, lr]) => `<button class="item" data-tb="${tb}" data-lr="${lr}"><b style="min-width:150px;display:inline-block">${n}</b><span style="color:var(--muted)">Top ${tb} cm · Sides ${lr} cm</span></button>`).join(''), p => p.onclick = e => { const b = e.target.closest('[data-tb]'); if (!b) return; const tb = Math.round(b.dataset.tb * 567), lr = Math.round(b.dataset.lr * 567); Object.assign(state.page, { top: tb, bottom: tb, left: lr, right: lr }); closePop(); layout(); commit(); });
  }
  if (name === 'orient') return showPop(anchor, ['portrait', 'landscape'].map(o => `<button class="item${state.page.orient === o ? ' on' : ''}" data-o="${o}">${o[0].toUpperCase() + o.slice(1)}</button>`).join(''), p => p.onclick = e => { const b = e.target.closest('[data-o]'); if (!b) return; const P = state.page; if (P.orient !== b.dataset.o) { [P.w, P.h] = [P.h, P.w]; P.orient = b.dataset.o; } closePop(); layout(); commit(); });
  if (name === 'size') {
    const Z = [['A4', 11906, 16838, '21 × 29.7 cm'], ['Letter', 12240, 15840, '21.59 × 27.94 cm'], ['Legal', 12240, 20160, '21.59 × 35.56 cm'], ['A5', 8391, 11906, '14.8 × 21 cm']];
    return showPop(anchor, Z.map(([n, w, h, d]) => `<button class="item" data-w="${w}" data-h="${h}"><b style="min-width:70px;display:inline-block">${n}</b><span style="color:var(--muted)">${d}</span></button>`).join(''), p => p.onclick = e => { const b = e.target.closest('[data-w]'); if (!b) return; const P = state.page; let w = +b.dataset.w, h = +b.dataset.h; if (P.orient === 'landscape') [w, h] = [h, w]; P.w = w; P.h = h; closePop(); layout(); commit(); });
  }
}
function linkPop(anchor) {
  restore(); const r = curRange(); const el = r && (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement);
  const a = el && el.closest('a');
  showPop(anchor, `<form class="form" id="lf"><label class="field">Address<input id="lUrl" type="text" placeholder="https://" value="${a ? a.getAttribute('href').replace(/"/g, '&quot;') : ''}"></label><label class="field">Text to display<input id="lTxt" type="text"></label><div class="acts">${a ? '<button type="button" class="btn" id="lRm">Remove link</button>' : ''}<button type="submit" class="btn primary">${a ? 'Update' : 'Insert'}</button></div></form>`, p => {
    const txt = p.querySelector('#lTxt'); txt.value = a ? a.textContent : (r ? r.toString() : '');
    setTimeout(() => p.querySelector('#lUrl').focus(), 10);
    const rm = p.querySelector('#lRm'); if (rm) rm.onclick = () => { a.replaceWith(...a.childNodes); closePop(); commit(); };
    p.querySelector('#lf').onsubmit = e => {
      e.preventDefault(); let url = p.querySelector('#lUrl').value.trim(); if (!url) return;
      if (!/^[a-z]+:|^#/i.test(url)) url = 'https://' + url;
      const t = txt.value.trim() || url; closePop();
      if (a) { a.setAttribute('href', url); a.textContent = t; commit(); return; }
      restore(); if (saved) selectRange(saved);
      const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
      insertHTML(`<a href="${esc(url)}">${esc(t)}</a>`);
    };
  });
}

/* ---------- modes & permissions ---------- */
function P() {
  if (MODE === 'view') return { trackView: true };
  if (MODE === 'comment') return { undo: true, comment: true, trackView: true };
  if (MODE === 'review' && state.role === 'approver') return { undo: true, edit: true, comment: true, trackView: true, approve: true, decide: true, trackLocked: true };
  if (MODE === 'review') return { undo: true, edit: true, comment: true, trackView: true, decide: true, withdrawOnly: true, trackLocked: true };
  return { undo: true, edit: true, format: true, insert: true, layout: true, comment: true, trackView: true, trackToggle: true, approve: true, decide: true };
}
function currentAuthor() { return HOSTED ? state.author : MODE === 'review' ? state.roleNames[state.role] : state.author; }
function applyPerms() {
  const p = P();
  $$('[data-need]').forEach(el => { el.hidden = !p[el.dataset.need]; });
  if (MODE === 'review') state.track = true;      // both roles: every edit is a tracked change in the editor's own name
  if (MODE === 'comment' || MODE === 'view') state.track = false;
  doc.contentEditable = (p.edit && state.markup === 'all') ? 'true' : 'false';
  doc.classList.toggle('tc-final', state.markup === 'final');
  doc.classList.toggle('tc-original', state.markup === 'original');
  const badge = $('#modeBadge');
  const label = MODE === 'view' ? 'Read only' : MODE === 'comment' ? 'Commenting' : MODE === 'review' ? (state.role === 'approver' ? 'Reviewing changes' : 'Suggesting') : (state.track ? 'Tracking changes' : '');
  badge.textContent = label; badge.hidden = !label; badge.classList.toggle('warn', MODE === 'review' && state.role === 'approver');
  $('#roles').hidden = MODE !== 'review' || HOSTED;
  $$('#roles [data-role]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.role === state.role)));
  $('#btnTrack').classList.toggle('on', !!state.track);
  $('#btnTrack').disabled = !p.trackToggle;
  $('#trackLbl').innerHTML = p.trackLocked ? 'Tracking<br>is on' : 'Track<br>changes';
  $('#btnTrack').title = p.trackLocked ? 'Your edits are always recorded as suggestions for the approver' : 'Record edits as tracked changes';
  $('#rejectLbl').textContent = p.withdrawOnly ? 'Withdraw' : 'Reject';
  $('#markupView').value = state.markup;
  $('#stMode').textContent = MODE === 'view' ? 'Read only' : MODE === 'comment' ? 'Commenting only' : MODE === 'review' ? (state.role === 'approver' ? 'Approver: decide on changes · your edits are tracked' : 'Initiator: your edits are tracked') : (state.track ? 'Editing · Track changes on' : 'Editing');
  if (!p.format) { showCtx('table', false); showCtx('picture', false); }
  const sel = $('.tab[aria-selected="true"]'); if (sel && sel.hidden) selectTab(MODE === 'full' ? 'home' : 'review');
  if (MODE !== 'full' && state._lastRole !== state.role) { selectTab('review'); state._lastRole = state.role; }
  $('#avatar').textContent = initials(currentAuthor()); $('#avatar').title = currentAuthor();
  tcColors();
  if (state.side === 'changes') renderSide();
}

/* ---------- tracked changes ---------- */
const TC_COLORS = ['#b5179e', '#1d6fd1', '#c2571a', '#2f855a', '#7b3fbf', '#b42318'];
function tcColors() {
  const authors = [...new Set([...doc.querySelectorAll('[data-author]')].map(e => e.dataset.author))];
  const css = authors.map((a, i) => `.doc [data-author="${CSS.escape(a)}"]{--tcc:${TC_COLORS[i % TC_COLORS.length]}}`).join('\n');
  let st = $('#tcColors'); if (!st) { st = document.createElement('style'); st.id = 'tcColors'; document.head.appendChild(st); }
  if (st.textContent !== css) st.textContent = css;
}
const revId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
function mkTc(tag, id) { const e = document.createElement(tag); e.className = 'tc'; e.dataset.tc = id || revId(); e.dataset.author = currentAuthor(); e.dataset.date = nowIso(); return e; }
function closestTc(n, tag) { for (let e = n && (n.nodeType === 1 ? n : n.parentElement); e && e !== doc; e = e.parentElement) if (e.tagName === tag && e.classList.contains('tc')) return e; return null; }
const mine = e => e && e.dataset.author === currentAuthor();
function caret(node, off) { const r = document.createRange(); r.setStart(node, off); r.collapse(true); selectRange(r); }
function splitEl(el, r) {   // split element el at range start; returns the new right-hand clone
  const right = el.cloneNode(false); const tail = document.createRange();
  tail.setStart(r.startContainer, r.startOffset); tail.setEndAfter(el.lastChild || el);
  right.appendChild(tail.extractContents()); el.after(right);
  [el, right].forEach(x => { if (!x.textContent && !x.querySelector('img')) x.remove(); });
  return right;
}
function mergeAdjacent(root) {
  (root || doc).querySelectorAll('ins.tc,del.tc').forEach(el => {
    const prev = el.previousSibling;
    if (prev && prev.nodeType === 1 && prev.tagName === el.tagName && prev.classList.contains('tc') && prev.dataset.author === el.dataset.author && el.isConnected) {
      while (el.firstChild) prev.appendChild(el.firstChild); el.remove(); prev.normalize();
    }
  });
}

function tcInsertText(text) {
  let r = curRange(); if (!r) return;
  if (!r.collapsed) { tcDeleteRange(r, 'back'); r = curRange(); }
  const d = closestTc(r.startContainer, 'DEL');
  if (d) { r = document.createRange(); r.setStartAfter(d); r.collapse(true); }
  const ins = closestTc(r.startContainer, 'INS');
  if (ins && mine(ins) && r.startContainer.nodeType === 3) {
    const tn = r.startContainer, o = r.startOffset; tn.insertData(o, text); caret(tn, o + text.length); return;
  }
  if (ins && !mine(ins)) { const right = splitEl(ins, r); r = document.createRange(); if (right.isConnected) r.setStartBefore(right); else r.setStartAfter(ins.isConnected ? ins : doc.lastChild); r.collapse(true); }
  // extend my insertion right before the caret
  let before = null;
  if (r.startContainer.nodeType === 3 && r.startOffset === 0) before = r.startContainer.previousSibling;
  else if (r.startContainer.nodeType === 1 && r.startOffset > 0) before = r.startContainer.childNodes[r.startOffset - 1];
  if (r.startContainer.nodeType === 3 && r.startOffset > 0 && r.startOffset === r.startContainer.length) before = null;
  if (before && before.nodeType === 1 && before.tagName === 'INS' && before.classList.contains('tc') && mine(before)) {
    let last = before.lastChild; if (!last || last.nodeType !== 3) { last = document.createTextNode(''); before.appendChild(last); }
    last.appendData(text); caret(last, last.length); return;
  }
  // replace a lone <br> placeholder
  const blk = blockOf(r.startContainer);
  if (blk && blk.childNodes.length === 1 && blk.firstChild.nodeName === 'BR') { blk.firstChild.remove(); r = document.createRange(); r.setStart(blk, 0); r.collapse(true); }
  const el = mkTc('ins'); const tn = document.createTextNode(text); el.appendChild(tn);
  r.insertNode(el); caret(tn, tn.length);
}

function leavesIn(r) {
  const ca = r.commonAncestorContainer;
  if (ca.nodeType === 3) return ca.data.length ? [ca] : [];
  const w = document.createTreeWalker(ca, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT); const out = []; let n;
  while ((n = w.nextNode())) {
    if (!r.intersectsNode(n)) continue;
    if (n.nodeType === 3) { if (n.data.length && !(n.parentElement && n.parentElement.matches('tr,tbody,thead,table,ul,ol,colgroup'))) out.push(n); }
    else if (n.tagName === 'IMG') out.push(n);
  }
  return out;
}
function liveText(r) { return leavesIn(r).some(n => !closestTc(n, 'DEL') && (n.nodeType === 1 || (() => { const s = n === r.startContainer ? r.startOffset : 0, e = n === r.endContainer ? r.endOffset : n.data.length; return e > s; })())); }

function tcDeleteRange(r, dir) {
  const sb = blockOf(r.startContainer), eb = blockOf(r.endContainer);
  const opId = revId(); let first = null, last = null;
  const leaves = leavesIn(r).map(n => {
    if (n.nodeType === 1) return n;
    let s = n === r.startContainer ? r.startOffset : 0, e = n === r.endContainer ? r.endOffset : n.data.length;
    if (e <= s) return null;
    if (e < n.data.length) n.splitText(e);
    if (s > 0) n = n.splitText(s);
    return n;
  }).filter(Boolean);
  for (const leaf of leaves) {
    if (closestTc(leaf, 'DEL')) { last = leaf; first = first || leaf; continue; }
    const ins = closestTc(leaf, 'INS');
    if (ins && mine(ins)) {   // removing my own suggestion simply deletes it
      const anchor = document.createTextNode(''); ins.parentNode.insertBefore(anchor, ins.nextSibling);
      leaf.remove(); if (!ins.textContent && !ins.querySelector('img')) ins.remove();
      first = first || anchor; last = anchor; continue;
    }
    const d = mkTc('del', opId); leaf.parentNode.insertBefore(d, leaf); d.appendChild(leaf);
    first = first || d; last = d;
  }
  // paragraph marks between the start and end blocks
  if (sb && eb && sb !== eb) {
    const blocks = []; let cur = sb;
    const all = [...doc.querySelectorAll(BLOCKS)].filter(b => !b.querySelector('p,h1,h2,h3,h4,h5,h6,blockquote,li,table'));
    const i0 = all.indexOf(sb), i1 = all.indexOf(eb);
    for (let i = i0; i < i1 && i >= 0; i++) blocks.push(all[i]);
    blocks.reverse().forEach(b => markParaDeleted(b));
  }
  mergeAdjacent(sb && sb.parentNode ? sb.parentNode : doc);
  const target = dir === 'back' ? first : last;
  if (target && target.isConnected) {
    const nr = document.createRange();
    if (dir === 'back') nr.setStartBefore(target); else nr.setStartAfter(target);
    nr.collapse(true); selectRange(nr);
  } else if (sb && sb.isConnected) { const nr = document.createRange(); nr.selectNodeContents(sb); nr.collapse(dir === 'back'); selectRange(nr); }
  doc.querySelectorAll('ins.tc:empty,del.tc:empty').forEach(e => e.remove());
}
function markParaDeleted(b) {
  if (b.dataset.tcMark === 'ins' && mine(b)) { mergeWithNext(b); return; }
  if (b.dataset.tcMark) return;
  b.dataset.tcMark = 'del'; b.dataset.tc = revId(); b.dataset.author = currentAuthor(); b.dataset.date = nowIso();
}
function nextBlock(b) {
  let n = b.nextElementSibling;
  if (!n && b.tagName === 'LI') { const list = b.parentElement; n = list.nextElementSibling; }
  if (n && (n.tagName === 'UL' || n.tagName === 'OL')) n = n.firstElementChild;
  return n && n.matches('p,h1,h2,h3,h4,h5,h6,blockquote,li') ? n : null;
}
function mergeWithNext(b) {
  const n = nextBlock(b);
  ['tcMark', 'tc', 'author', 'date'].forEach(k => delete b.dataset[k]);
  if (!n) return;
  if (b.lastChild && b.lastChild.nodeName === 'BR' && b.childNodes.length === 1) b.lastChild.remove();
  const nOnlyBr = n.childNodes.length === 1 && n.firstChild.nodeName === 'BR';
  if (!nOnlyBr) while (n.firstChild) b.appendChild(n.firstChild);
  ['tcMark', 'tc', 'author', 'date'].forEach(k => { if (n.dataset[k]) b.dataset[k] = n.dataset[k]; });
  const parent = n.parentElement; n.remove();
  if (parent && (parent.tagName === 'UL' || parent.tagName === 'OL') && !parent.children.length) parent.remove();
  if (!b.childNodes.length) b.innerHTML = '<br>';
}

function tcDelete(dir, unit) {
  const s = getSelection(); if (!s.rangeCount) return;
  if (!s.isCollapsed) { tcDeleteRange(s.getRangeAt(0), dir); return; }
  const start = s.getRangeAt(0).cloneRange();
  for (let i = 0; i < 400; i++) {
    const before = s.getRangeAt(0).toString().length;
    s.modify('extend', dir === 'back' ? 'backward' : 'forward', unit);
    const r = s.getRangeAt(0);
    if (r.collapsed) break;
    if (liveText(r)) break;
    if (blockOf(r.startContainer) !== blockOf(r.endContainer)) break;
    if (r.toString().length === before && i > 0) break;
  }
  const r = s.getRangeAt(0);
  if (r.collapsed) return;
  if (!liveText(r) && blockOf(r.startContainer) !== blockOf(r.endContainer)) {
    const earlier = blockOf(r.startContainer);
    if (earlier) markParaDeleted(earlier);
    selectRange(start); return;
  }
  tcDeleteRange(r, dir);
}

function tcSplit() {
  let r = curRange(); if (!r) return;
  if (!r.collapsed) { tcDeleteRange(r, 'forward'); r = curRange(); }
  const b = blockOf(r.startContainer); if (!b || b.matches('td,th')) { tcInsertText(' '); return; }
  const d = closestTc(r.startContainer, 'DEL'); if (d) { r = document.createRange(); r.setStartAfter(d); r.collapse(true); }
  const nb = b.cloneNode(false); ['tcMark', 'tc', 'author', 'date'].forEach(k => delete nb.dataset[k]); nb.removeAttribute('id');
  const tail = document.createRange(); tail.setStart(r.startContainer, r.startOffset); tail.setEnd(b, b.childNodes.length);
  nb.appendChild(tail.extractContents());
  ['tcMark', 'tc', 'author', 'date'].forEach(k => { if (b.dataset[k]) { nb.dataset[k] = b.dataset[k]; delete b.dataset[k]; } });
  b.dataset.tcMark = 'ins'; b.dataset.tc = revId(); b.dataset.author = currentAuthor(); b.dataset.date = nowIso();
  b.after(nb);
  [b, nb].forEach(x => { x.querySelectorAll('ins.tc:empty,del.tc:empty').forEach(e => e.remove()); if (!x.textContent && !x.querySelector('img,br')) x.innerHTML = '<br>'; });
  const nr = document.createRange(); nr.setStart(nb, 0); nr.collapse(true); selectRange(nr);
}

/* change groups, accept / reject */
function changeGroups() {
  const map = new Map();
  doc.querySelectorAll('ins.tc,del.tc,[data-tc-mark]').forEach(el => {
    const id = el.dataset.tc; if (!id) return;
    if (!map.has(id)) map.set(id, { id, els: [], author: el.dataset.author || 'Unknown', date: el.dataset.date || '', kind: el.dataset.tcMark ? 'mark-' + el.dataset.tcMark : el.tagName === 'INS' ? 'ins' : 'del' });
    map.get(id).els.push(el);
  });
  return [...map.values()];
}
function decide(id, accept) {
  const g = changeGroups().find(x => x.id === id); if (!g) return;
  g.els.forEach(el => {
    if (!el.isConnected) return;
    if (el.dataset.tcMark) {
      const del = el.dataset.tcMark === 'del';
      if (accept === del) mergeWithNext(el); else ['tcMark', 'tc', 'author', 'date'].forEach(k => delete el.dataset[k]);
    } else {
      const keep = (el.tagName === 'INS') === accept;
      if (keep) el.replaceWith(...el.childNodes); else el.remove();
    }
  });
  doc.normalize();
}
function canDecide(g) { const p = P(); return p.approve || (p.withdrawOnly && g && g.author === currentAuthor()); }
function decideCurrent(accept) {
  const g = activeChange();
  if (!g) { toast('Click a tracked change first.'); return; }
  if (!canDecide(g) || (accept && !P().approve)) { toast('Only the approver can decide on this change.'); return; }
  const list = changeGroups(); const i = list.findIndex(x => x.id === g.id);
  decide(g.id, accept); commit(); afterDecide(list, i);
}
function afterDecide(list, i) {
  const rest = changeGroups(); state.activeTc = rest.length ? rest[Math.min(i, rest.length - 1)].id : null;
  highlightChange(state.activeTc, true); renderSide(); tcColors();
}
function decideAll(accept) {
  const gs = changeGroups(); if (!gs.length) { toast('There are no tracked changes.'); return; }
  gs.forEach(g => decide(g.id, accept)); commit(); state.activeTc = null; renderSide();
  toast(`${accept ? 'Accepted' : 'Rejected'} ${gs.length} ${gs.length === 1 ? 'change' : 'changes'}.`);
}
function activeChange() {
  if (state.activeTc) { const g = changeGroups().find(x => x.id === state.activeTc); if (g) return g; }
  const r = curRange(); if (!r) return null;
  const el = (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement);
  const t = el && (el.closest('ins.tc,del.tc') || el.closest('[data-tc-mark]'));
  return t ? changeGroups().find(x => x.id === t.dataset.tc) : null;
}
function highlightChange(id, scroll) {
  doc.querySelectorAll('.tc-on').forEach(e => e.classList.remove('tc-on'));
  state.activeTc = id || null;
  if (!id) return;
  const els = doc.querySelectorAll(`[data-tc="${CSS.escape(id)}"]`);
  els.forEach(e => e.classList.add('tc-on'));
  if (scroll && els[0]) els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  $$('.card[data-tc]').forEach(c => c.classList.toggle('on', c.dataset.tc === id));
}
function stepChange(dir) {
  const list = changeGroups(); if (!list.length) { toast('There are no tracked changes.'); return; }
  if (state.side !== 'changes') openSide('changes');
  let i = list.findIndex(x => x.id === state.activeTc); i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  highlightChange(list[i].id, true);
  const card = $(`.card[data-tc="${CSS.escape(list[i].id)}"]`); if (card) card.scrollIntoView({ block: 'nearest' });
}
function renderChanges() {
  $('#sideTitle').textContent = 'Tracked changes';
  const body = $('#sideBody'); const list = changeGroups(); const p = P();
  body.innerHTML = '';
  const head = document.createElement('div'); head.className = 'pane-acts';
  head.innerHTML = `<span class="pane-note" style="flex:1;align-self:center">${list.length} ${list.length === 1 ? 'change' : 'changes'}${p.withdrawOnly ? ' · the approver accepts or rejects them' : ''}</span>` + (p.approve && list.length ? '<button class="btn" data-a="acceptAll">Accept all</button><button class="btn" data-a="rejectAll">Reject all</button>' : '');
  head.onclick = e => { const a = e.target.closest('[data-a]'); if (a) decideAll(a.dataset.a === 'acceptAll'); };
  body.appendChild(head);
  if (!list.length) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = p.edit ? 'No tracked changes yet. ' + (state.track ? 'Your edits will appear here.' : 'Turn on Track changes to record edits.') : 'No changes are waiting for review.'; body.appendChild(e); return; }
  const kinds = { ins: ['Inserted', 'ins'], del: ['Deleted', 'del'], 'mark-ins': ['New paragraph', 'ins'], 'mark-del': ['Joined paragraphs', 'del'] };
  list.forEach(g => {
    const card = document.createElement('div'); card.className = 'card' + (g.id === state.activeTc ? ' on' : ''); card.dataset.tc = g.id;
    card.innerHTML = '<div class="card-h"><span class="avatar"></span><div><b></b><time></time></div></div><div class="kind"></div><div class="excerpt" dir="auto"></div>';
    card.querySelector('.avatar').textContent = initials(g.author); card.querySelector('b').textContent = g.author; card.querySelector('time').textContent = when(g.date);
    const [label, cls] = kinds[g.kind]; const k = card.querySelector('.kind'); k.textContent = label; k.classList.add(cls);
    const ex = card.querySelector('.excerpt');
    if (g.kind.startsWith('mark')) ex.textContent = '¶ ' + (g.els[0].textContent.trim().slice(-60) || '(empty paragraph)');
    else { const t = document.createElement(g.kind === 'ins' ? 'ins' : 'del'); t.textContent = g.els.map(e => e.textContent).join('').slice(0, 160) || (g.els[0].querySelector('img') ? '[picture]' : ''); ex.appendChild(t); }
    const acts = document.createElement('div'); acts.className = 'acts';
    if (p.approve) acts.innerHTML = '<button class="btn" data-a="reject">Reject</button><button class="btn primary" data-a="accept">Accept</button>';
    else if (canDecide(g)) acts.innerHTML = '<button class="btn" data-a="reject">Withdraw</button>';
    if (acts.innerHTML) card.appendChild(acts);
    card.addEventListener('click', e => {
      const a = e.target.closest('[data-a]');
      if (a) { e.stopPropagation(); const all = changeGroups(); const i = all.findIndex(x => x.id === g.id); decide(g.id, a.dataset.a === 'accept'); commit(); afterDecide(all, i); return; }
      highlightChange(g.id, true);
    });
    body.appendChild(card);
  });
}

/* tracked typing, deleting, splitting */
doc.addEventListener('beforeinput', e => {
  if (!state.track || e.inputType === 'historyUndo' || e.inputType === 'historyRedo') return;
  const t = e.inputType;
  // IME composition is left to the browser. Safari (macOS/iOS) uses deleteCompositionText/insertFromComposition
  // instead of Chrome's insertCompositionText; handling those as edits would delete the user's characters.
  if (e.isComposing || t === 'insertCompositionText' || t === 'deleteCompositionText' || t === 'insertFromComposition') return;
  e.preventDefault();
  if (t === 'insertText' || t === 'insertReplacementText') { const txt = e.data || (e.dataTransfer && e.dataTransfer.getData('text/plain')) || ''; if (txt) tcInsertText(txt); commitSoon(); }
  else if (t === 'insertParagraph') { tcSplit(); commit(); }
  else if (t === 'insertLineBreak') { tcSplit(); commit(); }
  else if (t.startsWith('delete')) {
    const back = /Backward/.test(t) || t === 'deleteByCut' || t === 'deleteContent';
    const unit = /Word/.test(t) ? 'word' : /Line/.test(t) ? 'lineboundary' : 'character';
    if (t === 'deleteByCut' || t === 'deleteByDrag' || t === 'deleteContent') { const r = curRange(); if (r && !r.collapsed) tcDeleteRange(r, 'back'); }
    else tcDelete(back ? 'back' : 'forward', unit);
    commitSoon();
  }
  else if (t.startsWith('format')) toast('Formatting is not tracked here. Ask the approver, or add a comment.');
  else if (t === 'insertFromPaste' || t === 'insertFromDrop') { const txt = e.dataTransfer && e.dataTransfer.getData('text/plain'); if (txt) { tcInsertText(txt.replace(/\r?\n+/g, ' ')); commit(); } }
  tcColors(); schedLayout(); if (state.side === 'changes') { clearTimeout(state._rc); state._rc = setTimeout(renderSide, 250); }
}, true);
doc.addEventListener('compositionend', () => { if (state.track) toast('Text typed with an input method is not tracked. Use the regular keyboard for suggestions.', 4000); });

/* ---------- command dispatch ---------- */
const CMDS = {
  undo, redo,
  selectAll: () => { restore(); const r = document.createRange(); r.selectNodeContents(doc); selectRange(r); },
  painter: () => state.painter ? (state.painter = null, document.body.classList.remove('painter'), $('[data-cmd="painter"]').classList.remove('on')) : capturePainter(),
  grow: () => stepSize(1), shrink: () => stepSize(-1),
  bold: () => { ex('bold'); commit(); }, italic: () => { ex('italic'); commit(); }, underline: () => { ex('underline'); commit(); },
  strikeThrough: () => { ex('strikeThrough'); commit(); }, subscript: () => { ex('subscript'); commit(); }, superscript: () => { ex('superscript'); commit(); },
  foreColor: () => { ex('foreColor', state.fc, true); commit(); }, highlight: () => { ex('hiliteColor', state.hl, true); commit(); },
  clearFormat,
  insertUnorderedList: () => { ex('insertUnorderedList'); commit(); }, insertOrderedList: () => { ex('insertOrderedList'); commit(); },
  indent: () => indentBlocks(1), outdent: () => indentBlocks(-1),
  ltr: () => setDir('ltr'), rtl: () => setDir('rtl'),
  justifyLeft: () => { ex('justifyLeft', null, true); commit(); }, justifyCenter: () => { ex('justifyCenter', null, true); commit(); },
  justifyRight: () => { ex('justifyRight', null, true); commit(); }, justifyFull: () => { ex('justifyFull', null, true); commit(); },
  marks: () => { state.marks = !state.marks; document.body.classList.toggle('marks', state.marks); $$('[data-cmd="marks"]').forEach(b => b.classList.toggle('on', state.marks)); },
  find: () => openFind(false), replace: () => openFind(true),
  pagebreak: () => insertHTML('<hr class="page-break"><p><br></p>'),
  hr: () => insertHTML('<hr><p><br></p>'),
  picture: () => { restore(); $('#fileImg').click(); },
  link: () => linkPop($('[data-cmd="link"]')),
  comment: newComment,
  date: () => insertHTML(new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })),
  docdir: () => { const rtl = doc.getAttribute('dir') !== 'rtl'; if (rtl) doc.setAttribute('dir', 'rtl'); else doc.removeAttribute('dir'); commit(); updateState(); toast(rtl ? 'Document direction: right-to-left.' : 'Document direction: left-to-right.'); },
  spell: () => { state.spell = !state.spell; doc.spellcheck = state.spell; $('[data-cmd="spell"]').classList.toggle('on', state.spell); toast(state.spell ? 'Spell check is on. Misspelled words are underlined by your browser.' : 'Spell check is off.'); },
  wordcount: () => { const s = textIndex().s; const words = (s.match(/[^\s​]+/g) || []).length; const paras = units().filter(u => u.textContent.trim()).length; toast(`${words.toLocaleString()} words · ${s.replace(/\s/g, '').length.toLocaleString()} characters · ${paras} paragraphs · ${state.pageCount} pages`, 5000); },
  prevComment: () => stepComment(-1), nextComment: () => stepComment(1),
  deleteComment: () => { if (state.activeCid) removeComment(state.activeCid); else toast('Click a comment first.'); },
  toggleComments: () => state.side === 'comments' ? closeSide() : openSide('comments'),
  trackToggle: () => { if (!P().trackToggle) return; state.track = !state.track; applyPerms(); toast(state.track ? 'Track changes is on. Your edits are recorded as suggestions.' : 'Track changes is off.'); },
  changesPane: () => state.side === 'changes' ? closeSide() : openSide('changes'),
  acceptChange: () => decideCurrent(true), rejectChange: () => decideCurrent(false),
  prevChange: () => stepChange(-1), nextChange: () => stepChange(1),
  acceptAll: () => { if (P().approve) decideAll(true); }, rejectAll: () => { if (P().approve) decideAll(false); },
  zoom100: () => setZoom(1), fitWidth: () => setZoom(0, 'width'), fitPage: () => setZoom(0, 'page'),
  ruler: () => { state.ruler = !state.ruler; $('[data-cmd="ruler"]').classList.toggle('on', state.ruler); drawRuler(); },
  theme: () => { const r = document.documentElement; const dark = r.dataset.theme ? r.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; r.dataset.theme = dark ? 'light' : 'dark'; drawRuler(); },
  rowAbove: () => tableCmd('rowAbove'), rowBelow: () => tableCmd('rowBelow'), colLeft: () => tableCmd('colLeft'), colRight: () => tableCmd('colRight'),
  delRow: () => tableCmd('delRow'), delCol: () => tableCmd('delCol'), delTable: () => tableCmd('delTable'), headerRow: () => tableCmd('headerRow'),
  img25: () => imgCmd('img25'), img50: () => imgCmd('img50'), img75: () => imgCmd('img75'), img100: () => imgCmd('img100'),
  imgLeft: () => imgCmd('imgLeft'), imgCenter: () => imgCmd('imgCenter'), imgRight: () => imgCmd('imgRight'), imgDelete: () => imgCmd('imgDelete')
};
$('#ribbon').addEventListener('mousedown', e => { if (e.target.closest('button')) e.preventDefault(); });
$('#ribbon').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || b.closest('[data-need][hidden]')) return;
  if (b.dataset.cmd && CMDS[b.dataset.cmd]) { closePop(); CMDS[b.dataset.cmd](); }
  else if (b.dataset.pop) { restore(); openPop(b.dataset.pop, b); }
  else if (b.dataset.style) setBlockStyle(b.dataset.style);
  updateState();
});
$('#fontName').onchange = e => { ex('fontName', e.target.value, false); commit(); doc.focus(); };
$('#fontSize').onchange = e => { setFontSize(e.target.value); doc.focus(); };
[['#spB', 'marginTop', 'pt', 1], ['#spA', 'marginBottom', 'pt', 1], ['#indL', 'marginInlineStart', 'cm', 1], ['#indF', 'textIndent', 'cm', 1]].forEach(([id, prop, unit]) => {
  $(id).onchange = e => { const v = parseFloat(e.target.value); setBlockCss(prop, isNaN(v) ? '' : v + unit); };
});
$$('.tab[data-tab]').forEach(t => t.onclick = () => selectTab(t.dataset.tab));
$('#markupView').onchange = e => { state.markup = e.target.value; applyPerms(); schedLayout(); };
$$('#roles [data-role]').forEach(b => b.onclick = () => { state.role = b.dataset.role; state.activeTc = null; applyPerms(); renderSide(); toast(state.role === 'approver' ? `Acting as ${currentAuthor()}: accept or reject each change. Your own edits are tracked under your name.` : `Acting as ${currentAuthor()}: your edits are recorded as suggestions.`); });
document.addEventListener('mousedown', e => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-pop],[data-cmd="link"]')) closePop(); });

/* ---------- document events ---------- */
document.addEventListener('selectionchange', () => {
  const s = getSelection(); if (!s.rangeCount || !inDoc(s.anchorNode)) return;
  saved = s.getRangeAt(0).cloneRange();
  clearTimeout(state._st); state._st = setTimeout(() => { updateState(); updateStatus(); }, 40);
});
doc.addEventListener('input', () => { if (doc.querySelector('font[size="7"]')) normalizeFonts(); if (!doc.firstElementChild) doc.innerHTML = '<p><br></p>'; commitSoon(); schedLayout(); });
doc.addEventListener('beforeinput', e => { if (e.inputType === 'historyUndo') { e.preventDefault(); undo(); } else if (e.inputType === 'historyRedo') { e.preventDefault(); redo(); } });
doc.addEventListener('mouseup', () => { if (state.painter) setTimeout(applyPainter, 0); });
doc.addEventListener('touchend', () => { if (state.painter) setTimeout(applyPainter, 0); }, { passive: true });
doc.addEventListener('click', e => {
  doc.querySelectorAll('img.img-sel').forEach(i => i.classList.remove('img-sel'));
  if (e.target.tagName === 'IMG') { e.target.classList.add('img-sel'); const r = document.createRange(); r.selectNode(e.target); selectRange(r); }
  const a = e.target.closest('a'); if (a && (e.ctrlKey || e.metaKey)) window.open(a.href, '_blank', 'noopener');
  const c = e.target.closest('.cmt'); if (c) { if (!state.side) openSide('comments'); setActiveComment(c.dataset.cid, false); }
  updateState();
});
pagesEl.addEventListener('mousedown', e => { e.preventDefault(); doc.focus(); const r = document.createRange(); r.selectNodeContents(doc); r.collapse(false); selectRange(r); });
doc.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (e.key === 'Tab') {
    e.preventDefault();
    if (state.track) { const c = curCell(); if (c) moveCell(e.shiftKey ? -1 : 1); return; }
    if (moveCell(e.shiftKey ? -1 : 1)) return;
    if (selBlocks().some(b => b.tagName === 'LI')) { indentBlocks(e.shiftKey ? -1 : 1); return; }
    if (!e.shiftKey) insertHTML('<span class="tab">\t</span>&#8203;');
    return;
  }
  if (e.key === 'Enter' && mod) { e.preventDefault(); if (P().insert && !state.track) CMDS.pagebreak(); return; }
  if (e.key === 'Enter' && !e.shiftKey) commit();
  if (e.key === 'Escape' && state.painter) CMDS.painter();
  if (!mod) { if (e.key === ' ') commitSoon(); return; }
  const map = { z: e.shiftKey ? 'redo' : 'undo', y: 'redo', b: 'bold', i: 'italic', u: 'underline', e: 'justifyCenter', l: 'justifyLeft', r: 'justifyRight', j: 'justifyFull', k: 'link', ']': 'grow', '[': 'shrink', f: 'find', h: 'replace' };
  if (e.altKey && (k === 'm' || e.code === 'KeyM')) { e.preventDefault(); newComment(); return; }
  if (k === '=' || k === '+') { e.preventDefault(); CMDS[e.shiftKey ? 'superscript' : 'subscript'](); return; }
  if (e.shiftKey && (k === '>' || k === '<' || k === '.' || k === ',')) { e.preventDefault(); stepSize(k === '>' || k === '.' ? 1 : -1); return; }
  const c = map[k]; if (c) { e.preventDefault(); const btn = $(`[data-cmd="${c}"]`); if (btn && btn.closest('[data-need][hidden]')) { if (state.track) toast('Formatting is not tracked here. Add a comment instead.'); return; } CMDS[c](); updateState(); }
});
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && k === 's') { e.preventDefault(); saveDocx(); }
  const inField = e.target.closest && e.target.closest('input,textarea,select,[contenteditable="true"]');
  if (!inField && mod && e.altKey && (k === 'm' || e.code === 'KeyM')) { e.preventDefault(); newComment(); }
  if (!inField && mod && (k === 'z' || k === 'y')) { e.preventDefault(); (k === 'y' || e.shiftKey) ? redo() : undo(); }
  if (mod && k === 'o') { e.preventDefault(); $('#fileDocx').click(); }
  if (mod && (k === 'f' || k === 'h') && !inDoc(e.target)) { e.preventDefault(); openFind(k === 'h'); }
  if (e.key === 'Escape') { if (!pop.hidden) closePop(); else if (!$('#backstage').hidden) closeBackstage(); }
});

/* ---------- paste: keep structure, drop Office/web junk ---------- */
const OK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SUB', 'SUP', 'A', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'BR', 'IMG', 'SPAN', 'BLOCKQUOTE', 'HR', 'COLGROUP', 'COL']);
const OK_CSS = ['color', 'background-color', 'font-weight', 'font-style', 'text-decoration', 'font-size', 'font-family', 'text-align'];
function sanitize(html) {
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?o:p>/g, '');
  const t = document.createElement('template'); t.innerHTML = html;
  (function walk(node) {
    [...node.childNodes].forEach(n => {
      if (n.nodeType === 8) { n.remove(); return; }
      if (n.nodeType !== 1) return;
      walk(n);
      if (/^(SCRIPT|STYLE|META|LINK|TITLE|XML)$/.test(n.tagName)) { n.remove(); return; }
      if (n.tagName === 'DIV') { const p = document.createElement('p'); while (n.firstChild) p.appendChild(n.firstChild); n.replaceWith(p); n = p; }
      if (n.tagName === 'B' && /font-weight:\s*normal/.test(n.getAttribute('style') || '')) { n.replaceWith(...n.childNodes); return; }
      if (!OK_TAGS.has(n.tagName)) { n.replaceWith(...n.childNodes); return; }
      if (n.tagName === 'IMG' && !/^data:image\//.test(n.getAttribute('src') || '')) { n.remove(); return; }
      const keep = {}; ['href', 'src', 'width', 'height', 'colspan', 'rowspan', 'dir'].forEach(a => { if (n.hasAttribute(a)) keep[a] = n.getAttribute(a); });
      const st = n.style; const css = OK_CSS.map(p => st.getPropertyValue(p) ? `${p}:${st.getPropertyValue(p)}` : '').filter(Boolean).join(';');
      [...n.attributes].forEach(a => n.removeAttribute(a.name));
      Object.entries(keep).forEach(([k, v]) => { if (k === 'href' && /^\s*javascript:/i.test(v)) return; n.setAttribute(k, v); });
      if (css) n.setAttribute('style', css);
      if (n.tagName === 'SPAN' && !n.attributes.length) n.replaceWith(...n.childNodes);
    });
  })(t.content);
  return t.innerHTML;
}
doc.addEventListener('paste', e => {
  const cd = e.clipboardData; if (!cd) return;
  if (!P().edit) { e.preventDefault(); return; }
  if (state.track) { e.preventDefault(); const t = cd.getData('text/plain'); if (t) { tcInsertText(t.replace(/\r?\n+/g, ' ')); commit(); tcColors(); } return; }
  const img = [...cd.files].find(f => /^image\//.test(f.type));
  if (img) { e.preventDefault(); insertImageFile(img); return; }
  const html = cd.getData('text/html');
  e.preventDefault();
  if (html) insertHTML(sanitize(html));
  else { const t = cd.getData('text/plain'); insertHTML(t.split(/\r?\n/).map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>')); }
});
doc.addEventListener('drop', e => { if (e.dataTransfer && e.dataTransfer.files.length) e.preventDefault(); });

/* ---------- drag & drop files onto the canvas ---------- */
let dragN = 0;
canvas.addEventListener('dragenter', e => { if ([...(e.dataTransfer.types || [])].includes('Files')) { dragN++; $('#dropHint').hidden = false; } });
canvas.addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; $('#dropHint').hidden = true; } });
canvas.addEventListener('dragover', e => { if ([...(e.dataTransfer.types || [])].includes('Files')) e.preventDefault(); });
canvas.addEventListener('drop', e => {
  dragN = 0; $('#dropHint').hidden = true; const f = e.dataTransfer.files[0]; if (!f) return; e.preventDefault();
  if (/\.docx$/i.test(f.name)) openDocx(f);
  else if (/^image\//.test(f.type) && P().insert) { const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null; if (r && inDoc(r.startContainer)) selectRange(r); insertImageFile(f); }
  else toast('Drop a .docx document or an image.');
});

/* ---------- file: open / save / new ---------- */
function loadInto(d) {
  doc.innerHTML = d.html || '<p><br></p>';
  if (d.dir) doc.setAttribute('dir', d.dir); else doc.removeAttribute('dir');
  state.page = Object.assign({ w: 11906, h: 16838, top: 1440, right: 1440, bottom: 1440, left: 1440, orient: 'portrait' }, d.page || {});
  state.comments = d.comments || []; state.activeCid = null;
  if (d.title !== undefined) { state.title = d.title; $('#docname').value = d.title; }
  if (d.author) setAuthor(d.author);
  hist.stack = []; hist.idx = -1;
  applyPerms(); layout(); commit(); renderSide();
  const hasTc = !!doc.querySelector('ins.tc,del.tc,[data-tc-mark]');
  if (!state.side && canvas.clientWidth >= 900) { if (hasTc && MODE !== 'comment') openSide('changes'); else if (state.comments.length) openSide('comments'); }
  canvas.scrollTop = 0;
}
async function openDocx(file) {
  if (!window.JSZip) { toast('The .docx reader did not load. Check your connection and reload.'); return; }
  toast('Opening ' + file.name + '…', 15000);
  try {
    const d = await DocxCore.importDocx(await file.arrayBuffer());
    loadInto({ html: d.html, page: d.page, comments: d.comments, title: file.name.replace(/\.docx$/i, ''), dir: '' });
    closeBackstage(); toast('Opened ' + file.name + '.');
  } catch (e) { console.error(e); toast('Could not open this file. ' + (e.message || 'It may be damaged or not a .docx.'), 6000); }
}
async function buildDocx(type) {
  return DocxCore.exportDocx(doc, { page: state.page, comments: state.comments.filter(c => c.text), title: state.title, author: currentAuthor(), trackRevisions: state.track || MODE === 'review', type });
}
function fileName() { return (state.title || 'Document').replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.docx'; }
async function downloadCopy() {
  commit();
  let blob;
  try { blob = await buildDocx('blob'); } catch (e) { console.error(e); toast('Could not build the .docx: ' + e.message, 6000); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName(); a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
async function saveToHost() {
  commit();
  if (MODE === 'view') return downloadCopy();
  if (state.saving) return;
  let bytes;
  try { bytes = await buildDocx('arraybuffer'); } catch (e) { console.error(e); toast('Could not build the .docx: ' + e.message, 6000); return; }
  state.saving = true; $('#savestate').textContent = 'Saving…';
  toHost({ type: 'ce:save', bytes, name: fileName() }, [bytes]);
}
async function saveDocx() {
  if (HOSTED) return saveToHost();
  commit();
  if (!window.JSZip) { toast('The .docx writer did not load. Check your connection and reload.'); return; }
  const name = (state.title || 'Document').replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.docx';
  let blob;
  try { blob = await DocxCore.exportDocx(doc, { page: state.page, comments: state.comments.filter(c => c.text), title: state.title, author: currentAuthor(), trackRevisions: state.track || MODE === 'review', type: 'blob' }); }
  catch (e) { console.error(e); toast('Could not build the .docx: ' + e.message, 6000); return; }
  let dl = state.downloads;
  if (!dl && window.claude && window.claude.use) { try { dl = state.downloads = await window.claude.use('downloads'); } catch (e) { dl = null; } }
  if (!dl) return downloadCopy();
  try { const r = await dl.save({ filename: name, data: blob }); if (r.status === 'saved') toast('Saved ' + name + '.'); }
  catch (e) { if (e && e.code === 'declined') return; if (e && e.code === 'rate_limited') toast('A save prompt is already open.'); else toast('Saving isn’t available here (' + ((e && e.code) || 'error') + ').', 5000); }
}
$('#fileDocx').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openDocx(f); };
$('#fileImg').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) insertImageFile(f); };
$('#btnSave').onclick = saveDocx;
$('#btnComments').onclick = CMDS.toggleComments;
$('#sideClose').onclick = closeSide;
$('#docname').onchange = e => { state.title = e.target.value.trim() || 'Document'; e.target.value = state.title; changed(); };
$('#docname').onkeydown = e => { if (e.key === 'Enter') { e.target.blur(); doc.focus(); } };
$('#topsearch').onkeydown = e => { if (e.key === 'Enter') { openFind(false, e.target.value); } };
$('#topsearch').oninput = e => { if (state.side === 'find') { find.q = e.target.value; const i = $('#fQ'); if (i) i.value = find.q; runFind(); } };
function setAuthor(a) { state.author = a || 'You'; $('#avatar').textContent = initials(state.author); $('#avatar').title = state.author; }

/* backstage */
function openBackstage(tab) { $('#backstage').hidden = false; bsTab(tab || 'home'); }
function closeBackstage() { $('#backstage').hidden = true; doc.focus({ preventScroll: true }); }
function bsTab(t) {
  $$('.bs-nav [data-bs]').forEach(b => b.classList.toggle('on', b.dataset.bs === t));
  const m = $('#bsMain'); const thumb = n => '<div class="thumb">' + Array.from({ length: n }, (_, i) => `<i style="width:${[80, 95, 60, 90, 70, 85][i % 6]}%"></i>`).join('') + '</div>';
  if (t === 'home') {
    m.innerHTML = `<h2>New &amp; open</h2><div class="tiles">
      <button class="tile" id="bsNew"><div class="thumb"></div><b>Blank document</b><small>A4, 2.54 cm margins</small></button>
      <button class="tile" id="bsNewAr"><div class="thumb" style="align-items:flex-end"><i style="width:70%"></i><i style="width:90%"></i><i style="width:55%"></i></div><b>Blank Arabic document</b><small>Right-to-left, A4</small></button>
      <button class="tile" id="bsOpen">${thumb(6)}<b>Open a .docx</b><small>From your device, or drop it on the page</small></button>
      <button class="tile" id="bsSample">${thumb(5)}<b>Sample agreement</b><small>Bilingual example with a table and comments</small></button></div>`;
    if (MODE !== 'full' || HOSTED) { $('#bsNew').hidden = true; $('#bsNewAr').hidden = true; }
    if (HOSTED) { $('#bsSample').hidden = true; $('#bsOpen').hidden = MODE !== 'full'; $('#bsOpen small').textContent = 'Replaces this document’s content. Save to keep it.'; }
    $('#bsNew').onclick = () => { loadInto({ html: '<p><br></p>', title: 'Document', comments: [], dir: '' }); closeBackstage(); };
    $('#bsNewAr').onclick = () => { loadInto({ html: '<p><br></p>', title: 'مستند', comments: [], dir: 'rtl', page: { left: 1800, right: 1800 } }); closeBackstage(); };
    $('#bsOpen').onclick = () => $('#fileDocx').click();
    $('#bsSample').onclick = () => { loadInto(SAMPLE()); closeBackstage(); };
  } else if (t === 'save') {
    m.innerHTML = `<h2>Save a copy</h2><div class="tiles"><button class="tile" id="bsDocx">${thumb(6)}<b>Word document (.docx)</b><small>Opens in Word, LibreOffice, Google Docs and any WOPI editor</small></button></div>
      <p class="note">Your work is also kept automatically in this browser, so it is still here if you close the tab. It is not shared with anyone else.</p>`;
    $('#bsDocx').onclick = saveDocx;
    if (HOSTED) {
      m.querySelector('h2').textContent = 'Save';
      $('#bsDocx b').textContent = MODE === 'view' ? 'Download a copy (.docx)' : 'Save to the platform (Ctrl+S)';
      $('#bsDocx small').textContent = MODE === 'view' ? 'For reading offline' : 'Stores a new version of this document';
      if (MODE === 'view') $('#bsDocx').onclick = downloadCopy;
      else $('#bsDocx').insertAdjacentHTML('afterend', `<button class="tile" id="bsCopy">${thumb(6)}<b>Download a copy (.docx)</b><small>To your device; the platform version does not change</small></button>`), $('#bsCopy').onclick = downloadCopy;
      m.querySelector('.note').textContent = 'Changes are only stored on the platform when you save.';
    }
  } else {
    const s = textIndex().s, words = (s.match(/[^\s​]+/g) || []).length, P = state.page;
    const sizeName = ({ '11906x16838': 'A4', '12240x15840': 'Letter', '12240x20160': 'Legal', '8391x11906': 'A5' })[[Math.min(P.w, P.h), Math.max(P.w, P.h)].join('x')] || 'Custom';
    m.innerHTML = `<h2>Info</h2><dl class="props">
      <dt><label for="pTitle">Title</label></dt><dd><input id="pTitle" type="text"></dd>
      <dt><label for="pAuthor">Author</label></dt><dd><input id="pAuthor" type="text"></dd>
      <dt>Page</dt><dd>${sizeName}, ${P.orient}, ${(P.w / 567).toFixed(1)} × ${(P.h / 567).toFixed(1)} cm</dd>
      <dt>Margins</dt><dd>Top ${(P.top / 567).toFixed(2)} cm · Bottom ${(P.bottom / 567).toFixed(2)} cm · Left ${(P.left / 567).toFixed(2)} cm · Right ${(P.right / 567).toFixed(2)} cm</dd>
      <dt>Statistics</dt><dd>${state.pageCount} pages · ${words.toLocaleString()} words · ${commentOrder().length} comments</dd></dl>
      <p class="note" style="margin-top:22px">The author name is used for new comments and is written into the saved .docx.</p>`;
    $('#pTitle').value = state.title; $('#pAuthor').value = currentAuthor();
    $('#pTitle').onchange = e => { state.title = e.target.value.trim() || 'Document'; $('#docname').value = state.title; changed(); };
    $('#pAuthor').onchange = e => { const v = e.target.value.trim() || 'You'; if (MODE === 'review') state.roleNames[state.role] = v; else setAuthor(v); changed(); };
  }
}
$('#tabFile').onclick = () => openBackstage();
$('#bsBack').onclick = closeBackstage;
$$('.bs-nav [data-bs]').forEach(b => b.onclick = () => bsTab(b.dataset.bs));

/* zoom controls */
$('#zRange').oninput = e => setZoom(e.target.value / 100);
$('#zIn').onclick = () => setZoom(Math.round(state.zoom * 10 + 1) / 10);
$('#zOut').onclick = () => setZoom(Math.round(state.zoom * 10 - 1) / 10);
canvas.addEventListener('wheel', e => { if (e.ctrlKey) { e.preventDefault(); setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 0.9)); } }, { passive: false });
new ResizeObserver(() => { if (state.fit) layout(); else drawRuler(); }).observe(canvas);

let toastT = 0;
function toast(msg, ms) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms || 2600); }

/* ---------- sample document ---------- */
function SAMPLE() {
  const base = BASE_SAMPLE();
  if (MODE === 'comment') { base.title = 'Services Agreement — comment review (sample)'; return base; }
  if (MODE !== 'review') return base;
  const A = state.roleNames.initiator, D1 = '2026-10-02T09:15:00Z', D2 = '2026-10-02T09:22:00Z', D3 = '2026-10-02T09:40:00Z';
  const tc = (tag, id, d, t) => `<${tag} class="tc" data-tc="${id}" data-author="${A}" data-date="${d}">${t}</${tag}>`;
  let h = base.html
    .replace('invoiced quarterly in advance', 'invoiced ' + tc('del', 'rS1', D1, 'quarterly') + tc('ins', 'rS2', D1, 'monthly') + ' in advance')
    .replace('<b>three (3) years</b>', '<b>' + tc('del', 'rS3', D2, 'three (3)') + tc('ins', 'rS4', D2, 'two (2)') + ' years</b>')
    .replace('<li>Termination does not affect fees already due.</li>', `<li data-tc-mark="ins" data-tc="rS5" data-author="${A}" data-date="${D3}">Termination does not affect fees already due.</li><li>` + tc('ins', 'rS6', D3, 'Either party may terminate for convenience on 180 days’ written notice.') + '</li>')
    .replace('مدينة الرياض', 'مدينة ' + tc('del', 'rS7', D3, 'الرياض') + tc('ins', 'rS8', D3, 'جدة'))
    .replace('<span class="cmt" data-cid="cS2">in Saudi riyals (SAR)</span>', 'in Saudi riyals (SAR)');
  h = h.replace(tc('ins', 'rS2', D1, 'monthly'), `<span class="cmt" data-cid="cR1">${tc('ins', 'rS2', D1, 'monthly')}</span>`);
  return {
    title: 'Services Agreement — change request (sample)', dir: '', html: h,
    comments: [{ id: 'cR1', author: A, date: D1, text: 'Monthly billing matches the client’s budget cycle. Please approve.' }, base.comments[0]]
  };
}
function BASE_SAMPLE() {
  return {
    title: 'Services Agreement (sample)', dir: '',
    comments: [
      { id: 'cS1', author: 'Legal review', date: '2026-10-01T09:12:00Z', text: 'Sample comment. Open your own file from File › Open, or drop a .docx onto the page.' },
      { id: 'cS2', author: 'Finance', date: '2026-10-02T13:40:00Z', text: 'Confirm whether fees are quoted including VAT.' }
    ],
    html: `<p class="title">Master Services Agreement</p>
<p class="subtitle">Sample document — fictional parties, for demonstration only</p>
<p>This Agreement is made on <b>1 October 2026</b> between <b>Al Noor Logistics Company</b> (the “Client”) and <b>Sample Systems LLC</b> (the “Provider”).</p>
<h1>1. Scope of services</h1>
<p style="text-align:justify">The Provider will deliver the document management services described in <span class="cmt" data-cid="cS1">Schedule A</span>, including hosting, support and the onboarding of up to <u>250 named users</u>. Services are delivered from data centres located in the Kingdom of Saudi Arabia.</p>
<ol><li>Platform hosting and daily backups</li><li>Second-line support during business hours (Sunday to Thursday, 08:00–17:00 AST)</li><li>Quarterly service reviews</li></ol>
<h1>2. Fees</h1>
<p>The Client will pay the following fees <span class="cmt" data-cid="cS2">in Saudi riyals (SAR)</span>, invoiced quarterly in advance.</p>
<table><colgroup><col style="width:260px"><col style="width:180px"><col style="width:162px"></colgroup><tbody>
<tr><th><p>Item</p></th><th><p>Billing</p></th><th><p style="text-align:right">Amount (SAR)</p></th></tr>
<tr><td><p>Platform subscription</p></td><td><p>Annual</p></td><td><p style="text-align:right">180,000</p></td></tr>
<tr><td><p>Onboarding and data migration</p></td><td><p>One-time</p></td><td><p style="text-align:right">45,000</p></td></tr>
<tr><td style="background-color:#E8F1EE"><p><b>Total, first year</b></p></td><td style="background-color:#E8F1EE"><p><br></p></td><td style="background-color:#E8F1EE"><p style="text-align:right"><b>225,000</b></p></td></tr>
</tbody></table>
<h1>3. Confidentiality</h1>
<p style="text-align:justify">Each party will keep the other party’s confidential information secret and use it only to perform this Agreement. This obligation survives for <i>five (5) years</i> after termination.</p>
<h1 dir="rtl" style="text-align:right">٤. القانون الواجب التطبيق</h1>
<p dir="rtl" style="text-align:justify">يخضع هذا العقد لأنظمة المملكة العربية السعودية ويُفسَّر وفقًا لها، وتختص المحاكم المختصة في مدينة الرياض بالنظر في أي نزاع ينشأ عنه أو يتعلق به.</p>
<h1>5. Term and termination</h1>
<p style="text-align:justify">This Agreement starts on the date above and continues for an initial term of <b>three (3) years</b>. Either party may terminate it on ninety (90) days’ written notice if the other party commits a material breach that is not remedied within thirty (30) days.</p>
<ul><li>Termination does not affect fees already due.</li><li>On termination the Provider will return or delete Client data within 30 days.</li></ul>
<h1>6. Data protection</h1>
<p style="text-align:justify">The Provider will process personal data only on the Client’s documented instructions and in line with the Personal Data Protection Law. The Provider will notify the Client of any personal data breach without undue delay and in any case within <b>72 hours</b> of becoming aware of it.</p>
<h1>7. Notices</h1>
<p style="text-align:justify">Notices under this Agreement must be in writing and delivered by hand, by courier, or by email to the addresses each party gives the other for that purpose. A notice sent by email is received on the next business day after it is sent.</p>
<h2>Signatures</h2>
<table><colgroup><col style="width:301px"><col style="width:301px"></colgroup><tbody>
<tr><td><p><b>For the Client</b></p><p><br></p><p>Name: ____________________</p><p>Date: ____________________</p></td><td><p><b>For the Provider</b></p><p><br></p><p>Name: ____________________</p><p>Date: ____________________</p></td></tr>
</tbody></table>
<p><br></p>`
  };
}

/* ---------- init ---------- */
try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { }   // Chrome/Firefox; Safari splits the current <p>, and stray <div>s are handled on paste/export
if (/Mac|iPhone|iPad|iPod/.test(navigator.platform + ' ' + navigator.userAgent)) {
  $$('[title*="Ctrl+"],[placeholder*="Ctrl+"]').forEach(el => ['title', 'placeholder'].forEach(a => {
    const v = el.getAttribute(a); if (v) el.setAttribute(a, v.replace('Ctrl+H', '⌘⇧H').replace(/Ctrl\+Alt\+/g, '⌘⌥').replace(/Ctrl\+Shift\+/g, '⌘⇧').replace(/Ctrl\+/g, '⌘'));
  }));
}
let draft = null;
if (!HOSTED) try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { }
const startDoc = HOSTED ? { html: '<p><br></p>', title: QS.get('name') || 'Document', comments: [], dir: '' } : draft && draft.html ? draft : SAMPLE();
if (HOSTED) {
  $('#docname').readOnly = true; state.loading = true;
  window.addEventListener('message', async e => {
    if (e.source !== window.parent || e.origin !== location.origin || !e.data) return;
    const m = e.data;
    if (m.type === 'ce:load') {
      state.loading = true;
      try {
        if (m.author) setAuthor(m.author);
        const d = await DocxCore.importDocx(m.bytes);
        loadInto({ html: d.html, page: d.page, comments: d.comments, title: (m.name || 'Document').replace(/\.docx$/i, ''), dir: '' });
        state.dirty = false; $('#savestate').textContent = 'All changes saved';
        toHost({ type: 'ce:loaded' });
      } catch (err) { console.error(err); toHost({ type: 'ce:error', message: 'Could not open this file. ' + (err.message || 'It may be damaged or not a .docx.') }); }
      finally { state.loading = false; }
    } else if (m.type === 'ce:saved') {
      state.saving = false;
      if (m.ok) { state.dirty = false; toHost({ type: 'ce:dirty', dirty: false }); toast(m.message || 'Saved.'); }
      else toast(m.message || 'Could not save.', 7000);
      $('#savestate').textContent = state.dirty ? 'Unsaved changes' : 'All changes saved';
    }
  });
}
if (canvas.clientWidth < 820) state.fit = 'width';
loadInto(startDoc);
if (draft && draft.author) setAuthor(draft.author);
if (HOSTED) { state.loading = false; toHost({ type: 'ce:ready' }); }
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => layout());
const r0 = document.createRange(); r0.selectNodeContents(doc.firstElementChild || doc); r0.collapse(true); saved = r0;
if (window.claude && window.claude.use) window.claude.use('downloads').then(d => { state.downloads = d; }).catch(() => { });
})();
