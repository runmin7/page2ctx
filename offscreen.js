// background.js의 요청으로 문자열을 Blob URL로 바꿔 준다 (다운로드용)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || msg?.target !== 'offscreen' || msg.type !== 'blobUrl') return false;
  const url = URL.createObjectURL(new Blob([msg.text], { type: msg.mime || 'text/html;charset=utf-8' }));
  // '저장 위치 묻기' 대화상자에서 머무는 시간을 고려해 넉넉히 유지한 뒤 해제
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  sendResponse({ url });
  return false;
});
