// 각 프레임에 주입되어 그 프레임의 렌더링된 DOM을 저장용 문자열로 만든다.
// background.js가 executeScript로 주입한 뒤 window.__htmldl.* 를 호출한다.
// mode: 'css' = CSS 포함 HTML, 'pure' = 구조·텍스트만 남긴 HTML, 'md' = pure 결과를 Markdown으로 변환
(() => {
  const P = 'data-htmldl-';
  // 원본 DOM에 잠시 달았다가 복제 직후 떼는 표식 속성들
  const MARK_ATTRS = ['v', 'c', 's', 'hide', 'fi', 'r'].map((k) => P + k);

  // 순수 HTML에서 남길 속성 (그 외 class/style/data-* 등은 제거)
  const PURE_KEEP_ATTRS = new Set([
    'id', 'name', 'href', 'title', 'alt', 'type', 'value', 'checked', 'selected',
    'disabled', 'readonly', 'multiple', 'colspan', 'rowspan', 'headers', 'scope',
    'for', 'label', 'placeholder', 'datetime', 'start', 'reversed', 'open',
    'lang', 'dir', 'role', 'aria-label',
  ]);

  // 교차 출처 프레임은 부모가 직접 읽을 수 없으므로, 부모가 postMessage로 넘겨준 id로 자기 자신을 식별한다.
  if (!window.__htmldlListening) {
    window.__htmldlListening = true;
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && d.__htmldl === 'assign' && typeof d.id === 'string') window.__htmldlId = d.id;
    });
  }
  window.__htmldlId = window === window.top ? 'top' : null;

  // 이번 직렬화에서 가져오지 못한 교차 출처 CSS 수 (background가 경고로 표시)
  let cssFailures = 0;

  function assignChildIds() {
    for (const el of document.querySelectorAll('iframe, frame')) {
      const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      el.setAttribute(P + 'id', id);
      try {
        el.contentWindow?.postMessage({ __htmldl: 'assign', id }, '*');
      } catch {
        // 접근 불가 프레임은 건너뛴다
      }
    }
  }

  async function waitForId(ms = 1500) {
    const end = Date.now() + ms;
    while (!window.__htmldlId && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function serialize({ mode, scope }) {
    const isTop = window === window.top;
    if (scope === 'page' && !isTop) {
      let frameElement = null;
      try {
        frameElement = window.frameElement;
      } catch {
        frameElement = null;
      }
      // 같은 출처 부모는 contentDocument로 이 프레임을 직접 펼쳐 넣으므로 중복 작업하지 않는다
      if (frameElement) return null;
      await waitForId();
      if (!window.__htmldlId) return null;
    }

    cssFailures = 0;
    const root = await buildClone(document, { mode, scope });
    if (!root) return { error: 'NO_SELECTION' };

    const base = { id: isTop ? 'top' : window.__htmldlId, url: location.href, title: document.title, cssFailures };
    if (mode === 'md') return { ...base, doctype: '', content: htmlToMd(root.querySelector('body') || root) };
    const asWholeDoc = isTop || scope === 'selection' || mode === 'css';
    return {
      ...base,
      doctype: mode === 'pure' ? '<!DOCTYPE html>\n' : doctypeOf(document),
      content: asWholeDoc ? root.outerHTML : bodyInner(root),
    };
  }

  async function buildClone(doc, opts) {
    const frames = [...doc.querySelectorAll('iframe, frame')];
    markDoc(doc, opts, frames);
    let root;
    try {
      root = opts.scope === 'selection' ? cloneSelection(doc) : doc.documentElement.cloneNode(true);
    } finally {
      unmarkDoc(doc);
    }
    if (!root) return null;
    await processClone(root, doc, opts, frames);
    return root;
  }

  // 복제(cloneNode)로는 입력값·가시성·프레임 크기가 따라오지 않으므로 원본에 속성으로 적어 둔다
  function markDoc(doc, { mode }, frames) {
    for (const el of doc.querySelectorAll('input, textarea, select')) {
      if (el.localName === 'select') {
        for (const o of el.options) o.setAttribute(P + 's', o.selected ? '1' : '0');
        continue;
      }
      const type = (el.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') el.setAttribute(P + 'c', el.checked ? '1' : '0');
      else if (type === 'password' || type === 'file') el.setAttribute(P + 'v', '');
      else el.setAttribute(P + 'v', el.value);
    }
    frames.forEach((f, i) => {
      const r = f.getBoundingClientRect();
      f.setAttribute(P + 'fi', String(i));
      f.setAttribute(P + 'r', [r.left, r.top, r.width, r.height].map(Math.round).join(','));
    });
    if (mode !== 'css' && doc.body) markHidden(doc.body, doc.defaultView);
  }

  function markHidden(parent, win) {
    for (const el of parent.children) {
      if (win.getComputedStyle(el).display === 'none') {
        el.setAttribute(P + 'hide', '');
        continue;
      }
      if (el.localName !== 'select') markHidden(el, win);
    }
  }

  function unmarkDoc(doc) {
    const selector = MARK_ATTRS.map((a) => `[${a}]`).join(',');
    for (const el of doc.querySelectorAll(selector)) {
      for (const a of MARK_ATTRS) el.removeAttribute(a);
    }
  }

  // 선택 영역만 복제하되, CSS 선택자가 맞도록 html → 공통 조상까지의 껍데기 요소를 함께 만든다
  function cloneSelection(doc) {
    const sel = doc.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    let ancestor = range.commonAncestorContainer;
    if (ancestor.nodeType !== Node.ELEMENT_NODE) ancestor = ancestor.parentElement;

    const root = doc.documentElement.cloneNode(false);
    if (doc.head) root.appendChild(doc.head.cloneNode(true));
    const chain = [];
    for (let el = ancestor; el && el !== doc.documentElement; el = el.parentElement) chain.unshift(el);
    let parent = root;
    for (const el of chain) {
      const shell = el.cloneNode(false);
      parent.appendChild(shell);
      parent = shell;
    }
    parent.appendChild(range.cloneContents());
    return root;
  }

  async function processClone(root, doc, { mode }, frames) {
    const pure = mode !== 'css';

    // 이미지는 저장하지 않는다. alt가 있으면 텍스트로 남긴다.
    for (const img of root.querySelectorAll('img, input[type=image]')) {
      const alt = (img.getAttribute('alt') || '').trim();
      if (alt) img.replaceWith(doc.createTextNode(alt));
      else img.remove();
    }
    for (const pic of root.querySelectorAll('picture')) pic.replaceWith(...pic.childNodes);

    const removeSelectors = [
      'script', 'noscript', 'template', 'base', 'link', 'style', 'meta[charset]', 'meta[http-equiv]',
      'source', 'track', 'video', 'audio', 'object', 'embed', 'applet', 'canvas',
    ];
    // 숨은 입력값(CSRF 토큰 등)은 Claude에 넘길 필요가 없으므로 순수·MD에서 뺀다
    if (pure) removeSelectors.push('svg', 'input[type=hidden]', `[${P}hide]`);
    for (const el of root.querySelectorAll(removeSelectors.join(','))) el.remove();

    applyFormValues(root);
    cleanAttributes(root, pure);
    if (pure) slimForText(root, doc);
    await setupHead(root, doc, pure);
    await replaceFrames(root, doc, mode, frames);
    replaceFramesets(root, doc, pure);
    return root;
  }

  function applyFormValues(root) {
    for (const el of root.querySelectorAll(`[${P}v]`)) {
      const v = el.getAttribute(P + 'v');
      if (el.localName === 'textarea') el.textContent = v;
      else if (v) el.setAttribute('value', v);
      else el.removeAttribute('value');
      el.removeAttribute(P + 'v');
    }
    for (const [mark, attr] of [['c', 'checked'], ['s', 'selected']]) {
      for (const el of root.querySelectorAll(`[${P}${mark}]`)) {
        if (el.getAttribute(P + mark) === '1') el.setAttribute(attr, '');
        else el.removeAttribute(attr);
        el.removeAttribute(P + mark);
      }
    }
  }

  function cleanAttributes(root, pure) {
    for (const el of root.querySelectorAll('*')) {
      // 링크는 저장 파일에서도 원래 주소로 가도록 절대경로로 바꾼다 (SVG <a>의 href는 문자열이 아니라 제외)
      if (el.hasAttribute('href') && typeof el.href === 'string') {
        if (/^javascript:/i.test(el.href)) el.removeAttribute('href');
        else el.setAttribute('href', el.href);
      }
      for (const { name } of [...el.attributes]) {
        if (name.startsWith(P)) continue; // 프레임 표식은 replaceFrames에서 쓴다
        const isScriptOrImage = name.startsWith('on') || name === 'background';
        if (isScriptOrImage || (pure && !PURE_KEEP_ATTRS.has(name))) el.removeAttribute(name);
      }
    }
  }

  // ---- 순수 HTML 정리: 의미 없는 마크업·공백을 걷어내 텍스트 대비 크기를 줄인다 ----

  function slimForText(root, doc) {
    // 주석 제거 (교차 출처 프레임 자리표시는 이후 단계에서 추가되므로 영향 없음)
    const comments = [];
    const commentWalker = doc.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
    for (let n = commentWalker.nextNode(); n; n = commentWalker.nextNode()) comments.push(n);
    for (const c of comments) c.remove();

    // 감싸기만 하는 요소를 벗긴다. 이름에 '-'가 있는 커스텀 요소(다른 확장이 끼워 넣은 것 등)도 내용만 남긴다.
    for (const el of root.querySelectorAll('span, font, tbody, center, a:not([href])')) unwrap(el);
    for (const el of [...root.querySelectorAll('*')].filter((e) => e.localName.includes('-'))) unwrap(el);
    for (const el of root.querySelectorAll('colgroup, col')) el.remove();

    // 셀·목록 안의 <p>는 줄바꿈으로 바꾼다 (표를 품은 레이아웃용 셀은 문단 구조를 유지)
    for (const p of root.querySelectorAll('td p, th p, li p, dd p')) {
      if (p.closest('td, th, li, dd').querySelector('table')) continue;
      if (siblingContent(p, 'previousSibling')) p.before(doc.createElement('br'));
      unwrap(p);
    }

    // 내용 없는 블록 제거 (안쪽부터)
    const keepIfContains = `input, select, textarea, iframe, frame, hr, table, [${P}fi]`;
    for (const el of [...root.querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6')].reverse()) {
      if (!el.textContent.trim() && !el.querySelector(keepIfContains)) el.remove();
    }

    // 앞뒤 끝·연속된 <br> 제거
    for (const br of root.querySelectorAll('br')) {
      const prev = siblingContent(br, 'previousSibling');
      const next = siblingContent(br, 'nextSibling');
      if (!prev || !next || (prev.nodeType === Node.ELEMENT_NODE && prev.localName === 'br')) br.remove();
    }

    // 공백 정리: &nbsp; → 공백, 연속 공백·줄바꿈 축약 (pre/textarea 안은 유지)
    root.normalize();
    const textWalker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = textWalker.nextNode(); n; n = textWalker.nextNode()) {
      if (n.parentElement?.closest('pre, textarea')) continue;
      const text = n.data.replace(/ /g, ' ');
      if (!text.trim()) n.data = text.includes('\n') ? '\n' : ' ';
      else n.data = text.replace(/\s+/g, ' ');
    }
    for (const el of root.querySelectorAll('td, th, p, li, dt, dd, h1, h2, h3, h4, h5, h6')) {
      if (el.firstChild?.nodeType === Node.TEXT_NODE) el.firstChild.data = el.firstChild.data.trimStart();
      if (el.lastChild?.nodeType === Node.TEXT_NODE) el.lastChild.data = el.lastChild.data.trimEnd();
    }
  }

  function unwrap(el) {
    el.replaceWith(...el.childNodes);
  }

  // 공백 텍스트를 건너뛴 이웃 노드
  function siblingContent(node, dir) {
    let n = node[dir];
    while (n && ((n.nodeType === Node.TEXT_NODE && !n.data.trim()) || n.nodeType === Node.COMMENT_NODE)) n = n[dir];
    return n;
  }

  async function setupHead(root, doc, pure) {
    let head = root.querySelector('head');
    if (!head) {
      head = doc.createElement('head');
      root.prepend(head);
    }
    if (pure) {
      for (const c of [...head.childNodes]) if (c.localName !== 'title') c.remove();
    }
    // 원본이 EUC-KR 등이어도 저장 파일은 UTF-8로 쓴다
    const meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    head.prepend(meta);
    if (!pure) {
      const style = doc.createElement('style');
      style.textContent = await collectCss(doc);
      head.append(style);
    }
  }

  async function replaceFrames(root, doc, mode, frames) {
    const pure = mode !== 'css';
    for (const el of root.querySelectorAll(`[${P}fi]`)) {
      const orig = frames[Number(el.getAttribute(P + 'fi'))];
      const [x, y, w, h] = (el.getAttribute(P + 'r') || '0,0,0,0').split(',').map(Number);

      let childDoc = null;
      try {
        childDoc = orig.contentDocument;
      } catch {
        childDoc = null;
      }
      // 같은 출처면 바로 펼치고, 교차 출처면 background가 채울 자리표시만 남긴다
      let inner = null;
      if (childDoc && childDoc.documentElement) {
        const childRoot = await buildClone(childDoc, { mode, scope: 'page' });
        inner = pure ? bodyInner(childRoot) : doctypeOf(childDoc) + childRoot.outerHTML;
      }
      // 크기 0인 교차 출처 프레임(추적용 등)은 본문이 아니므로 누락 경고 없이 뺀다
      if (inner === null && (w === 0 || h === 0)) {
        el.remove();
        continue;
      }
      // id를 못 받은 교차 출처 프레임도 자리표시를 남겨 background가 누락으로 집계하게 한다
      const slotId = orig.getAttribute(P + 'id') || 'missing';

      let rep;
      if (pure) {
        rep = doc.createElement('section');
        rep.setAttribute('data-frame-src', orig.src || 'about:blank');
        if (inner !== null) rep.innerHTML = inner;
        else rep.append(doc.createComment(`HTMLDL-SLOT-${slotId}`));
      } else {
        rep = doc.createElement('iframe');
        for (const { name, value } of el.attributes) {
          if (name !== 'src' && name !== 'srcdoc' && name !== 'style' && !name.startsWith(P)) rep.setAttribute(name, value);
        }
        rep.setAttribute('srcdoc', inner ?? `HTMLDL-SLOT-${slotId}`);
        // frameset의 frame은 원래 화면 위치에 절대배치, iframe은 렌더링 크기만 고정
        const isFrame = el.localName === 'frame';
        const base = isFrame
          ? `position:absolute;left:${x}px;top:${y}px;border:0;`
          : (el.getAttribute('style') || '').replace(/;?\s*$/, ';');
        rep.setAttribute('style', `${base}box-sizing:border-box;width:${w}px;height:${h}px;`);
      }
      el.replaceWith(rep);
    }
  }

  function replaceFramesets(root, doc, pure) {
    for (const fs of root.querySelectorAll('frameset')) {
      const isOuter = fs.parentElement === root;
      const rep = doc.createElement(isOuter ? 'body' : 'div');
      if (isOuter && !pure) rep.setAttribute('style', 'margin:0');
      rep.append(...fs.childNodes);
      fs.replaceWith(rep);
    }
  }

  function bodyInner(root) {
    const body = root.querySelector('body');
    if (body) return body.innerHTML;
    root.querySelector('head')?.remove();
    return root.innerHTML;
  }

  function doctypeOf(doc) {
    const d = doc.doctype;
    if (!d) return ''; // 원본이 쿼크 모드면 그대로 쿼크 모드로 저장한다
    const pub = d.publicId ? ` PUBLIC "${d.publicId}"` : '';
    const sys = d.systemId ? `${d.publicId ? '' : ' SYSTEM'} "${d.systemId}"` : '';
    return `<!DOCTYPE ${d.name}${pub}${sys}>\n`;
  }

  // ---- Markdown 변환: slimForText를 거친 DOM을 받는다 ----

  const PLAIN_BLOCKS = new Set([
    'address', 'article', 'aside', 'body', 'center', 'details', 'dialog', 'div', 'dl', 'fieldset',
    'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'legend', 'main', 'nav', 'p', 'section', 'summary',
  ]);

  function htmlToMd(rootEl) {
    // pre 블록은 이후 공백 정리에서 망가지지 않도록 자리표시로 빼 두었다가 되돌린다
    const pres = [];
    const raw = mdNode(rootEl, { cell: false, pres });
    const lines = raw
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((l) => l.replace(/^ (?=\S)/, '').replace(/(\S) {2,}/g, '$1 ').replace(/[ \t]+$/, ''));
    return lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\u0000PRE(\d+)\u0000/g, (_, i) => pres[Number(i)])
      .trim() + '\n';
  }

  function mdBlock(s) {
    const t = s.trim();
    return t ? `\n\n${t}\n\n` : '';
  }

  function mdChildren(el, ctx) {
    return [...el.childNodes].map((n) => mdNode(n, ctx)).join('');
  }

  function mdWrap(el, ctx, mark) {
    const s = mdChildren(el, ctx);
    const t = s.trim();
    if (!t) return s;
    return `${s.startsWith(' ') ? ' ' : ''}${mark}${t}${mark}${s.endsWith(' ') ? ' ' : ''}`;
  }

  function mdNode(node, ctx) {
    if (node.nodeType === Node.TEXT_NODE) return node.data.replace(/\s+/g, ' ');
    if (node.nodeType === Node.COMMENT_NODE) {
      // 교차 출처 프레임 자리표시는 background가 채우도록 그대로 둔다
      return node.data.startsWith('HTMLDL-SLOT-') ? `\n\n<!--${node.data}-->\n\n` : '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    const el = node;
    const tag = el.localName;
    if (/^h[1-6]$/.test(tag)) {
      const text = mdChildren(el, ctx).replace(/\s+/g, ' ').trim();
      return ctx.cell ? `\n**${text}**\n` : mdBlock(`${'#'.repeat(Number(tag[1]))} ${text}`);
    }
    if (tag === 'section' && el.hasAttribute('data-frame-src')) {
      return mdBlock(`<!-- frame: ${el.getAttribute('data-frame-src')} -->\n\n${mdChildren(el, ctx)}`);
    }
    if (PLAIN_BLOCKS.has(tag)) return mdBlock(mdChildren(el, ctx));

    switch (tag) {
      case 'br':
        return '\n';
      case 'hr':
        return mdBlock('---');
      case 'strong':
      case 'b':
        return mdWrap(el, ctx, '**');
      case 'em':
      case 'i':
        return mdWrap(el, ctx, '*');
      case 's':
      case 'del':
      case 'strike':
        return mdWrap(el, ctx, '~~');
      case 'code':
      case 'kbd':
      case 'samp':
      case 'tt': {
        const t = el.textContent.replace(/\s+/g, ' ').trim();
        return t ? `\`${t}\`` : '';
      }
      case 'pre': {
        const code = el.textContent.replace(/\n+$/, '');
        if (ctx.cell) return `\n${code}\n`;
        ctx.pres.push('```\n' + code + '\n```');
        return mdBlock(`\u0000PRE${ctx.pres.length - 1}\u0000`);
      }
      case 'blockquote': {
        const inner = mdChildren(el, ctx).replace(/\n{3,}/g, '\n\n').trim();
        return mdBlock(inner.split('\n').map((l) => `> ${l}`).join('\n'));
      }
      case 'ul':
      case 'ol':
        return mdList(el, ctx);
      case 'li':
        return mdBlock(`- ${mdChildren(el, ctx)}`);
      case 'dt':
        return mdBlock(`**${mdChildren(el, ctx).trim()}**`);
      case 'dd':
        return mdBlock(mdChildren(el, ctx));
      case 'a': {
        const text = mdChildren(el, ctx).replace(/\s+/g, ' ').trim();
        const href = el.getAttribute('href');
        if (!href || !text) return text;
        return text === href ? `<${href}>` : `[${text}](${href})`;
      }
      case 'table':
        return mdTable(el, ctx);
      case 'caption':
        return mdBlock(`**${mdChildren(el, ctx).trim()}**`);
      case 'input':
        return mdInput(el);
      case 'select': {
        const o = el.querySelector('option[selected]') || el.querySelector('option');
        const t = o?.textContent.trim();
        return t ? `\`${t}\`` : '';
      }
      case 'textarea': {
        const t = el.textContent.trim();
        if (!t) return '';
        return ctx.cell || !t.includes('\n') ? `\`${t.replace(/\s+/g, ' ')}\`` : mdBlock('```\n' + t + '\n```');
      }
      case 'option':
      case 'optgroup':
      case 'datalist':
      case 'head':
      case 'title':
        return '';
      default:
        return mdChildren(el, ctx);
    }
  }

  function mdInput(el) {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    const value = el.getAttribute('value') || '';
    if (type === 'hidden') return '';
    if (type === 'checkbox' || type === 'radio') return el.hasAttribute('checked') ? '[x] ' : '[ ] ';
    if (type === 'button' || type === 'submit' || type === 'reset') return value ? `[${value}]` : '';
    return value ? `\`${value}\`` : '';
  }

  function mdList(el, ctx) {
    const ordered = el.localName === 'ol';
    let n = Number(el.getAttribute('start')) || 1;
    const items = [];
    for (const child of el.children) {
      if (child.localName !== 'li') {
        items.push(mdNode(child, ctx).trim());
        continue;
      }
      const marker = ordered ? `${n++}. ` : '- ';
      const body = mdChildren(child, ctx).replace(/\n{2,}/g, '\n').trim();
      const [first, ...rest] = body.split('\n');
      items.push(marker + first + rest.map((l) => `\n${' '.repeat(marker.length)}${l}`).join(''));
    }
    return mdBlock(items.filter(Boolean).join('\n'));
  }

  function mdTable(table, ctx) {
    const rows = [...table.rows];
    if (rows.length === 0) return '';
    const caption = table.caption ? mdBlock(`**${table.caption.textContent.trim()}**`) : '';
    const colCount = Math.max(...rows.map((r) => [...r.cells].reduce((sum, c) => sum + Math.max(1, c.colSpan || 1), 0)));

    // 표 안에 표가 있거나 한 열짜리 표는 레이아웃용으로 보고 블록으로 펼친다
    if (table.querySelector('table') || colCount <= 1 || ctx.cell) {
      return caption + mdBlock(rows.map((r) => mdLayoutRow(r, ctx)).join(''));
    }

    // colspan은 빈 칸으로 채우고, rowspan은 아래 행에 같은 값을 반복해 격자를 만든다
    const grid = rows.map(() => []);
    rows.forEach((row, ri) => {
      let ci = 0;
      for (const cell of row.cells) {
        while (grid[ri][ci] !== undefined) ci++;
        const text = mdCellText(cell, ctx);
        const colSpan = Math.max(1, cell.colSpan || 1);
        const rowSpan = Math.max(1, cell.rowSpan || 1);
        for (let dr = 0; dr < rowSpan && ri + dr < rows.length; dr++) {
          for (let dc = 0; dc < colSpan; dc++) grid[ri + dr][ci + dc] = dc === 0 ? text : '';
        }
        ci += colSpan;
      }
    });
    const lines = grid
      .map((cells) => Array.from({ length: colCount }, (_, i) => cells[i] ?? ''))
      .filter((cells) => cells.some((c) => c))
      .map((cells) => `| ${cells.join(' | ')} |`);
    if (lines.length === 0) return caption;
    lines.splice(1, 0, `|${' --- |'.repeat(colCount)}`);
    return caption + mdBlock(lines.join('\n'));
  }

  function mdLayoutRow(row, ctx) {
    const cells = [...row.cells];
    // "제목칸(th) + 값칸" 한 줄짜리는 "**제목**: 값"으로 붙인다
    if (cells.length === 2 && cells[0].localName === 'th') {
      const key = mdCellText(cells[0], ctx);
      const value = mdChildren(cells[1], ctx).replace(/\n{3,}/g, '\n\n').trim();
      return value.includes('\n') ? mdBlock(`**${key}**\n\n${value}`) : mdBlock(`**${key}**: ${value}`);
    }
    return cells
      .map((c) => (c.localName === 'th' ? mdBlock(`**${mdCellText(c, ctx)}**`) : mdBlock(mdChildren(c, ctx))))
      .join('');
  }

  function mdCellText(cell, ctx) {
    return mdChildren(cell, { ...ctx, cell: true })
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('<br>')
      .replace(/\|/g, '\\|');
  }

  // ---- CSS 수집: 적용 중인 스타일시트를 문서 순서대로 하나로 합친다 ----

  async function collectCss(doc) {
    const parts = [];
    for (const sheet of [...doc.styleSheets, ...(doc.adoptedStyleSheets || [])]) {
      if (sheet.disabled) continue;
      parts.push(wrapMedia(await sheetText(sheet, doc, 0), sheet.media?.mediaText));
    }
    return parts.join('\n');
  }

  async function sheetText(sheet, doc, depth) {
    let rules = null;
    try {
      rules = sheet.cssRules;
    } catch {
      rules = null; // 교차 출처 시트는 cssRules 접근이 막힌다
    }
    if (!rules) return sheet.href ? fetchCss(sheet.href, doc.characterSet, depth) : '';

    const out = [];
    for (const rule of rules) {
      if (rule.type === CSSRule.IMPORT_RULE) {
        if (rule.styleSheet && depth < 5) {
          out.push(wrapMedia(await sheetText(rule.styleSheet, doc, depth + 1), rule.media?.mediaText));
        }
      } else {
        out.push(rule.cssText);
      }
    }
    return out.join('\n');
  }

  async function fetchCss(url, charset, depth) {
    let text = '';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'fetchText', url, charset });
      if (!res?.ok) cssFailures++;
      text = res?.text || '';
    } catch {
      cssFailures++;
      return '';
    }
    if (depth >= 5) return text;

    // 받아온 CSS 안의 @import도 펼친다
    const re = /@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?\s*([^;]*);/gi;
    const pieces = [];
    let last = 0;
    for (const m of text.matchAll(re)) {
      pieces.push(text.slice(last, m.index));
      let imported = '';
      try {
        imported = await fetchCss(new URL(m[2], url).href, charset, depth + 1);
      } catch {
        imported = '';
      }
      pieces.push(wrapMedia(imported, m[3].trim()));
      last = m.index + m[0].length;
    }
    pieces.push(text.slice(last));
    return pieces.join('');
  }

  function wrapMedia(css, media) {
    if (!css || !media || media === 'all') return css;
    return `@media ${media} {\n${css}\n}`;
  }

  window.__htmldl = { assignChildIds, serialize };
})();
