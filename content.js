/* GitHub PR Line Viewed - content script */
(() => {
  'use strict';

  const KEY_PREFIX = 'glv:pr:';
  const OPT_KEY = 'glv:options';
  const PANEL_ID = 'glv-panel';
  const SEL_ID = 'glv-selbtn';
  // 旧表示は /files、新しい Files changed は /changes
  const PR_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/(?:files|changes)/;
  const MAX_PRS = 80;

  let ctx = null;                 // { owner, repo, num, storeKey }
  let sets = new Map();           // path -> Set(lineKey)
  let opts = { hideViewed: false, autoMark: false, collapsed: false, side: 'left' };
  let anchor = null;              // 直前にトグルした行 { path, key, state }
  let saveTimer = null;
  let processTimer = null;
  let observer = null;
  let lastHref = location.href;
  let zeroSince = 0;
  let scrollTimer = null;
  let appliedSel = '';   // 適用済みの選択（同じ選択でボタンを出し直さない）

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---------------- storage ---------------- */

  const get = (key) =>
    new Promise((res) => chrome.storage.local.get(key, (o) => res(o && o[key])));
  const set = (key, val) =>
    new Promise((res) => chrome.storage.local.set({ [key]: val }, res));
  const del = (key) => new Promise((res) => chrome.storage.local.remove(key, res));

  function deserialize(raw) {
    const m = new Map();
    if (raw && raw.lines) {
      for (const path of Object.keys(raw.lines)) m.set(path, new Set(raw.lines[path]));
    }
    return m;
  }

  function serialize() {
    const lines = {};
    for (const [path, s] of sets) if (s.size) lines[path] = Array.from(s);
    return { owner: ctx.owner, repo: ctx.repo, num: ctx.num, lines, updatedAt: Date.now() };
  }

  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (!ctx) return;
      const data = serialize();
      if (!Object.keys(data.lines).length) await del(ctx.storeKey);
      else await set(ctx.storeKey, data);
      pruneOld();
    }, 400);
  }

  function pruneOld() {
    chrome.storage.local.get(null, (all) => {
      const keys = Object.keys(all).filter((k) => k.startsWith(KEY_PREFIX));
      if (keys.length <= MAX_PRS) return;
      keys
        .sort((a, b) => (all[b].updatedAt || 0) - (all[a].updatedAt || 0))
        .slice(MAX_PRS)
        .forEach((k) => chrome.storage.local.remove(k));
    });
  }

  function getSet(path) {
    let s = sets.get(path);
    if (!s) { s = new Set(); sets.set(path, s); }
    return s;
  }

  /* ---------------- diff の走査 ---------------- */

  // GitHub の diff 表示は 2 種類あるので、DOM の違いをここで吸収する。
  //   classic : table.diff-table + td.blob-num
  //   next    : table[data-diff-anchor] + tr.diff-line-row（新しい Files changed）
  // 行の識別子はどちらも同じ形式に正規化するため、表示を切り替えても記録は共通で使える。
  //   D123 = 削除側の 123 行目 / A123 = 追加側の 123 行目 / C12-15 = 変更のない行

  const CLASSIC = {
    clickToggle: true,
    selection: null,
    files: () => $$('div.file.js-file'),
    fileOf: (tr) => tr.closest('div.file.js-file'),
    rows: (fileEl) => $$('table.diff-table tr', fileEl),
    badgeHost: (fileEl) => fileEl.querySelector('.file-info'),
    cellFromTarget: (t) => t.closest('td.blob-num'),

    pathOf(fileEl) {
      const header = fileEl.querySelector('.file-header');
      return fileEl.getAttribute('data-tagsearch-path') || (header && header.dataset.path) || '';
    },

    keysOf(tr) {
      if (tr.classList.contains('js-expandable-line')) return null;
      if (tr.classList.contains('inline-comments')) return null;
      const nums = tr.querySelectorAll('td.blob-num[data-line-number]');
      if (!nums.length) return null;
      let left = null, right = null;
      for (const td of nums) {
        if (td.classList.contains('js-blob-rnum')) { if (!right) right = td; }
        else if (!left) left = td;
      }
      const isCtx = (td) => !!td && td.classList.contains('blob-num-context');
      if (left && right && isCtx(left) && isCtx(right)) {
        return ['C' + left.dataset.lineNumber + '-' + right.dataset.lineNumber];
      }
      const keys = [];
      if (left) keys.push((isCtx(left) ? 'C' : 'D') + left.dataset.lineNumber);
      if (right) keys.push((isCtx(right) ? 'C' : 'A') + right.dataset.lineNumber);
      return keys.length ? keys : null;
    }
  };

  // data-diff-line-key="b:1-l:null-r:1" を D/A/C 形式に正規化する
  function canonicalKey(raw) {
    const m = /l:(\d+|null)-r:(\d+|null)/.exec(raw || '');
    if (!m) return '';
    const L = m[1] === 'null' ? '' : m[1];
    const R = m[2] === 'null' ? '' : m[2];
    return L && R ? 'C' + L + '-' + R : L ? 'D' + L : R ? 'A' + R : '';
  }

  const NEXT = {
    // 行番号のクリック / ドラッグは GitHub のコメント用範囲選択なので奪わない。
    // 代わりに選択された行を読み取って、まとめて確認済みにする ✓ ボタンを出す。
    clickToggle: false,
    files: () => $$('table[data-diff-anchor][role="grid"]'),
    fileOf: (tr) => tr.closest('table[data-diff-anchor]'),
    rows: (fileEl) => $$('tr.diff-line-row', fileEl),
    cellFromTarget: (t) => t.closest('td[data-line-number]:not(.diff-text-cell)'),

    // aria-label は "Diff for: path/to/file.ts" の形
    pathOf(fileEl) {
      const m = /:\s*(.+)$/.exec(fileEl.getAttribute('aria-label') || '');
      if (m && m[1].trim()) return m[1].trim();
      const anchor = fileEl.getAttribute('data-diff-anchor');
      return anchor ? 'anchor:' + anchor : '';
    },

    badgeHost(fileEl) {
      const region = fileEl.closest('[role="region"][aria-labelledby]');
      if (!region) return null;
      return document.getElementById(region.getAttribute('aria-labelledby'));
    },

    keysOf(tr) {
      const keys = [];
      const seen = new Set();
      for (const el of tr.querySelectorAll('[data-diff-line-key]')) {
        const key = canonicalKey(el.getAttribute('data-diff-line-key'));
        if (!key || seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
      }
      return keys.length ? keys : null;
    },

    // GitHub が選択中の行（data-selected="true"）を拾う。
    // 行番号セルと本文セルの両方に付くので、path + key で重複を落とす。
    selection() {
      const out = [];
      const seen = new Set();
      for (const cell of $$('tr.diff-line-row [data-selected="true"]')) {
        const key = canonicalKey(cell.getAttribute('data-diff-line-key'));
        if (!key) continue;
        const tr = cell.closest('tr.diff-line-row');
        const path = tr && tr.dataset.glvPath;
        if (!path) continue;
        const id = path + '\u0000' + key;
        if (seen.has(id)) continue;
        seen.add(id);
        const numCell = cell.matches('.diff-text-cell')
          ? tr.querySelector('td[data-line-number]:not(.diff-text-cell)')
          : cell;
        out.push({ path, key, tr, cell: numCell || cell });
      }
      return out;
    }
  };

  function adapter() {
    if (document.querySelector('tr.diff-line-row')) return NEXT;
    if (document.querySelector('table.diff-table')) return CLASSIC;
    return null;
  }


  function process() {
    if (!ctx) return;
    const ad = adapter();
    if (!ad) { updatePanel(0, 0, 0); hideSelBtn(); return; }
    let total = 0, viewed = 0, files = 0;

    for (const fileEl of ad.files()) {
      const path = ad.pathOf(fileEl);
      if (!path) continue;
      files++;
      const s = getSet(path);
      let fTotal = 0, fViewed = 0;

      for (const tr of ad.rows(fileEl)) {
        if (tr.dataset.glvSkip) continue;
        let raw = tr.dataset.glvKeys;
        if (!raw) {
          const keys = ad.keysOf(tr);
          if (!keys) { tr.dataset.glvSkip = '1'; continue; }
          raw = keys.join(' ');
          tr.dataset.glvKeys = raw;
          tr.dataset.glvPath = path;
        }
        const keys = raw.split(' ');
        const done = keys.filter((k) => s.has(k)).length;
        fTotal += keys.length;
        fViewed += done;
        const isViewed = done === keys.length;
        tr.classList.toggle('glv-viewed', isViewed);
        tr.classList.toggle('glv-hidden', isViewed && opts.hideViewed);
      }

      total += fTotal;
      viewed += fViewed;
      updateBadge(ad, fileEl, fTotal, fViewed);
      fileEl.classList.toggle('glv-file-done', fTotal > 0 && fTotal === fViewed);
    }

    updatePanel(total, viewed, files);
    updateSelBtn();
  }

  function schedule() {
    clearTimeout(processTimer);
    processTimer = setTimeout(process, 80);
  }

  /* ---------------- ファイルヘッダのバッジ ---------------- */

  function updateBadge(ad, fileEl, total, viewed) {
    const host = ad.badgeHost(fileEl);
    let badge = host && host.querySelector('.glv-badge');
    if (!total) { if (badge) badge.remove(); return; }
    if (!host) return;
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'glv-badge';
      badge.innerHTML =
        '<span class="glv-count"></span>' +
        '<button type="button" class="glv-mini" data-glv="all" title="このファイルの全行を確認済みにする">全部</button>' +
        '<button type="button" class="glv-mini" data-glv="none" title="このファイルの記録を解除">解除</button>';
      host.appendChild(badge);
    }
    const count = badge.querySelector('.glv-count');
    const label = viewed + ' / ' + total + ' 行';
    if (count.textContent !== label) count.textContent = label;
    badge.classList.toggle('glv-badge-done', viewed === total);
  }

  /* ---------------- 行の操作 ---------------- */

  function markRow(tr, state) {
    const path = tr.dataset.glvPath;
    const raw = tr.dataset.glvKeys;
    if (!path || !raw) return false;
    const s = getSet(path);
    let changed = false;
    for (const key of raw.split(' ')) {
      if (state) { if (!s.has(key)) { s.add(key); changed = true; } }
      else if (s.delete(key)) changed = true;
    }
    return changed;
  }

  function rowsOfFile(fileEl) {
    return $$('tr[data-glv-keys]', fileEl);
  }

  function toggleRow(tr, withShift) {
    const path = tr.dataset.glvPath;
    const raw = tr.dataset.glvKeys;
    if (!path || !raw) return;

    if (withShift && anchor && anchor.path === path) {
      const ad = adapter();
      const fileEl = ad && ad.fileOf(tr);
      const rows = fileEl ? rowsOfFile(fileEl) : [];
      const from = rows.findIndex((r) => r.dataset.glvKeys === anchor.keys);
      const to = rows.indexOf(tr);
      if (from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        for (let i = a; i <= b; i++) markRow(rows[i], anchor.state);
        saveSoon();
        process();
        return;
      }
    }

    const s = getSet(path);
    const state = !raw.split(' ').every((k) => s.has(k));
    markRow(tr, state);
    anchor = { path, keys: raw, state };
    saveSoon();
    process();
  }

  function setFile(ad, fileEl, state) {
    const path = ad.pathOf(fileEl);
    if (!path) return;
    const s = getSet(path);
    if (state) rowsOfFile(fileEl).forEach((tr) => markRow(tr, true));
    else s.clear();
    anchor = null;
    saveSoon();
    process();
  }

  /* ---------------- イベント ---------------- */

  function onClickCapture(e) {
    if (!ctx) return;
    const target = e.target;
    if (!(target instanceof Element)) return;

    const ad = adapter();
    if (!ad) return;

    const mini = target.closest('.glv-mini');
    if (mini) {
      e.preventDefault();
      e.stopPropagation();
      const fileEl = ad.files().find((f) => ad.badgeHost(f) && ad.badgeHost(f).contains(mini));
      if (fileEl) setFile(ad, fileEl, mini.dataset.glv === 'all');
      return;
    }

    const panelBtn = target.closest('#' + PANEL_ID + ' [data-glv]');
    if (panelBtn) { onPanelAction(panelBtn.dataset.glv, e); return; }

    // 行番号セルのクリックで確認済みをトグル。
    // Alt / Cmd / Ctrl 併用時は GitHub 本来の「行へのリンク」を優先する。
    if (!ad.clickToggle) return;
    const cell = ad.cellFromTarget(target);
    if (!cell) return;
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const tr = cell.closest('tr');
    if (!tr || !tr.dataset.glvKeys) return;
    e.preventDefault();
    e.stopPropagation();
    toggleRow(tr, e.shiftKey);
  }

  function onKeyDown(e) {
    if (!ctx) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'Escape') { hideSelBtn(); return; }
    if (e.key === 'N') { e.preventDefault(); jumpNext(); }
    else if (e.key === 'H') { e.preventDefault(); onPanelAction('hide'); }
  }

  function onScroll() {
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      updateSelBtn();
      if (opts.autoMark) autoMarkPass();
    }, 150);
  }

  // 画面の上端を通過した行を確認済みにする（直近 700px 分だけ。
  // 一気にスクロールした時に読んでいない行まで消えないようにするため）
  function autoMarkPass() {
    const line = 100;
    let changed = false;
    for (const tr of $$('tr[data-glv-keys]:not(.glv-viewed)')) {
      const r = tr.getBoundingClientRect();
      if (!r.height) continue;
      if (r.top > line) break;
      if (r.bottom < line && r.bottom > line - 700) changed = markRow(tr, true) || changed;
    }
    if (changed) { saveSoon(); process(); }
  }

  /* ---------------- 次の未確認行へ ---------------- */

  function jumpNext() {
    const rows = $$('tr[data-glv-keys]:not(.glv-viewed)').filter(
      (tr) => tr.getBoundingClientRect().height > 0
    );
    if (!rows.length) { flashPanel('未確認の行はありません'); return; }
    const target =
      rows.find((tr) => tr.getBoundingClientRect().top > 140) || rows[0];
    const rect = target.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + rect.top - 180, behavior: 'smooth' });
    target.classList.remove('glv-flash');
    void target.offsetWidth;
    target.classList.add('glv-flash');
    setTimeout(() => target.classList.remove('glv-flash'), 1600);
  }

  /* ---------------- 範囲選択 → まとめて確認済み ---------------- */

  function ensureSelBtn() {
    let btn = document.getElementById(SEL_ID);
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.id = SEL_ID;
    btn.className = 'glv-selbtn';
    btn.style.display = 'none';
    btn.innerHTML = '<span class="glv-selbox"></span><span class="glv-sellabel">Viewed</span>';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      applySelection();
    });
    document.body.appendChild(btn);
    return btn;
  }

  function hideSelBtn() {
    const btn = document.getElementById(SEL_ID);
    if (btn) btn.style.display = 'none';
  }

  function selSignature(sel) {
    return sel.map((s) => s.path + ':' + s.key).join(',');
  }

  const CANCEL_RE = /^(cancel|キャンセル)$/i;
  const CLICKABLE = 'button, [role="button"], a, input[type="button"], input[type="reset"]';

  // 何をやったかを DOM 属性に残す（content script と page で world が違うため、
  // 実ページでの切り分けは data-glv-close を読んでもらう）
  function trace(o) {
    try { document.documentElement.dataset.glvClose = JSON.stringify(o); } catch (e) { /* noop */ }
  }

  function isCancel(el) {
    if (!CANCEL_RE.test((el.textContent || '').trim())) return false;
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.width > 0;
  }

  // Viewed を押した直後に開いている空のコメント欄を閉じる。
  // 押すのは文言が Cancel のものだけで、書きかけがある欄には触らない
  // （Cancel で入力が消えるため）。
  function closeEmptyCommentForm(sel) {
    // コメント欄は選択範囲の下に出るとは限らない（上に開くこともある）ので、
    // 上下どちらでも選択範囲から一番近い空のコメント欄を選ぶ。
    const selTop = sel[0].tr.getBoundingClientRect().top;
    const selBottom = sel[sel.length - 1].tr.getBoundingClientRect().bottom;
    const gap = (r) => {
      if (r.bottom < selTop) return selTop - r.bottom;
      if (r.top > selBottom) return r.top - selBottom;
      return 0;
    };

    const all = $$('textarea').map((t) => ({ t, r: t.getBoundingClientRect(), gap: 0 }));
    all.forEach((x) => { x.gap = gap(x.r); });
    const ta = all
      .filter((x) => !x.t.value.trim() && x.r.height > 0 && x.gap < 1200)
      .sort((a, b) => a.gap - b.gap)[0];
    if (!ta) {
      trace({ step: 'no-textarea', selTop: Math.round(selTop), selBottom: Math.round(selBottom),
              textareas: all.map((x) => ({ top: Math.round(x.r.top), h: Math.round(x.r.height),
                                           gap: Math.round(x.gap), len: x.t.value.length })) });
      return false;
    }

    const taTop = ta.r.top;
    const near = (el) => Math.abs(el.getBoundingClientRect().top - taTop) < 800;

    // 1) textarea から親を辿って Cancel を探す
    let box = ta.t.parentElement;
    for (let i = 0; i < 20 && box && box !== document.body; i++, box = box.parentElement) {
      const cancel = $$(CLICKABLE, box).find((b) => isCancel(b) && near(b));
      if (cancel) {
        cancel.click();
        trace({ step: 'clicked-ancestor', level: i, taTop: Math.round(taTop), gap: Math.round(ta.gap),
                tag: cancel.tagName, cls: (cancel.className || '').toString().slice(0, 60) });
        return true;
      }
    }

    // 2) 見つからなければページ全体から、コメント欄の近くにある Cancel を探す
    const global = $$(CLICKABLE).filter((b) => isCancel(b) && near(b));
    if (global.length) {
      global[0].click();
      trace({ step: 'clicked-global', count: global.length, tag: global[0].tagName,
              cls: (global[0].className || '').toString().slice(0, 60) });
      return true;
    }

    // 3) それも無ければ Esc を送る
    ta.t.focus();
    for (const type of ['keydown', 'keyup']) {
      ta.t.dispatchEvent(new KeyboardEvent(type, {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
      }));
    }
    trace({ step: 'esc-fallback', taTop: Math.round(taTop),
            cancelLike: $$(CLICKABLE).filter((b) => CANCEL_RE.test((b.textContent || '').trim()))
              .map((b) => ({ tag: b.tagName, top: Math.round(b.getBoundingClientRect().top),
                             h: Math.round(b.getBoundingClientRect().height) })).slice(0, 5) });
    return true;
  }

  function updateSelBtn() {
    const ad = adapter();
    if (!ad || !ad.selection) { hideSelBtn(); return; }
    const sel = ad.selection();
    if (!sel.length) { appliedSel = ''; hideSelBtn(); return; }
    if (selSignature(sel) === appliedSel) { hideSelBtn(); return; }

    const allViewed = sel.every(({ path, key }) => getSet(path).has(key));
    const btn = ensureSelBtn();
    btn.classList.toggle('glv-selbtn-on', allViewed);
    btn.title = allViewed
      ? '選択した ' + sel.length + ' 行を未確認に戻す'
      : '選択した ' + sel.length + ' 行を確認済みにする';
    btn.setAttribute('aria-pressed', allViewed ? 'true' : 'false');
    btn.style.display = '';

    // 選択範囲の先頭行の、行番号のすぐ左に置く。
    // 削除を含む差分では左端が変更前の行番号になるので、選択されている中では
    // 変更後（右側）の行番号を優先して基準にする。削除側だけを選んだ場合は
    // その行番号の左に出す。
    const firstRow = sel[0].tr;
    const picked = $$('td[data-line-number]:not(.diff-text-cell)[data-selected="true"]', firstRow);
    const anchorCell =
      picked.find((c) => c.getAttribute('data-diff-side') === 'right') ||
      picked[0] ||
      sel[0].cell ||
      firstRow;
    const r = anchorCell.getBoundingClientRect();
    if (!r.height) { hideSelBtn(); return; }
    const rowLeft = firstRow.getBoundingClientRect().left;

    btn.classList.remove('glv-selbtn-compact');
    let w = btn.offsetWidth || 74;
    if (r.left - rowLeft < w + 6) {
      btn.classList.add('glv-selbtn-compact');
      w = btn.offsetWidth || 24;
    }
    const h = btn.offsetHeight || 20;
    btn.style.left = Math.max(2, Math.max(rowLeft, r.left - w - 4)) + 'px';
    btn.style.top = Math.max(4, Math.min(window.innerHeight - h - 4, r.top + (r.height - h) / 2)) + 'px';
  }

  function applySelection() {
    const ad = adapter();
    if (!ad || !ad.selection) return;
    const sel = ad.selection();
    if (!sel.length) return;
    const state = !sel.every(({ path, key }) => getSet(path).has(key));
    for (const { path, key } of sel) {
      const s = getSet(path);
      if (state) s.add(key);
      else s.delete(key);
    }
    anchor = null;
    appliedSel = selSignature(sel);
    closeEmptyCommentForm(sel);
    hideSelBtn();
    saveSoon();
    process();
  }

  /* ---------------- パネル ---------------- */

  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return;
    const el = document.createElement('div');
    el.id = PANEL_ID;
    el.className = 'glv-panel';
    el.innerHTML = [
      '<div class="glv-head" data-glv="min">',
      '  <span class="glv-title">行ごと Viewed</span>',
      '  <span class="glv-head-stat"></span>',
      '  <button type="button" class="glv-side" data-glv="side" title="左右を入れ替える"></button>',
      '  <span class="glv-chevron"></span>',
      '</div>',
      '<div class="glv-body">',
      '  <div class="glv-track"><div class="glv-bar"></div></div>',
      '  <div class="glv-stat"></div>',
      '  <div class="glv-row">',
      '    <button type="button" class="glv-btn" data-glv="next">次の未確認 <kbd>⇧N</kbd></button>',
      '    <button type="button" class="glv-btn" data-glv="hide">確認済みを隠す <kbd>⇧H</kbd></button>',
      '  </div>',
      '  <label class="glv-opt"><input type="checkbox" data-glv="auto"> スクロールで自動確認</label>',
      '  <button type="button" class="glv-btn glv-danger" data-glv="reset">このPRの記録をリセット</button>',
      '  <div class="glv-note"></div>',
      '</div>'
    ].join('');
    document.body.appendChild(el);
    el.querySelector('[data-glv="auto"]').addEventListener('change', (e) => {
      opts.autoMark = e.target.checked;
      set(OPT_KEY, opts);
      if (opts.autoMark) autoMarkPass();
    });
    applyPanelOpts();
  }

  function applyPanelOpts() {
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    el.classList.toggle('glv-collapsed', !!opts.collapsed);
    el.classList.toggle('glv-right', opts.side === 'right');
    el.querySelector('.glv-side').textContent = opts.side === 'right' ? '◧' : '◨';
    const hideBtn = el.querySelector('[data-glv="hide"]');
    hideBtn.classList.toggle('glv-on', !!opts.hideViewed);
    hideBtn.innerHTML = opts.hideViewed
      ? '確認済みを表示 <kbd>⇧H</kbd>'
      : '確認済みを隠す <kbd>⇧H</kbd>';
    el.querySelector('[data-glv="auto"]').checked = !!opts.autoMark;
  }

  function onPanelAction(act, e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (act === 'min') {
      opts.collapsed = !opts.collapsed;
      set(OPT_KEY, opts);
      applyPanelOpts();
    } else if (act === 'side') {
      opts.side = opts.side === 'right' ? 'left' : 'right';
      set(OPT_KEY, opts);
      applyPanelOpts();
    } else if (act === 'next') {
      jumpNext();
    } else if (act === 'hide') {
      opts.hideViewed = !opts.hideViewed;
      set(OPT_KEY, opts);
      applyPanelOpts();
      process();
    } else if (act === 'reset') {
      if (!confirm('この PR の行ごとの確認記録をすべて削除します。よろしいですか？')) return;
      sets = new Map();
      anchor = null;
      del(ctx.storeKey);
      process();
    }
  }

  function updatePanel(total, viewed, files) {
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    const pct = total ? Math.round((viewed / total) * 100) : 0;
    el.querySelector('.glv-bar').style.width = pct + '%';
    const stat =
      '<b>' + viewed + '</b> / ' + total + ' 行 　<span class="glv-pct">' + pct + '%</span>';
    const statEl = el.querySelector('.glv-stat');
    if (statEl.innerHTML !== stat) statEl.innerHTML = stat;
    const head = viewed + '/' + total;
    const headEl = el.querySelector('.glv-head-stat');
    if (headEl.textContent !== head) headEl.textContent = head;

    // diff が 1 つも見つからない状態がしばらく続いた時だけ知らせる
    // （読み込み途中で一瞬 0 になることがあるため）
    const note = el.querySelector('.glv-note');
    if (!files) {
      if (!zeroSince) zeroSince = Date.now();
      if (Date.now() - zeroSince > 2500) {
        const msg = 'diff を検出できませんでした。ファイルを展開すると認識されます。';
        if (note.textContent !== msg) note.textContent = msg;
        note.style.display = '';
      }
    } else {
      zeroSince = 0;
      note.style.display = 'none';
    }
    el.classList.toggle('glv-done', total > 0 && viewed === total);
  }

  function flashPanel(msg) {
    const el = document.getElementById(PANEL_ID);
    if (!el) return;
    const note = el.querySelector('.glv-note');
    note.textContent = msg;
    note.style.display = '';
    setTimeout(() => { note.style.display = 'none'; }, 2000);
  }

  /* ---------------- ライフサイクル ---------------- */

  function isOurs(node) {
    const el = node instanceof Element ? node : node.parentElement;
    return !!(el && el.closest && el.closest('#' + PANEL_ID + ', #' + SEL_ID + ', .glv-badge'));
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((records) => {
      for (const r of records) {
        if (isOurs(r.target)) continue;
        const added = Array.from(r.addedNodes);
        if (added.length && added.every(isOurs)) continue;
        schedule();
        return;
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-selected']
    });
  }

  function teardown() {
    ctx = null;
    sets = new Map();
    anchor = null;
    if (observer) { observer.disconnect(); observer = null; }
    const el = document.getElementById(PANEL_ID);
    if (el) el.remove();
    const sb = document.getElementById(SEL_ID);
    if (sb) sb.remove();
  }

  async function boot() {
    const m = PR_RE.exec(location.pathname);
    if (!m) { if (ctx) teardown(); return; }
    const storeKey = KEY_PREFIX + m[1] + '/' + m[2] + '#' + m[3];
    if (ctx && ctx.storeKey === storeKey && document.getElementById(PANEL_ID)) {
      schedule();
      return;
    }
    teardown();
    ctx = { owner: m[1], repo: m[2], num: m[3], storeKey };
    opts = Object.assign(opts, (await get(OPT_KEY)) || {});
    sets = deserialize(await get(storeKey));
    ensurePanel();
    applyPanelOpts();
    startObserver();
    process();
  }

  document.addEventListener('click', onClickCapture, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('pjax:end', boot);
  document.addEventListener('turbo:render', boot);
  window.addEventListener('popstate', boot);
  setInterval(() => {
    if (location.href !== lastHref) { lastHref = location.href; boot(); }
  }, 500);

  boot();
})();
