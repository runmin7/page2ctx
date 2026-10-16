// 캡처 흐름 조율: 프레임별 직렬화 → 교차 출처 프레임 병합 → 파일 다운로드 또는 클립보드용 텍스트 반환
const MODES = ['md', 'pure', 'css'];
const MODE_LABEL = { css: 'HTML (CSS 포함)', pure: 'HTML (순수)', md: 'Markdown' };
const COMMAND_MODE = { 'save-md': 'md', 'save-pure': 'pure', 'save-css': 'css' };

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    for (const mode of MODES) {
      chrome.contextMenus.create({
        id: `page:${mode}`,
        title: `페이지 저장 - ${MODE_LABEL[mode]}`,
        contexts: ['page', 'frame', 'link', 'image', 'editable'],
      });
    }
    for (const mode of MODES) {
      chrome.contextMenus.create({
        id: `sel:${mode}`,
        title: `선택 영역 저장 - ${MODE_LABEL[mode]}`,
        contexts: ['selection'],
      });
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const [scope, mode] = String(info.menuItemId).split(':');
  run(tab.id, mode, scope === 'sel' ? 'selection' : 'page', info.frameId ?? 0);
});

// 확장 아이콘이 없는 window.open 팝업 창에서도 저장할 수 있도록 단축키를 제공한다
chrome.commands.onCommand.addListener((command, tab) => {
  const mode = COMMAND_MODE[command];
  if (mode && tab?.id) run(tab.id, mode, 'page', 0);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === 'fetchText') {
    fetchText(msg.url, msg.charset).then(
      (text) => sendResponse({ ok: text !== null, text: text ?? '' }),
      () => sendResponse({ ok: false, text: '' }),
    );
    return true;
  }
  if (msg?.type === 'capture') {
    run(msg.tabId, msg.mode, 'page', 0, msg.deliver).then(sendResponse);
    return true;
  }
  if (msg?.type === 'captureMany') {
    runMany(msg.tabIds, msg.mode).then(sendResponse);
    return true;
  }
  return false;
});

// deliver: 'download' = 파일 저장, 'copy' = 텍스트를 돌려주고 팝업이 클립보드에 쓴다
async function run(tabId, mode, scope, frameId, deliver = 'download') {
  try {
    const { text, filename, warnings } = await capture(tabId, mode, scope, frameId);
    if (warnings.length) console.warn('[HTML 다운로드] 일부 누락:', warnings.join(', '));
    if (deliver === 'copy') return { ok: true, text, warnings };
    await download(text, filename, mode);
    if (warnings.length) flashBadge(tabId, '!', '#b26a00', `저장 완료(일부 누락: ${warnings.join(', ')}): ${filename}`);
    else flashBadge(tabId, 'OK', '#2e7d32', `저장 완료: ${filename}`);
    return { ok: true, filename, warnings };
  } catch (e) {
    const error = toFriendlyError(e);
    if (isCanceled(e)) return { ok: false, error };
    console.error('[HTML 다운로드]', e);
    flashBadge(tabId, 'ERR', '#c62828', `실패: ${error}`);
    return { ok: false, error };
  }
}

async function runMany(tabIds, mode) {
  let saved = 0;
  const failed = [];
  const warned = [];
  for (const tabId of tabIds) {
    const res = await run(tabId, mode, 'page', 0);
    if (res.ok) saved++;
    if (!res.ok || res.warnings.length) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const name = tab?.title || tabId;
      if (res.ok) warned.push(`${name}: ${res.warnings.join(', ')} 누락`);
      else failed.push(`${name}: ${res.error}`);
    }
  }
  return { saved, failed, warned };
}

async function capture(tabId, mode, scope, frameId) {
  const target = scope === 'selection' ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };

  await chrome.scripting.executeScript({ target, files: ['content.js'] });
  if (scope === 'page') {
    await chrome.scripting.executeScript({ target, func: () => window.__htmldl.assignChildIds() });
  }
  const results = await chrome.scripting.executeScript({
    target,
    func: (opts) => window.__htmldl.serialize(opts),
    args: [{ mode, scope }],
  });

  const parts = results.map((r) => r.result).filter(Boolean);
  const root = scope === 'selection' ? parts[0] : parts.find((p) => p.id === 'top');
  if (!root) throw new Error('페이지 내용을 읽지 못했습니다.');
  if (root.error === 'NO_SELECTION') throw new Error('선택된 영역이 없습니다.');

  const byId = new Map(parts.filter((p) => p.id).map((p) => [p.id, p]));
  const stats = { missingFrames: 0 };
  const body = fillSlots(root.content, byId, mode, 0, stats);
  const cssFailures = parts.reduce((sum, p) => sum + (p.cssFailures || 0), 0);
  const warnings = [];
  if (stats.missingFrames) warnings.push(`프레임 ${stats.missingFrames}개`);
  if (cssFailures) warnings.push(`CSS ${cssFailures}건`);
  const title = root.title?.trim() || safeHostname(root.url);
  const scopeLabel = scope === 'selection' ? ' | 선택 영역' : '';
  const savedAt = new Date().toLocaleString('ko-KR');
  // 주석 안에 '--'가 들어가면 주석이 깨진다
  const safe = (s) => s.replace(/--/g, '-%2D');
  const header = `<!-- HTML 다운로드 | ${MODE_LABEL[mode]}${scopeLabel} | ${safe(title)} | ${safe(root.url)} | ${savedAt} -->\n`;

  return { text: root.doctype + header + body, filename: makeFilename(title, mode, scope), warnings };
}

// 교차 출처 프레임 자리표시(HTMLDL-SLOT-id)를 해당 프레임의 직렬화 결과로 채운다.
// CSS 모드의 자리표시는 srcdoc 속성 안에 있고, 같은 출처 프레임 안에 들어가 있으면 이미 n번 이스케이프되어 있다.
// 채우지 못한 자리는 조용히 비우지 않고 누락 문구를 남기고 stats.missingFrames로 집계한다.
const MISSING_FRAME_TEXT = '(프레임 내용을 가져오지 못했습니다)';

function fillSlots(html, byId, mode, depth, stats) {
  if (mode !== 'css') {
    return html.replace(/<!--HTMLDL-SLOT-([\w-]+)-->/g, (_, id) => {
      const p = byId.get(id);
      if (p && depth < 10) return fillSlots(p.content, byId, mode, depth + 1, stats);
      stats.missingFrames++;
      return mode === 'md' ? `\n\n> ${MISSING_FRAME_TEXT}\n\n` : `<p>${MISSING_FRAME_TEXT}</p>`;
    });
  }
  return html.replace(/srcdoc=("|&(?:amp;)*quot;)HTMLDL-SLOT-([\w-]+)\1/g, (_, quote, id) => {
    const p = byId.get(id);
    if (!p || depth >= 10) {
      stats.missingFrames++;
      return `srcdoc=${quote}<p>${MISSING_FRAME_TEXT}</p>${quote}`;
    }
    // " → 1회, &quot; → 2회, &amp;quot; → 3회 ... 이스케이프해야 원래 문서로 복원된다
    const level = quote === '"' ? 1 : (quote.match(/amp;/g)?.length ?? 0) + 2;
    let inner = p.doctype + fillSlots(p.content, byId, mode, depth + 1, stats);
    for (let i = 0; i < level; i++) inner = escapeAttr(inner);
    return `srcdoc=${quote}${inner}${quote}`;
  });
}

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// 실패하면 null (content.js가 누락 CSS로 집계)
async function fetchText(url, fallbackCharset) {
  if (!/^https?:/i.test(url)) return null;
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) return null;
  const buf = await res.arrayBuffer();
  // 문자셋 우선순위: 응답 헤더 → @charset → 참조한 문서의 문자셋 (브라우저와 동일)
  const head = new TextDecoder('latin1').decode(buf.slice(0, 128));
  const charset =
    res.headers.get('content-type')?.match(/charset=["']?([\w-]+)/i)?.[1] ||
    head.match(/^@charset\s+"([\w-]+)"/i)?.[1] ||
    fallbackCharset ||
    'utf-8';
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder().decode(buf);
  }
}

// 서비스 워커에는 URL.createObjectURL이 없고, data URL은 2MB 제한이 있어 오프스크린 문서에서 Blob URL을 만든다
let creatingOffscreen = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: '저장할 HTML을 Blob URL로 변환' })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function download(text, filename, mode) {
  await ensureOffscreen();
  const mime = mode === 'md' ? 'text/markdown;charset=utf-8' : 'text/html;charset=utf-8';
  const { url } = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'blobUrl', text, mime });
  try {
    await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
  } catch (e) {
    // 파일명이 OS 규칙에 걸릴 때만 기본 이름으로 다시 시도한다 (저장 대화상자 취소 등은 그대로 실패)
    if (!/filename/i.test(e?.message || '')) throw e;
    await chrome.downloads.download({ url, filename: `page_${timestamp()}.${extOf(mode)}`, conflictAction: 'uniquify' });
  }
}

function extOf(mode) {
  return mode === 'md' ? 'md' : 'html';
}

function makeFilename(title, mode, scope) {
  const safe =
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 80) || 'page';
  return `${safe}_${timestamp()}_${mode}${scope === 'selection' ? '_sel' : ''}.${extOf(mode)}`;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'page';
  }
}

function isCanceled(e) {
  return /cancel/i.test(e?.message || '');
}

function toFriendlyError(e) {
  const msg = e?.message || String(e);
  if (isCanceled(e)) return '저장을 취소했습니다.';
  if (/file:\/\//i.test(msg)) {
    return '로컬 파일은 chrome://extensions에서 이 확장의 "파일 URL에 대한 액세스 허용"을 켜야 저장할 수 있습니다.';
  }
  if (/cannot be scripted|Cannot access|chrome:\/\/|extensions gallery/i.test(msg)) {
    return '이 페이지(크롬 내부 페이지·웹스토어 등)는 저장할 수 없습니다.';
  }
  if (/No tab with id|discarded|Frame with ID 0 was removed/i.test(msg)) {
    return '탭이 닫혔거나 절전 상태입니다. 탭을 한 번 열어 본 뒤 다시 시도하세요.';
  }
  return msg;
}

function flashBadge(tabId, text, color, title) {
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setTitle({ tabId, title }).catch(() => {});
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    chrome.action.setTitle({ tabId, title: 'HTML 다운로드' }).catch(() => {});
  }, 4000);
}
