/* DocxCore — .docx <-> HTML conversion for the browser editor.
   Needs globals: JSZip, DOMParser, document. */
(function (root) {
  'use strict';
  const NS = {
    w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
    a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
    pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
    rel: 'http://schemas.openxmlformats.org/package/2006/relationships'
  };
  const REL = {
    doc: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
    styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
    numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
    image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    link: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
    comments: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
    settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
    core: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties'
  };
  const ARABIC = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
  const HL = { yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff' };
  const NAMED = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', orange: 'FFA500', gray: '808080', grey: '808080', purple: '800080', navy: '000080', teal: '008080', maroon: '800000' };

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const kids = (el, name) => el ? [...el.childNodes].filter(n => n.nodeType === 1 && (!name || n.localName === name)) : [];
  const kid = (el, name) => kids(el, name)[0] || null;
  const wa = (el, name) => el ? (el.getAttributeNS(NS.w, name) || el.getAttribute('w:' + name)) : null;
  const ra = (el, name) => el ? (el.getAttributeNS(NS.r, name) || el.getAttribute('r:' + name)) : null;
  const on = el => { if (!el) return false; const v = wa(el, 'val'); return !(v === '0' || v === 'false' || v === 'none'); };
  const parseXml = s => new DOMParser().parseFromString(s, 'application/xml');
  const byTag = (el, name) => [...el.getElementsByTagName('*')].filter(n => n.localName === name);

  function b64(bytes) {
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64'));
  }
  function unb64(str) {
    const bin = typeof atob === 'function' ? atob(str) : Buffer.from(str, 'base64').toString('binary');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', webp: 'image/webp' };

  /* ======================= IMPORT ======================= */
  async function importDocx(buf) {
    const zip = await JSZip.loadAsync(buf);
    const read = async p => { const f = zip.file(p); return f ? f.async('string') : null; };
    const docXml = await read('word/document.xml');
    if (!docXml) throw new Error('This file has no word/document.xml, so it is not a Word document.');
    const doc = parseXml(docXml);

    const rels = {};
    const relXml = await read('word/_rels/document.xml.rels');
    if (relXml) kids(parseXml(relXml).documentElement, 'Relationship').forEach(r => { rels[r.getAttribute('Id')] = { target: r.getAttribute('Target'), type: r.getAttribute('Type'), mode: r.getAttribute('TargetMode') }; });

    const styles = {}; let defaults = { font: null, size: null };
    const stXml = await read('word/styles.xml');
    if (stXml) {
      const st = parseXml(stXml);
      kids(st.documentElement, 'style').forEach(s => { const n = kid(s, 'name'); styles[wa(s, 'styleId')] = { name: (n ? wa(n, 'val') : '').toLowerCase(), type: wa(s, 'type'), basedOn: wa(kid(s, 'basedOn'), 'val') }; });
      const rpd = byTag(st.documentElement, 'rPrDefault')[0];
      if (rpd) {
        const rf = byTag(rpd, 'rFonts')[0], sz = byTag(rpd, 'sz')[0];
        if (rf) defaults.font = wa(rf, 'ascii') || wa(rf, 'hAnsi');
        if (sz) defaults.size = +wa(sz, 'val') / 2;
      }
    }

    const numFmt = {};
    const numXml = await read('word/numbering.xml');
    if (numXml) {
      const nd = parseXml(numXml).documentElement, abs = {};
      kids(nd, 'abstractNum').forEach(a => { abs[wa(a, 'abstractNumId')] = {}; kids(a, 'lvl').forEach(l => { abs[wa(a, 'abstractNumId')][wa(l, 'ilvl')] = wa(kid(l, 'numFmt'), 'val'); }); });
      kids(nd, 'num').forEach(n => { numFmt[wa(n, 'numId')] = abs[wa(kid(n, 'abstractNumId'), 'val')] || {}; });
    }

    const comments = [];
    const cmXml = await read('word/comments.xml');
    if (cmXml) kids(parseXml(cmXml).documentElement, 'comment').forEach(c => {
      comments.push({ id: 'c' + wa(c, 'id'), author: wa(c, 'author') || 'Unknown', date: wa(c, 'date') || '', text: kids(c, 'p').map(p => byTag(p, 't').map(t => t.textContent).join('')).join('\n') });
    });

    const media = {};
    for (const id in rels) if (rels[id].type === REL.image) {
      let t = rels[id].target.replace(/^\//, ''); if (!t.startsWith('word/')) t = 'word/' + t;
      const f = zip.file(t); if (!f) continue;
      const ext = t.split('.').pop().toLowerCase();
      media[id] = 'data:' + (MIME[ext] || 'image/png') + ';base64,' + b64(await f.async('uint8array'));
    }

    const ctx = { rels, styles, numFmt, media, open: new Set() };
    const body = kid(doc.documentElement, 'body');
    const html = blocksToHtml(body, ctx);

    const page = { w: 11906, h: 16838, top: 1440, right: 1440, bottom: 1440, left: 1440, orient: 'portrait' };
    const sect = kid(body, 'sectPr');
    if (sect) {
      const sz = kid(sect, 'pgSz'), mar = kid(sect, 'pgMar');
      if (sz) { page.w = +wa(sz, 'w') || page.w; page.h = +wa(sz, 'h') || page.h; page.orient = wa(sz, 'orient') || (page.w > page.h ? 'landscape' : 'portrait'); }
      if (mar) ['top', 'right', 'bottom', 'left'].forEach(k => { const v = +wa(mar, k); if (!isNaN(v) && wa(mar, k) !== null) page[k] = Math.abs(v); });
    }
    let title = '';
    const core = await read('docProps/core.xml');
    if (core) { const t = byTag(parseXml(core).documentElement, 'title')[0]; if (t) title = t.textContent.trim(); }
    return { html, page, comments, defaults, title };
  }

  function styleName(id, ctx) { let s = ctx.styles[id], guard = 0; while (s && guard++ < 5) { if (/^(heading [1-6]|title|subtitle|quote|intense quote)$/.test(s.name)) return s.name; s = ctx.styles[s.basedOn]; } return (ctx.styles[id] || {}).name || ''; }

  function blocksToHtml(container, ctx) {
    let out = '', stack = [];
    const closeTo = n => { while (stack.length > n) out += '</li></' + stack.pop().tag + '>'; };
    const els = [];
    (function collect(el) { kids(el).forEach(c => { if (c.localName === 'sdt') collect(kid(c, 'sdtContent')); else if (c.localName === 'customXml') collect(c); else els.push(c); }); })(container);
    for (const el of els) {
      if (el.localName === 'p') {
        const r = pToHtml(el, ctx);
        if (r.list) {
          const lvl = r.list.ilvl;
          const fmt = (ctx.numFmt[r.list.numId] || {})[lvl] || 'bullet';
          const tag = fmt === 'bullet' ? 'ul' : 'ol';
          if (stack.length > lvl + 1) closeTo(lvl + 1);
          if (stack.length === lvl + 1 && stack[lvl].tag !== tag) closeTo(lvl);
          if (stack.length === lvl + 1) out += '</li><li' + r.attrs + '>' + r.inner;
          else { while (stack.length < lvl + 1) { out += '<' + tag + '><li' + (stack.length === lvl ? r.attrs : '') + '>'; stack.push({ tag }); } out += r.inner; }
          out += r.after;
        } else { closeTo(0); out += r.before + r.html + r.after; }
      } else if (el.localName === 'tbl') { closeTo(0); out += tblToHtml(el, ctx); }
    }
    closeTo(0);
    return out;
  }

  function pToHtml(p, ctx) {
    const pPr = kid(p, 'pPr');
    let tag = 'p', cls = '';
    const css = [];
    let list = null, dir = '', before = '', after = '', mark = '';
    if (pPr) {
      const sn = styleName(wa(kid(pPr, 'pStyle'), 'val'), ctx);
      const m = /^heading ([1-6])$/.exec(sn);
      if (m) tag = 'h' + m[1]; else if (sn === 'title') cls = 'title'; else if (sn === 'subtitle') cls = 'subtitle'; else if (/quote/.test(sn)) tag = 'blockquote';
      const jc = wa(kid(pPr, 'jc'), 'val');
      if (jc) css.push('text-align:' + ({ both: 'justify', distribute: 'justify', start: 'start', end: 'end' }[jc] || jc));
      if (kid(pPr, 'bidi') && on(kid(pPr, 'bidi'))) dir = 'rtl';
      const np = kid(pPr, 'numPr');
      if (np && wa(kid(np, 'numId'), 'val') && wa(kid(np, 'numId'), 'val') !== '0') list = { numId: wa(kid(np, 'numId'), 'val'), ilvl: +(wa(kid(np, 'ilvl'), 'val') || 0) };
      const sp = kid(pPr, 'spacing');
      if (sp) {
        if (wa(sp, 'before') !== null) css.push('margin-top:' + (+wa(sp, 'before') / 20) + 'pt');
        if (wa(sp, 'after') !== null) css.push('margin-bottom:' + (+wa(sp, 'after') / 20) + 'pt');
        if (wa(sp, 'line') && (!wa(sp, 'lineRule') || wa(sp, 'lineRule') === 'auto')) css.push('line-height:' + (+wa(sp, 'line') / 240).toFixed(2));
      }
      const ind = kid(pPr, 'ind');
      if (ind && !list) {
        const l = +(wa(ind, 'start') || wa(ind, 'left') || 0), f = +(wa(ind, 'firstLine') || 0) - +(wa(ind, 'hanging') || 0);
        if (l) css.push('margin-inline-start:' + (l / 20) + 'pt');
        if (f) css.push('text-indent:' + (f / 20) + 'pt');
      }
      if (kid(pPr, 'pageBreakBefore') && on(kid(pPr, 'pageBreakBefore'))) before = PB;
      const prp = kid(pPr, 'rPr'), mk = prp && (kid(prp, 'ins') || kid(prp, 'del'));
      if (mk) mark = ' data-tc-mark="' + mk.localName + '"' + revAttrs(mk);
    }
    const st = { pb: false };
    let inner = runsToHtml(p, ctx, st);
    if (st.pb) after = PB;
    const empty = !inner.replace(/<[^>]+>/g, '').length && !/<img/.test(inner);
    if (empty && st.pb && !list) return { html: '', inner: '', attrs: '', list: null, before, after };
    if (empty) inner = '<br>';
    const attrs = (cls ? ' class="' + cls + '"' : '') + (dir ? ' dir="rtl"' : '') + (css.length ? ' style="' + css.join(';') + '"' : '') + mark;
    return { html: '<' + tag + attrs + '>' + inner + '</' + tag + '>', inner, attrs, list, before, after };
  }
  const PB = '<hr class="page-break">';

  function runsToHtml(el, ctx, st) {
    let out = '';
    for (const c of kids(el)) {
      switch (c.localName) {
        case 'pPr': case 'rPr': case 'bookmarkStart': case 'bookmarkEnd': case 'proofErr': break;
        case 'ins': case 'moveTo': case 'del': case 'moveFrom': {
          const inner = runsToHtml(c, ctx, st);
          if (!inner) break;
          const tag = (c.localName === 'ins' || c.localName === 'moveTo') ? 'ins' : 'del';
          out += '<' + tag + ' class="tc"' + revAttrs(c) + '>' + inner + '</' + tag + '>';
          break;
        }
        case 'commentRangeStart': ctx.open.add('c' + wa(c, 'id')); break;
        case 'commentRangeEnd': ctx.open.delete('c' + wa(c, 'id')); break;
        case 'r': out += wrapCmt(rToHtml(c, ctx, st), ctx); break;
        case 'hyperlink': {
          const rel = ctx.rels[ra(c, 'id')];
          const href = rel ? rel.target : (wa(c, 'anchor') ? '#' + wa(c, 'anchor') : '#');
          out += '<a href="' + esc(href) + '">' + runsToHtml(c, ctx, st) + '</a>'; break;
        }
        case 'sdt': out += runsToHtml(kid(c, 'sdtContent'), ctx, st); break;
        default: out += runsToHtml(c, ctx, st); // ins, smartTag, customXml, fldSimple, moveTo
      }
    }
    return out;
  }
  function revAttrs(c) {
    return ' data-tc="r' + esc(wa(c, 'id') || Math.random().toString(36).slice(2, 8)) + '" data-author="' + esc(wa(c, 'author') || 'Unknown') + '"' + (wa(c, 'date') ? ' data-date="' + esc(wa(c, 'date')) + '"' : '');
  }
  function wrapCmt(h, ctx) { if (!h || !ctx.open.size) return h; let o = h; ctx.open.forEach(id => { o = '<span class="cmt" data-cid="' + id + '">' + o + '</span>'; }); return o; }

  function rToHtml(r, ctx, st) {
    let text = '';
    for (const c of kids(r)) {
      if (c.localName === 't' || c.localName === 'delText') text += esc(c.textContent);
      else if (c.localName === 'tab') text += '<span class="tab">\t</span>';
      else if (c.localName === 'br') { if (wa(c, 'type') === 'page') st.pb = true; else text += '<br>'; }
      else if (c.localName === 'cr') text += '<br>';
      else if (c.localName === 'noBreakHyphen') text += '-';
      else if (c.localName === 'sym') text += '&#x' + (wa(c, 'char') || '25A1').replace(/^F0/i, '') + ';';
      else if (c.localName === 'drawing' || c.localName === 'pict') {
        const blip = byTag(c, 'blip')[0] || byTag(c, 'imagedata')[0];
        const id = blip && (ra(blip, 'embed') || ra(blip, 'id'));
        if (id && ctx.media[id]) {
          const ext = byTag(c, 'extent')[0];
          const w = ext ? Math.round(+ext.getAttribute('cx') / 9525) : 300, h = ext ? Math.round(+ext.getAttribute('cy') / 9525) : 200;
          text += '<img src="' + ctx.media[id] + '" width="' + w + '" height="' + h + '" alt="">';
        }
      }
    }
    if (!text) return '';
    const rPr = kid(r, 'rPr');
    if (!rPr) return text;
    const css = [];
    const rf = kid(rPr, 'rFonts');
    if (rf) { const f = wa(rf, 'ascii') || wa(rf, 'hAnsi') || wa(rf, 'cs'); if (f) css.push("font-family:'" + f.replace(/'/g, '') + "'"); }
    const sz = kid(rPr, 'sz') || kid(rPr, 'szCs');
    if (sz && wa(sz, 'val')) css.push('font-size:' + (+wa(sz, 'val') / 2) + 'pt');
    const col = wa(kid(rPr, 'color'), 'val');
    if (col && col !== 'auto') css.push('color:#' + col);
    const hl = wa(kid(rPr, 'highlight'), 'val'); const shd = wa(kid(rPr, 'shd'), 'fill');
    if (hl && HL[hl]) css.push('background-color:' + HL[hl]); else if (shd && shd !== 'auto') css.push('background-color:#' + shd);
    const va = wa(kid(rPr, 'vertAlign'), 'val');
    let h = text;
    if (css.length) h = '<span style="' + css.join(';') + '">' + h + '</span>';
    if (on(kid(rPr, 'b')) || on(kid(rPr, 'bCs'))) h = '<b>' + h + '</b>';
    if (on(kid(rPr, 'i')) || on(kid(rPr, 'iCs'))) h = '<i>' + h + '</i>';
    const u = kid(rPr, 'u'); if (u && wa(u, 'val') !== 'none' && on(u)) h = '<u>' + h + '</u>';
    if (on(kid(rPr, 'strike')) || on(kid(rPr, 'dstrike'))) h = '<s>' + h + '</s>';
    if (va === 'superscript') h = '<sup>' + h + '</sup>'; else if (va === 'subscript') h = '<sub>' + h + '</sub>';
    return h;
  }

  function tblToHtml(tbl, ctx) {
    const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map(g => Math.round(+wa(g, 'w') / 15));
    const bidi = kid(kid(tbl, 'tblPr'), 'bidiVisual');
    const rows = kids(tbl, 'tr').map(tr => {
      let col = 0; const cells = [];
      kids(tr, 'tc').forEach(tc => {
        const pr = kid(tc, 'tcPr');
        const span = +(wa(kid(pr, 'gridSpan'), 'val') || 1);
        const vm = kid(pr, 'vMerge');
        const vmerge = vm ? (wa(vm, 'val') === 'restart' ? 'restart' : 'cont') : null;
        cells.push({ tc, col, span, vmerge, rowspan: 1, fill: wa(kid(pr, 'shd'), 'fill'), header: !!kid(kid(tr, 'trPr'), 'tblHeader') });
        col += span;
      });
      return cells;
    });
    rows.forEach((cells, ri) => cells.forEach(c => {
      if (c.vmerge !== 'cont') return;
      for (let k = ri - 1; k >= 0; k--) { const up = rows[k].find(x => x.col === c.col); if (up && up.vmerge !== 'cont') { up.rowspan++; break; } }
    }));
    let h = '<table' + (bidi ? ' dir="rtl"' : '') + '>';
    if (grid.length) h += '<colgroup>' + grid.map(w => '<col style="width:' + w + 'px">').join('') + '</colgroup>';
    h += '<tbody>';
    rows.forEach(cells => {
      h += '<tr>';
      cells.forEach(c => {
        if (c.vmerge === 'cont') return;
        const tag = c.header ? 'th' : 'td';
        const attrs = (c.span > 1 ? ' colspan="' + c.span + '"' : '') + (c.rowspan > 1 ? ' rowspan="' + c.rowspan + '"' : '') + (c.fill && c.fill !== 'auto' ? ' style="background-color:#' + c.fill + '"' : '');
        h += '<' + tag + attrs + '>' + (blocksToHtml(c.tc, ctx) || '<p><br></p>') + '</' + tag + '>';
      });
      h += '</tr>';
    });
    return h + '</tbody></table>';
  }

  /* ======================= EXPORT ======================= */
  const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'UL', 'OL', 'LI', 'TABLE', 'HR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'FIGURE']);

  function hex(c) {
    if (!c) return null; c = c.trim().toLowerCase();
    if (c === 'transparent' || c === 'inherit' || c === 'initial') return null;
    let m = /^#([0-9a-f]{3})$/.exec(c); if (m) return m[1].split('').map(x => x + x).join('').toUpperCase();
    m = /^#([0-9a-f]{6})$/.exec(c); if (m) return m[1].toUpperCase();
    m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?\s*\)$/.exec(c);
    if (m) { if (m[4] !== undefined && +m[4] === 0) return null; return [m[1], m[2], m[3]].map(v => (+v).toString(16).padStart(2, '0')).join('').toUpperCase(); }
    return NAMED[c] || null;
  }
  function halfPts(v) {
    if (!v) return null; const m = /^([\d.]+)(pt|px|em|rem)?$/.exec(v.trim()); if (!m) return null;
    const n = +m[1]; const pt = m[2] === 'px' ? n * 0.75 : m[2] === 'em' || m[2] === 'rem' ? n * 11 : n;
    return Math.round(pt * 2);
  }
  const twip = v => { const m = /^(-?[\d.]+)(pt|px|cm|mm|in)?$/.exec((v || '').trim()); if (!m) return 0; const n = +m[1]; return Math.round(m[2] === 'px' ? n * 15 : m[2] === 'cm' ? n * 567 : m[2] === 'mm' ? n * 56.7 : m[2] === 'in' ? n * 1440 : n * 20); };

  async function exportDocx(rootEl, opts) {
    opts = opts || {};
    const page = Object.assign({ w: 11906, h: 16838, top: 1440, right: 1440, bottom: 1440, left: 1440, orient: 'portrait' }, opts.page || {});
    const X = { revId: 1, rels: [], media: [], nums: [], drawId: 1, cidMap: {}, usedC: new Set(), open: [], contentW: page.w - page.left - page.right };
    const relId = (type, target, ext) => { const id = 'rId' + (X.rels.length + 10); X.rels.push({ id, type, target, ext }); return id; };
    X.relId = relId;
    (opts.comments || []).forEach((c, i) => { X.cidMap[c.id] = i; });

    let body = '';
    for (const n of [...rootEl.childNodes]) body += blockXml(n, X, { depth: -1 });
    body += closeAllComments(X, true);
    if (!/<w:p[ >][\s\S]*<\/w:p>$|<w:p\/>$/.test(body)) body += '<w:p/>';
    const rtlDoc = (rootEl.getAttribute('dir') || '') === 'rtl';
    const sect = '<w:sectPr><w:pgSz w:w="' + page.w + '" w:h="' + page.h + '"' + (page.orient === 'landscape' ? ' w:orient="landscape"' : '') + '/><w:pgMar w:top="' + page.top + '" w:right="' + page.right + '" w:bottom="' + page.bottom + '" w:left="' + page.left + '" w:header="708" w:footer="708" w:gutter="0"/>' + (rtlDoc ? '<w:bidi/>' : '') + '</w:sectPr>';
    const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="' + NS.w + '" xmlns:r="' + NS.r + '" xmlns:wp="' + NS.wp + '" xmlns:a="' + NS.a + '" xmlns:pic="' + NS.pic + '"><w:body>' + body + sect + '</w:body></w:document>';

    const zip = new JSZip();
    const usedComments = (opts.comments || []).filter(c => X.usedC.has(c.id));
    const ct = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>',
      '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="webp" ContentType="image/webp"/>',
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
      '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>',
      '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>',
      usedComments.length ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : '',
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'].join('');
    zip.file('[Content_Types].xml', ct);
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="' + NS.rel + '"><Relationship Id="rId1" Type="' + REL.doc + '" Target="word/document.xml"/><Relationship Id="rId2" Type="' + REL.core + '" Target="docProps/core.xml"/></Relationships>');
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    zip.file('docProps/core.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>' + esc(opts.title || '') + '</dc:title><dc:creator>' + esc(opts.author || '') + '</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified></cp:coreProperties>');
    let dr = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="' + NS.rel + '"><Relationship Id="rId1" Type="' + REL.styles + '" Target="styles.xml"/><Relationship Id="rId2" Type="' + REL.numbering + '" Target="numbering.xml"/><Relationship Id="rId3" Type="' + REL.settings + '" Target="settings.xml"/>';
    if (usedComments.length) dr += '<Relationship Id="rId4" Type="' + REL.comments + '" Target="comments.xml"/>';
    X.rels.forEach(r => { dr += '<Relationship Id="' + r.id + '" Type="' + r.type + '" Target="' + esc(r.target) + '"' + (r.ext ? ' TargetMode="External"' : '') + '/>'; });
    zip.file('word/_rels/document.xml.rels', dr + '</Relationships>');
    zip.file('word/document.xml', docXml);
    zip.file('word/styles.xml', stylesXml(opts.defaults || {}));
    zip.file('word/numbering.xml', numberingXml(X.nums));
    zip.file('word/settings.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="' + NS.w + '">' + (opts.trackRevisions ? '<w:trackRevisions/>' : '') + '<w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>');
    X.media.forEach(m => zip.file('word/' + m.name, m.bytes));
    if (usedComments.length) {
      zip.file('word/comments.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="' + NS.w + '">' + usedComments.map(c => {
        const ini = (c.author || '?').split(/\s+/).map(s => s[0]).join('').slice(0, 3);
        return '<w:comment w:id="' + X.cidMap[c.id] + '" w:author="' + esc(c.author || 'Author') + '" w:initials="' + esc(ini) + '"' + (c.date ? ' w:date="' + esc(c.date.replace(/\.\d+Z$/, 'Z')) + '"' : '') + '>' +
          String(c.text || '').split('\n').map(line => '<w:p>' + runXml(line, {}) + '</w:p>').join('') + '</w:comment>';
      }).join('') + '</w:comments>');
    }
    return zip.generateAsync({ type: opts.type || 'uint8array', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', compression: 'DEFLATE' });
  }

  function hasBlockChild(el) { return [...el.children].some(c => BLOCK.has(c.tagName)); }

  function blockXml(n, X, L) {
    if (n.nodeType === 3) { return n.textContent.trim() ? paraXml(null, [n], X, {}) : ''; }
    if (n.nodeType !== 1) return '';
    const t = n.tagName;
    if (t === 'UL' || t === 'OL') return listXml(n, X, L.depth + 1, null);
    if (t === 'TABLE') return tableXml(n, X);
    if (t === 'HR') return n.classList.contains('page-break') ? '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' : '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
    if (t === 'BR') return '<w:p/>';
    if (t === 'SCRIPT' || t === 'STYLE') return '';
    if (BLOCK.has(t) && hasBlockChild(n)) return childrenXml(n, X, L);
    if (BLOCK.has(t)) return paraXml(n, [...n.childNodes], X, {});
    return paraXml(null, [n], X, {});
  }

  function childrenXml(n, X, L) {
    let o = '', buf = [];
    const flush = () => { if (buf.some(x => x.nodeType === 1 || x.textContent.trim())) o += paraXml(n, buf, X, {}); buf = []; };
    [...n.childNodes].forEach(c => { if (c.nodeType === 1 && BLOCK.has(c.tagName)) { flush(); o += blockXml(c, X, L); } else buf.push(c); });
    flush();
    return o;
  }

  function listXml(list, X, depth, numId) {
    const ordered = list.tagName === 'OL';
    if (ordered) { numId = X.nums.length + 3; X.nums.push({ id: numId, start: +(list.getAttribute('start') || 1) }); }
    else numId = 1;
    let o = '';
    [...list.children].forEach(li => {
      if (li.tagName === 'UL' || li.tagName === 'OL') { o += listXml(li, X, depth + 1); return; }
      const inl = [], nested = [];
      [...li.childNodes].forEach(c => { if (c.nodeType === 1 && (c.tagName === 'UL' || c.tagName === 'OL')) nested.push(c); else if (c.nodeType === 1 && BLOCK.has(c.tagName)) { if (inl.length) inl.push(document.createElement('br')); inl.push(...c.childNodes); } else inl.push(c); });
      o += paraXml(li, inl, X, { numId, ilvl: Math.min(depth, 8) });
      nested.forEach(nl => { o += listXml(nl, X, depth + 1); });
    });
    return o;
  }

  function pPrXml(el, opt) {
    let style = '', jc = '', bidi = false, sp = '', ind = '';
    if (el) {
      const t = el.tagName;
      if (/^H[1-6]$/.test(t)) style = 'Heading' + t[1];
      else if (t === 'BLOCKQUOTE') style = 'Quote';
      else if (el.classList && el.classList.contains('title')) style = 'Title';
      else if (el.classList && el.classList.contains('subtitle')) style = 'Subtitle';
      const s = el.style || {};
      const ta = s.textAlign || el.getAttribute('align') || '';
      bidi = isRtl(el);
      jc = { left: 'left', right: 'right', center: 'center', justify: 'both', start: bidi ? 'right' : 'left', end: bidi ? 'left' : 'right' }[ta] || '';
      const mt = s.marginTop, mb = s.marginBottom;
      const lh = s.lineHeight && /^[\d.]+$/.test(s.lineHeight) ? Math.round(+s.lineHeight * 240) : 0;
      if (mt || mb || lh) sp = '<w:spacing' + (mt ? ' w:before="' + twip(mt) + '"' : '') + (mb ? ' w:after="' + twip(mb) + '"' : '') + (lh ? ' w:line="' + lh + '" w:lineRule="auto"' : '') + '/>';
      const ml = s.marginInlineStart || s.marginLeft || (bidi ? s.marginRight : ''), ti = s.textIndent;
      if (!opt.numId && (ml || ti)) { const f = twip(ti); ind = '<w:ind w:start="' + twip(ml) + '"' + (f > 0 ? ' w:firstLine="' + f + '"' : f < 0 ? ' w:hanging="' + (-f) + '"' : '') + '/>'; }
    }
    if (opt.numId && !style) style = 'ListParagraph';
    const parts = (style ? '<w:pStyle w:val="' + style + '"/>' : '') + (opt.numId ? '<w:numPr><w:ilvl w:val="' + opt.ilvl + '"/><w:numId w:val="' + opt.numId + '"/></w:numPr>' : '') + (bidi ? '<w:bidi/>' : '') + sp + ind + (jc ? '<w:jc w:val="' + jc + '"/>' : '') + markXml(el, opt.X);
    return parts ? '<w:pPr>' + parts + '</w:pPr>' : '';
  }
  function markXml(el, X) {
    if (!el || !X || !el.getAttribute || !el.getAttribute('data-tc-mark')) return '';
    const k = el.getAttribute('data-tc-mark') === 'del' ? 'del' : 'ins';
    return '<w:rPr><w:' + k + revXml(el, X) + '/></w:rPr>';
  }
  function isRtl(el) { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const d = e.getAttribute('dir') || (e.style && e.style.direction); if (d) return d === 'rtl'; if (e.classList && e.classList.contains('doc')) break; } return false; }

  function paraXml(el, nodes, X, opt) {
    const runs = { xml: '' };
    const base = el && /^H[1-6]$/.test(el.tagName) ? {} : {};
    if (el && el.closest && el.closest('th')) base.b = true;
    nodes.forEach(n => inlineXml(n, Object.assign({ cids: [] }, base), X, runs));
    return '<w:p>' + pPrXml(el, Object.assign({ X }, opt)) + runs.xml + '</w:p>';
  }

  function syncComments(cids, X) {
    let o = '';
    X.open.filter(id => !cids.includes(id)).forEach(id => { const n = X.cidMap[id]; o += '<w:commentRangeEnd w:id="' + n + '"/><w:r><w:commentReference w:id="' + n + '"/></w:r>'; });
    X.open = X.open.filter(id => cids.includes(id));
    cids.filter(id => !X.open.includes(id) && X.cidMap[id] !== undefined).forEach(id => {
      if (X.usedC.has(id)) return; // already closed earlier; avoid duplicate range
      X.usedC.add(id); X.open.push(id); o += '<w:commentRangeStart w:id="' + X.cidMap[id] + '"/>';
    });
    return o;
  }
  function closeAllComments(X) { return X.open.length ? '<w:p>' + syncComments([], X) + '</w:p>' : ''; }

  function runProps(el, rp) {
    const p = Object.assign({}, rp, { cids: rp.cids.slice() });
    const t = el.tagName, s = el.style || {};
    if (t === 'B' || t === 'STRONG') p.b = true;
    if (t === 'I' || t === 'EM') p.i = true;
    if (t === 'U' || t === 'INS') p.u = true;
    if (t === 'S' || t === 'STRIKE' || t === 'DEL') p.s = true;
    if (t === 'SUP') p.va = 'superscript';
    if (t === 'SUB') p.va = 'subscript';
    if (t === 'FONT') {
      if (el.getAttribute('color')) p.color = hex(el.getAttribute('color')) || p.color;
      if (el.getAttribute('face')) p.font = el.getAttribute('face').split(',')[0].replace(/['"]/g, '').trim();
      const sz = +el.getAttribute('size'); if (sz) p.sz = [0, 16, 20, 24, 28, 36, 48, 72][sz] || p.sz;
    }
    if (s.fontWeight === 'bold' || +s.fontWeight >= 600) p.b = true; else if (s.fontWeight === 'normal' || s.fontWeight === '400') p.b = false;
    if (s.fontStyle === 'italic') p.i = true; else if (s.fontStyle === 'normal') p.i = false;
    const td = (s.textDecoration || '') + ' ' + (s.textDecorationLine || '');
    if (/underline/.test(td)) p.u = true; if (/line-through/.test(td)) p.s = true;
    if (s.color) p.color = hex(s.color) || p.color;
    if (s.backgroundColor) p.bg = hex(s.backgroundColor) || p.bg;
    if (s.fontSize) p.sz = halfPts(s.fontSize) || p.sz;
    if (s.fontFamily) p.font = s.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
    if (s.verticalAlign === 'super') p.va = 'superscript'; else if (s.verticalAlign === 'sub') p.va = 'subscript';
    if (el.classList && el.classList.contains('cmt') && el.dataset.cid) p.cids.push(el.dataset.cid);
    return p;
  }

  function rPrXml(p, text) {
    const rtl = ARABIC.test(text || '');
    let o = '';
    if (p.link) o += '<w:rStyle w:val="Hyperlink"/>';
    if (p.font) o += '<w:rFonts w:ascii="' + esc(p.font) + '" w:hAnsi="' + esc(p.font) + '" w:cs="' + esc(p.font) + '"/>';
    if (p.b) o += '<w:b/><w:bCs/>';
    if (p.i) o += '<w:i/><w:iCs/>';
    if (p.s) o += '<w:strike/>';
    if (p.color) o += '<w:color w:val="' + p.color + '"/>';
    if (p.sz) o += '<w:sz w:val="' + p.sz + '"/><w:szCs w:val="' + p.sz + '"/>';
    if (p.u) o += '<w:u w:val="single"/>';
    if (p.bg) o += '<w:shd w:val="clear" w:color="auto" w:fill="' + p.bg + '"/>';
    if (p.va) o += '<w:vertAlign w:val="' + p.va + '"/>';
    if (rtl) o += '<w:rtl/>';
    return o ? '<w:rPr>' + o + '</w:rPr>' : '';
  }
  function runXml(text, p) {
    if (!text) return '';
    const parts = text.split('\t');
    const tt = p.inDel ? 'w:delText' : 'w:t';
    return '<w:r>' + rPrXml(p, text) + parts.map((s, i) => (i ? '<w:tab/>' : '') + (s ? '<' + tt + ' xml:space="preserve">' + esc(s) + '</' + tt + '>' : '')).join('') + '</w:r>';
  }

  function inlineXml(n, rp, X, runs) {
    if (n.nodeType === 3) {
      const text = n.textContent.replace(/[\r\n]+/g, ' ').replace(/​/g, '');
      if (!text) return;
      runs.xml += syncComments(rp.cids, X) + runXml(text, rp);
      return;
    }
    if (n.nodeType !== 1) return;
    const t = n.tagName;
    if (t === 'BR') { runs.xml += '<w:r><w:br/></w:r>'; return; }
    if (t === 'IMG') { runs.xml += syncComments(rp.cids, X) + imageXml(n, X); return; }
    if (t === 'SCRIPT' || t === 'STYLE' || (n.classList && n.classList.contains('cmt-mark'))) return;
    if (n.classList && n.classList.contains('tab')) { runs.xml += '<w:r>' + rPrXml(rp, '') + '<w:tab/></w:r>'; return; }
    if ((t === 'INS' || t === 'DEL') && n.classList.contains('tc')) {
      const inner = { xml: '' };
      const p2 = Object.assign({}, rp, { cids: rp.cids.slice() });
      if (t === 'DEL') p2.inDel = true;
      [...n.childNodes].forEach(c => inlineXml(c, p2, X, inner));
      if (inner.xml) runs.xml += '<w:' + t.toLowerCase() + revXml(n, X) + '>' + inner.xml + '</w:' + t.toLowerCase() + '>';
      return;
    }
    const p = runProps(n, rp);
    if (t === 'A' && n.getAttribute('href') && !/^#/.test(n.getAttribute('href'))) {
      const id = X.relId(REL.link, n.getAttribute('href'), true);
      const inner = { xml: '' };
      p.link = true; if (!p.color) p.color = '0563C1'; p.u = true;
      [...n.childNodes].forEach(c => inlineXml(c, p, X, inner));
      runs.xml += '<w:hyperlink r:id="' + id + '" w:history="1">' + inner.xml + '</w:hyperlink>';
      return;
    }
    [...n.childNodes].forEach(c => inlineXml(c, p, X, runs));
  }

  function revXml(el, X) {
    const d = el.getAttribute('data-date');
    return ' w:id="' + (X.revId++) + '" w:author="' + esc(el.getAttribute('data-author') || 'Unknown') + '"' + (d ? ' w:date="' + esc(d.replace(/\.\d+Z$/, 'Z')) + '"' : '');
  }

  function imageXml(img, X) {
    const src = img.getAttribute('src') || '';
    const m = /^data:image\/(png|jpe?g|gif|webp);base64,(.*)$/i.exec(src);
    if (!m) return '';
    const ext = m[1].toLowerCase() === 'jpg' ? 'jpeg' : m[1].toLowerCase();
    const name = 'media/image' + (X.media.length + 1) + '.' + ext;
    X.media.push({ name, bytes: unb64(m[2]) });
    const id = X.relId(REL.image, name);
    let w = +img.getAttribute('width') || parseFloat(img.style.width) || img.naturalWidth || 300;
    let h = +img.getAttribute('height') || parseFloat(img.style.height) || img.naturalHeight || Math.round(w * 0.66);
    if (img.style.width && /px$/.test(img.style.width) && !img.style.height && img.naturalWidth) h = Math.round(w * img.naturalHeight / img.naturalWidth);
    const maxW = X.contentW / 15; if (w > maxW) { h = Math.round(h * maxW / w); w = Math.round(maxW); }
    const cx = Math.round(w * 9525), cy = Math.round(h * 9525), did = X.drawId++;
    return '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + did + '" name="Picture ' + did + '"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="' + name.split('/')[1] + '"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + id + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  }

  function tableXml(tbl, X) {
    const trs = [...tbl.querySelectorAll(':scope > tr, :scope > tbody > tr, :scope > thead > tr, :scope > tfoot > tr')];
    const occ = []; const rows = [];
    trs.forEach((tr, ri) => {
      occ[ri] = occ[ri] || [];
      let col = 0; const cells = [];
      [...tr.children].filter(c => c.tagName === 'TD' || c.tagName === 'TH').forEach(td => {
        while (occ[ri][col]) col++;
        const cs = Math.max(1, +td.getAttribute('colspan') || 1), rs = Math.max(1, +td.getAttribute('rowspan') || 1);
        cells.push({ td, col, cs, rs });
        for (let r = 0; r < rs; r++) { occ[ri + r] = occ[ri + r] || []; for (let c = 0; c < cs; c++) occ[ri + r][col + c] = r === 0 ? 'own' : { cont: cells[cells.length - 1], top: r === 0 }; }
        col += cs;
      });
      rows.push(cells);
    });
    const ncol = Math.max(1, ...occ.map(r => r ? r.length : 0));
    let widths = [...tbl.querySelectorAll(':scope > colgroup > col')].map(c => twip(c.style.width || ((c.getAttribute('width') || '') + 'px')));
    if (widths.length !== ncol || widths.some(w => !w)) widths = Array(ncol).fill(Math.floor(X.contentW / ncol));
    const total = widths.reduce((a, b) => a + b, 0); if (total > X.contentW) widths = widths.map(w => Math.floor(w * X.contentW / total));
    const b = s => '<w:' + s + ' w:val="single" w:sz="4" w:space="0" w:color="auto"/>';
    let o = '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>' + (isRtl(tbl) ? '<w:bidiVisual/>' : '') + '<w:tblW w:w="0" w:type="auto"/><w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(b).join('') + '</w:tblBorders><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>';
    o += '<w:tblGrid>' + widths.map(w => '<w:gridCol w:w="' + w + '"/>').join('') + '</w:tblGrid>';
    trs.forEach((tr, ri) => {
      const isHead = tr.parentElement.tagName === 'THEAD' || [...tr.children].every(c => c.tagName === 'TH');
      o += '<w:tr>' + (isHead ? '<w:trPr><w:tblHeader/></w:trPr>' : '');
      const own = rows[ri];
      let col = 0;
      while (col < ncol) {
        const cell = own.find(c => c.col === col);
        const slot = occ[ri][col];
        if (cell) {
          const w = widths.slice(col, col + cell.cs).reduce((a, x) => a + x, 0);
          const fill = hex(cell.td.style.backgroundColor);
          o += '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>' + (cell.cs > 1 ? '<w:gridSpan w:val="' + cell.cs + '"/>' : '') + (cell.rs > 1 ? '<w:vMerge w:val="restart"/>' : '') + (fill ? '<w:shd w:val="clear" w:color="auto" w:fill="' + fill + '"/>' : '') + '</w:tcPr>';
          let inner = '';
          if (hasBlockChild(cell.td)) inner = childrenXml(cell.td, X, { depth: -1 }); else inner = paraXml(cell.td, [...cell.td.childNodes], X, {});
          if (!/<\/w:p>$|<w:p\/>$/.test(inner)) inner += '<w:p/>';
          o += inner + '</w:tc>';
          col += cell.cs;
        } else if (slot && slot.cont) {
          const c = slot.cont, w = widths.slice(col, col + c.cs).reduce((a, x) => a + x, 0);
          o += '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>' + (c.cs > 1 ? '<w:gridSpan w:val="' + c.cs + '"/>' : '') + '<w:vMerge/></w:tcPr><w:p/></w:tc>';
          col += c.cs;
        } else { o += '<w:tc><w:tcPr><w:tcW w:w="' + widths[col] + '" w:type="dxa"/></w:tcPr><w:p/></w:tc>'; col++; }
      }
      o += '</w:tr>';
    });
    return o + '</w:tbl>';
  }

  function stylesXml(d) {
    const font = d.font || 'Calibri', sz = Math.round((d.size || 11) * 2);
    const ps = (id, name, rpr, ppr, extra) => '<w:style w:type="paragraph" w:styleId="' + id + '"><w:name w:val="' + name + '"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>' + (extra || '') + '<w:qFormat/>' + (ppr ? '<w:pPr>' + ppr + '</w:pPr>' : '') + '<w:rPr>' + rpr + '</w:rPr></w:style>';
    const hd = (n, size, color, it) => ps('Heading' + n, 'heading ' + n, '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/>' + (n < 4 ? '<w:b/><w:bCs/>' : '') + (it ? '<w:i/><w:iCs/>' : '') + '<w:color w:val="' + color + '"/><w:sz w:val="' + size + '"/><w:szCs w:val="' + size + '"/>', '<w:keepNext/><w:keepLines/><w:spacing w:before="' + (n === 1 ? 360 : 200) + '" w:after="80"/><w:outlineLvl w:val="' + (n - 1) + '"/>', '<w:uiPriority w:val="9"/>');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="' + NS.w + '">' +
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="' + esc(font) + '" w:eastAsia="' + esc(font) + '" w:hAnsi="' + esc(font) + '" w:cs="Arial"/><w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      hd(1, 32, '1F3864') + hd(2, 26, '2E4A7D') + hd(3, 24, '2E4A7D') + hd(4, 22, '2E4A7D', true) + hd(5, 22, '2E4A7D') + hd(6, 22, '2E4A7D', true) +
      ps('Title', 'Title', '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:kern w:val="28"/><w:sz w:val="56"/><w:szCs w:val="56"/>', '<w:spacing w:after="80" w:line="240" w:lineRule="auto"/><w:contextualSpacing/>') +
      ps('Subtitle', 'Subtitle', '<w:color w:val="595959"/><w:sz w:val="28"/><w:szCs w:val="28"/>', '<w:spacing w:after="160"/>') +
      ps('Quote', 'Quote', '<w:i/><w:iCs/><w:color w:val="404040"/>', '<w:spacing w:before="200" w:after="160"/><w:ind w:left="864" w:right="864"/><w:jc w:val="center"/>') +
      ps('ListParagraph', 'List Paragraph', '', '<w:ind w:left="720"/><w:contextualSpacing/>') +
      '<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>' +
      '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
      '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>' +
      '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>' +
      '</w:styles>';
  }

  function numberingXml(nums) {
    const bullets = ['•', 'o', '▪'], fmts = ['decimal', 'lowerLetter', 'lowerRoman'];
    const lvl = (i, fmt, txt, font) => '<w:lvl w:ilvl="' + i + '"><w:start w:val="1"/><w:numFmt w:val="' + fmt + '"/><w:lvlText w:val="' + txt + '"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="' + (720 * (i + 1)) + '" w:hanging="360"/></w:pPr>' + (font ? '<w:rPr><w:rFonts w:ascii="' + font + '" w:hAnsi="' + font + '" w:hint="default"/></w:rPr>' : '') + '</w:lvl>';
    let o = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="' + NS.w + '">';
    o += '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>';
    for (let i = 0; i < 9; i++) o += lvl(i, 'bullet', bullets[i % 3], i % 3 === 1 ? 'Courier New' : 'Arial');
    o += '</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>';
    for (let i = 0; i < 9; i++) o += lvl(i, fmts[i % 3], '%' + (i + 1) + '.', null);
    o += '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>';
    nums.forEach(n => { o += '<w:num w:numId="' + n.id + '"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="' + (n.start || 1) + '"/></w:lvlOverride></w:num>'; });
    return o + '</w:numbering>';
  }

  root.DocxCore = { importDocx, exportDocx };
})(typeof window !== 'undefined' ? window : globalThis);

