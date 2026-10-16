const statusEl = document.getElementById('status');
const tabListEl = document.getElementById('tabList');
const tabCountEl = document.getElementById('tabCount');
const buttons = [...document.querySelectorAll('button[data-action]')];
const tabButtons = [...document.querySelectorAll('.tabs button')];

const CAPTURABLE = /^(https?|file):/i;

init();

async function init() {
  for (const btn of buttons) btn.addEventListener('click', () => onAction(btn.dataset.action, btn.dataset.mode));
  for (const btn of tabButtons) btn.addEventListener('click', () => showPanel(btn));
  document.getElementById('toggleAll').addEventListener('click', toggleAll);
  tabListEl.addEventListener('change', updateCount);
  await Promise.all([renderTarget(), renderTabList()]);
}

// 팝업은 항상 "현재 탭" 화면으로 열린다. 여러 탭 저장은 탭을 눌렀을 때만 보인다.
function showPanel(activeBtn) {
  for (const btn of tabButtons) {
    const active = btn === activeBtn;
    btn.classList.toggle('active', active);
    document.getElementById(btn.dataset.panel).hidden = !active;
  }
  showStatus('', '');
}

// 버튼을 누르면 무엇이 저장되는지 보이도록 현재 탭의 제목을 표시한다
async function renderTarget() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const titleEl = document.getElementById('targetTitle');
  const iconEl = document.getElementById('targetIcon');
  titleEl.textContent = tab?.title || tab?.url || '(알 수 없는 탭)';
  titleEl.title = tab?.url || '';
  if (tab?.favIconUrl && /^https?:|^data:/i.test(tab.favIconUrl)) {
    iconEl.src = tab.favIconUrl;
    iconEl.hidden = false;
  }
}

// 현재 창의 탭 + window.open으로 뜬 팝업 창의 탭을 나열한다.
// 미리 체크: Ctrl+클릭으로 여러 탭을 선택했으면 그 탭들, 아니면 현재 창의 모든 탭. 팝업 창은 체크하지 않는다.
async function renderTabList() {
  const current = await chrome.windows.getCurrent({ populate: true });
  const popupWindows = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });

  const normalTabs = current.tabs.filter((t) => CAPTURABLE.test(t.url || ''));
  const highlighted = normalTabs.filter((t) => t.highlighted);
  const preselected = new Set((highlighted.length > 1 ? highlighted : normalTabs).map((t) => t.id));
  const popupTabs = popupWindows.flatMap((w) => w.tabs).filter((t) => CAPTURABLE.test(t.url || ''));

  tabListEl.replaceChildren();
  for (const tab of normalTabs) tabListEl.append(tabRow(tab, preselected.has(tab.id), false));
  for (const tab of popupTabs) tabListEl.append(tabRow(tab, false, true));
  if (!tabListEl.children.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '저장할 수 있는 탭이 없습니다.';
    tabListEl.append(empty);
  }
  updateCount();
}

function tabRow(tab, checked, isPopup) {
  const label = document.createElement('label');
  label.title = tab.url;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = String(tab.id);
  box.checked = checked;
  label.append(box);
  if (isPopup) {
    const tag = document.createElement('span');
    tag.className = 'popup';
    tag.textContent = '[팝업]';
    label.append(tag);
  }
  const title = document.createElement('span');
  title.textContent = tab.title || tab.url;
  label.append(title);
  return label;
}

function checkedTabIds() {
  return [...tabListEl.querySelectorAll('input:checked')].map((b) => Number(b.value));
}

function updateCount() {
  const total = tabListEl.querySelectorAll('input').length;
  const checked = checkedTabIds().length;
  tabCountEl.textContent = `${checked} / ${total}개 선택`;
  document.getElementById('manyTabButton').textContent = `여러 탭 (${checked})`;
}

function toggleAll() {
  const boxes = [...tabListEl.querySelectorAll('input')];
  const allChecked = boxes.every((b) => b.checked);
  for (const b of boxes) b.checked = !allChecked;
  updateCount();
}

async function onAction(action, mode) {
  setBusy(true);
  try {
    if (action === 'many') await saveMany(mode);
    else await captureCurrent(mode, action === 'copy' ? 'copy' : 'download');
  } catch (e) {
    showStatus(`실패: ${e.message}`, 'err');
  } finally {
    setBusy(false);
  }
}

async function captureCurrent(mode, deliver) {
  showStatus(deliver === 'copy' ? '복사 중…' : '저장 중…', '');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await chrome.runtime.sendMessage({ type: 'capture', tabId: tab.id, mode, deliver });
  if (!res?.ok) {
    showStatus(`실패: ${res?.error ?? '알 수 없는 오류'}`, 'err');
    return;
  }
  if (deliver === 'copy') {
    await navigator.clipboard.writeText(res.text);
  }
  const done = deliver === 'copy' ? `클립보드에 복사했습니다 (${res.text.length.toLocaleString()}자)` : `저장 완료: ${res.filename}`;
  if (res.warnings.length) showStatus(`${done}\n일부 누락: ${res.warnings.join(', ')}`, 'warn');
  else showStatus(done, 'ok');
}

async function saveMany(mode) {
  const tabIds = checkedTabIds();
  if (tabIds.length === 0) {
    showStatus('저장할 탭을 선택하세요.', 'err');
    return;
  }
  showStatus(`${tabIds.length}개 탭 저장 중…`, '');
  const res = await chrome.runtime.sendMessage({ type: 'captureMany', tabIds, mode });
  const lines = [`${res.saved}개 저장${res.failed.length ? `, ${res.failed.length}개 실패` : ' 완료'}`];
  lines.push(...res.failed, ...res.warned.map((w) => `일부 누락 - ${w}`));
  const cls = res.failed.length ? 'err' : res.warned.length ? 'warn' : 'ok';
  showStatus(lines.join('\n'), cls);
}

function setBusy(busy) {
  for (const b of buttons) b.disabled = busy;
}

function showStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls;
}
