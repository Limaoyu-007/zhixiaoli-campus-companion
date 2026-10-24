// Shared chat UI. Credentials and both runtimes remain in the main process.
'use strict';

const api = window.electronAPI;
const input = document.getElementById('chat-input');
const sendButton = document.getElementById('send-btn');
const newButton = document.getElementById('new-conversation-btn');
const modeSelect = document.getElementById('chat-mode');
const chatStatus = document.getElementById('chat-status');
const stopRequestButton = document.getElementById('stop-request-btn');
const bubble = document.getElementById('chat-bubble');
const stream = new window.CampusBubbles(bubble);
let pendingBubble = null;
const replySpeech = new window.CampusSpeech(error => display(error, '智小理'));
const handle = document.getElementById('window-drag-handle');
const zoomIn = document.getElementById('window-zoom-in');
const zoomOut = document.getElementById('window-zoom-out');
const scaleLabel = document.getElementById('window-scale-label');
let currentSession = null;
let requestId = null;
let busy = false;
let ready = false;
let version = 0;
let windowScale = 1;
let platformUser = '';
let handleTimer = null;
let dragging = false;
let mode = 'campus';
let switching = false;
let configReady = false;
const drafts = { campus: '', study: '' };

function idleStatus() { return mode === 'study' ? '本地 Runtime · 学习工具' : '学校 Agent 平台'; }

function setBusy(value) {
  busy = value;
  sendButton.disabled = !ready || busy;
  stopRequestButton.hidden = !busy || !ready;
  modeSelect.disabled = switching || !configReady;
  newButton.disabled = switching;
  if (!busy) chatStatus.textContent = idleStatus();
  window.setPetState?.(busy ? 'processing' : 'idle');
}
function display(text, label, { markdown = false, warning = '' } = {}) {
  return stream.add({ text, label: '智小理', markdown, warning });
}
function finishBubble(text, { markdown = false, warning = '', kind = 'assistant', feedback = null } = {}) {
  const options = { text, label: '智小理', markdown, warning, kind, feedback };
  if (pendingBubble) stream.update(pendingBubble, options);
  else stream.add(options);
  pendingBubble = null;
}

function showSession(view, { replay = false } = {}) {
  currentSession = view.id;
  requestId = view.requestId || null;
  ready = true;
  stream.clear();
  pendingBubble = null;
  if (replay) for (const message of (view.messages || []).slice(-3)) {
    if (!['user', 'assistant'].includes(message.role)) continue;
    stream.add({ text: message.role === 'assistant' ? window.CampusAnswer.stripThinking(message.content) : message.content,
      label: message.role === 'user' ? '我' : '智小理', kind: message.role, markdown: message.role === 'assistant' });
  }
  setBusy(view.pending);
  if (view.pending) {
    chatStatus.textContent = '请求仍在处理中…';
    pendingBubble = stream.add({ text: '正在回复…', label: '智小理', pending: true });
  } else if (view.lastError) display(view.lastError, '智小理');
  modeSelect.value = mode;
  input.placeholder = mode === 'study' ? '问学习问题，或查询我的课表…' : '和智小理说点什么…';
  newButton.title = mode === 'study' ? '清空当前通用学习会话上下文' : '新建校园对话，保留长期记忆，不撤销已有预约';
}
async function restoreSession({ replay = mode === 'study' } = {}) {
  const generation = ++version;
  ready = false;
  setBusy(true);
  try {
    const result = await api.campusGetSession(mode);
    if (generation !== version) return;
    if (!result.ok) throw new Error(result.error);
    showSession(result.session, { replay });
  } catch (error) {
    if (generation !== version) return;
    setBusy(false);
    display(error.message, '校园助手 · 会话加载失败');
  }
}
modeSelect.addEventListener('change', async () => {
  if (switching) return;
  const previous = mode;
  const next = modeSelect.value;
  drafts[previous] = input.value;
  replySpeech.stop();
  const generation = ++version;
  switching = true;
  ready = false;
  requestId = null;
  mode = next;
  setBusy(true);
  chatStatus.textContent = '正在切换模式…';
  try {
    const result = await api.switchChatMode(next);
    if (generation !== version) return;
    if (!result.ok) throw new Error(result.error);
    switching = false;
    input.value = drafts[next];
    showSession(result.session, { replay: true });
    input.focus();
  } catch (error) {
    if (generation !== version) return;
    mode = previous;
    switching = false;
    modeSelect.value = previous;
    await restoreSession({ replay: true });
    display(error.message, '智小理');
  } finally { switching = false; modeSelect.disabled = !configReady; }
});
stopRequestButton.addEventListener('click', async () => {
  if (!busy || !ready) return;
  try {
    const result = await api.cancelChat(mode);
    if (!result.ok) throw new Error(result.error);
  } catch (error) { display(error.message, '智小理'); }
});
function sendMessage() {
  const query = input.value.trim();
  if (!query || !ready || busy) return;
  replySpeech.stop();
  replySpeech.prepare();
  if (query.length > 8000) { display('问题请控制在 8000 字以内。', '校园助手'); return; }
  requestId = crypto.randomUUID();
  input.value = '';
  drafts[mode] = '';
  setBusy(true);
  stream.add({ text: query, label: '我', kind: 'user' });
  pendingBubble = stream.add({ text: '正在回复…', label: '智小理', pending: true });
  chatStatus.textContent = mode === 'study' ? '正在请求模型…' : '正在请求校园平台…';
  try { api.campusSend({ requestId, sessionId: currentSession, query, mode }); }
  catch (error) {
    requestId = null;
    setBusy(false);
    finishBubble(error.message, { kind: 'error' });
  }
}
sendButton.addEventListener('click', sendMessage);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); sendMessage(); }
});
newButton.addEventListener('click', async () => {
  replySpeech.stop();
  const generation = ++version;
  requestId = null;
  pendingBubble = null;
  stream.clear();
  ready = false;
  setBusy(true);
  newButton.disabled = true;
  try {
    const result = await api.campusNewConversation(mode);
    if (generation !== version) return;
    if (!result.ok) throw new Error(result.error);
    currentSession = result.session.id;
    ready = true;
    input.value = '';
    if (result.session.lastError) display(result.session.lastError, '智小理');
    input.focus();
  } catch (error) {
    if (generation === version) display(error.message, '校园助手 · 新会话失败');
  } finally {
    if (generation === version) setBusy(false);
    newButton.disabled = false;
  }
});
api.onChatProgress(result => {
  if ((result.mode || 'campus') !== mode || result.requestId !== requestId || result.sessionId !== currentSession) return;
  chatStatus.textContent = result.text;
  if (pendingBubble) pendingBubble = stream.update(pendingBubble, { text: result.text, label: '智小理', pending: true });
});
api.onCampusReply(result => {
  if ((result.mode || 'campus') !== mode) return;
  if (result.requestId !== requestId || result.sessionId !== currentSession) return;
  ++version;
  ready = true;
  requestId = null;
  setBusy(false);
  const answer = window.CampusAnswer.stripThinking(result.answer) || '暂无可展示的正文，请先查询执行结果。';
  // Only the main process's tool-derived summary controls business-result feedback.
  finishBubble(answer, { markdown: true, warning: result.warning, feedback: result.feedback });
  if (result.tools?.length) chatStatus.textContent = '工具：' + [...new Set(result.tools.map(tool => tool.label
    + (tool.requiresUserInput ? '（待确认）' : tool.skipped ? '（未执行）' : tool.ok ? '' : '（失败）')))].join('、');
  if (!window.showPetBusinessFeedback?.(result.feedback)) window.setPetState?.('replying');
  replySpeech.speak(answer);
});
api.onCampusError(result => {
  if ((result.mode || 'campus') !== mode) return;
  if (result.requestId !== requestId || result.sessionId !== currentSession) return;
  ++version;
  ready = true;
  requestId = null;
  setBusy(false);
  const feedback = result.uncertain ? { source: 'transport', status: 'uncertain' } : null;
  finishBubble(result.error, { kind: 'error', feedback });
  if (feedback) window.showPetBusinessFeedback?.(feedback);
});

function applyConfig(config) {
  replySpeech.configure(config.speech);
  document.getElementById('stop-speech-btn').hidden = config.speech?.enabled === false;
  const ui = config.ui || {};
  document.documentElement.style.setProperty('--fs', (Number(ui.font_size) || 13) + 'px');
  if (/^#[0-9a-f]{6}$/i.test(ui.theme_color || '')) {
    document.documentElement.style.setProperty('--theme', ui.theme_color);
  }
  window.syncWindowScale(config.window?.scale || 1);
  if (ui.custom_image) window.setCustomImage?.(ui.custom_image, { noResize: true });
  else window.clearCustomImage?.({ noResize: true });
}
api.onConfigUpdated(config => {
  applyConfig(config);
  const nextUser = config.campus.user || '';
  if (platformUser !== nextUser) {
    platformUser = nextUser;
    if (mode === 'campus') { requestId = null; restoreSession(); }
  }
});
document.getElementById('settings-btn').addEventListener('click', () => api.openSettingsWindow(mode === 'study' ? 'study' : 'campus'));
document.getElementById('stop-speech-btn').addEventListener('click', () => replySpeech.stop());
window.addEventListener('pagehide', () => replySpeech.destroy(), { once: true });
window.addEventListener('portrait-error', event => display(event.detail, '智小理'));
// Markdown links open in the system browser, keeping the desktop pet on its page.
bubble.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!link) return;
  event.preventDefault();
  if (/^https?:\/\//i.test(link.getAttribute('href'))) api.openExternal(link.href);
});
bubble.addEventListener('auxclick', event => {
  if (event.target.closest('a[href]')) event.preventDefault();
});

// Keep the character, bubbles and chat controls independently clickable.
for (const element of [bubble, document.getElementById('chat-area'), document.getElementById('chat-controls'), handle, zoomIn, zoomOut]) {
  element.addEventListener('mouseenter', () => {
    window._chatAreaHover = true;
    api.setIgnoreMouse(false);
  });
  element.addEventListener('mouseleave', () => {
    window._chatAreaHover = false;
    // portrait-pet handles the next pointer move across the character/background.
  });
}
bubble.addEventListener('mouseenter', () => { window._campusBubbleHover = true; });
bubble.addEventListener('mouseleave', () => { window._campusBubbleHover = false; });

function hideHandles() {
  [handle, zoomIn, zoomOut].forEach(element => element.classList.remove('visible'));
}
window.showWindowDragHandle = function () {
  clearTimeout(handleTimer);
  [handle, zoomIn, zoomOut].forEach(element => element.classList.add('visible'));
  handleTimer = setTimeout(() => { if (!dragging) hideHandles(); }, 2500);
};
window.syncWindowScale = function (scale) {
  windowScale = Math.max(0.6, Math.min(1.8, Number(scale) || 1));
  zoomIn.disabled = windowScale >= 1.8;
  zoomOut.disabled = windowScale <= 0.6;
};
function zoom(factor) {
  window.syncWindowScale(windowScale * factor);
  api.windowResize(windowScale);
  scaleLabel.textContent = Math.round(windowScale * 100) + '%';
  scaleLabel.classList.add('visible');
  setTimeout(() => scaleLabel.classList.remove('visible'), 1200);
  window.showWindowDragHandle();
}
zoomIn.addEventListener('click', () => zoom(1.1));
zoomOut.addEventListener('click', () => zoom(1 / 1.1));
handle.addEventListener('mousedown', event => {
  if (event.button !== 0) return;
  event.preventDefault();
  dragging = true;
  window._windowDragActive = true;
  clearTimeout(handleTimer);
  let x = event.screenX, y = event.screenY;
  const move = next => {
    api.windowDrag(next.screenX - x, next.screenY - y);
    x = next.screenX; y = next.screenY;
  };
  const stop = () => {
    dragging = false;
    window._windowDragActive = false;
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', stop);
    window.showWindowDragHandle();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', stop);
});

setBusy(false);
api.getConfig().then(config => {
  configReady = true;
  platformUser = config.campus.user || '';
  mode = config.agent?.mode === 'study' ? 'study' : 'campus';
  modeSelect.value = mode;
  applyConfig(config);
  return restoreSession();
}).catch(error => display(error.message, '校园助手 · 配置加载失败'));
