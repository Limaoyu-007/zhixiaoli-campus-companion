// 智小理·校园伴行：desktop lifecycle, windows and dual-mode IPC routing.
'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, screen, dialog, shell, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const campusAgent = require('./services/campus-agent-service');
const memoryService = require('./services/memory-service');
const { CampusTimetableService } = require('./services/campus-timetable-service');
const { CampusDebugLog } = require('./services/campus-debug-log');
const { CampusSessionStore } = require('./services/campus-session-store');
const { CampusTTSService } = require('./services/campus-tts-service');
const { StudySessionStore } = require('./services/agent/study-session-store');
const { LocalAgentRuntime } = require('./services/agent/local-agent-runtime');
const { createStudyTools } = require('./services/agent/study-tools');
const { validateConfig: validateStudyConfig } = require('./services/agent/model-provider');
const { ChaoxingClient } = require('./services/chaoxing/client');
const { ChaoxingError } = require('./services/chaoxing/errors');
const speech = new CampusTTSService();

// Keep the established data directory while replacing the upstream product identity.
// Existing configuration, memories and timetable files must stay available.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'open-desktop-pet'));
}
app.setName('智小理·校园伴行');
const APP_ICON = path.join(__dirname, 'assets', 'brand', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

app.commandLine.appendSwitch('ignore-gpu-blocklist');
let mainWindow = null;
let settingsWindow = null;
let tray = null;
let campusStore = null;
let activeRequest = null;
let memoryReady = false;
let campusTimetable = null;
let campusDebugLog = null;
let studyStore = null;
let studyRequest = null;
let studyRuntime = null;
let chaoxingClient = null;

function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configPath(), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('配置文件无法读取，请检查格式或权限。'); }
  return {
    ...saved,
    campus: { api_key: '', user: '', timeout_seconds: 120, ...saved.campus, enabled: true },
    ui: { font_size: 13, theme_color: '#5B8CFF', layered_portrait: true, ...saved.ui,
      custom_image: saved.ui?.custom_image || pathToFileURL(path.join(__dirname, 'assets', 'zhixiaoli', 'portrait.png')).href },
    window: { scale: 1, ...saved.window },
    speech: { enabled: true, voice: 'zh-CN-XiaoxiaoNeural', rate: 0, ...saved.speech },
    memory: { enabled: true, api_base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      api_key: '', model: 'qwen-flash', context_rounds: 3, ...saved.memory },
    timetable: { api_base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_key: '', model: 'qwen3-vl-plus', ...saved.timetable },
    debug: { enabled: !app.isPackaged, ...saved.debug },
    agent: { mode: saved.agent?.mode === 'study' ? 'study' : 'campus' },
    study: { provider: 'qwen', api_base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      api_key: '', model: 'qwen-plus', timeout_seconds: 120, context_rounds: 12, max_rounds: 6, ...saved.study },
    chaoxing: { enabled: true, phone: '', password_encrypted: '', ...saved.chaoxing },
  };
}
function writeConfig(config) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
}
function publicConfig() {
  const config = loadConfig();
  // Legacy provider settings and credentials are not sent to the campus page.
  return {
    campus: { enabled: true, api_key: '', user: config.campus.user,
      timeout_seconds: config.campus.timeout_seconds, has_api_key: campusAgent.hasApiKey(config.campus) },
    ui: config.ui, window: config.window, speech: config.speech,
    memory: { ...config.memory, api_key: '', has_api_key: Boolean(memoryConfig().api_key) },
    timetable: { api_base: config.timetable.api_base, model: config.timetable.model, api_key: '',
      has_api_key: Boolean(timetableConfig().api_key) },
    debug: { enabled: config.debug.enabled === true },
    agent: config.agent,
    study: { ...config.study, api_key: '', has_api_key: Boolean(studyConfig().api_key) },
    chaoxing: { enabled: config.chaoxing.enabled !== false, phone: config.chaoxing.phone,
      has_password: Boolean(config.chaoxing.password_encrypted),
      uses_environment: Boolean(process.env.CHAOXING_PHONE || process.env.CHAOXING_PASSWORD),
      environment_complete: Boolean(process.env.CHAOXING_PHONE?.trim() && process.env.CHAOXING_PASSWORD) },
  };
}
function store() {
  if (!campusStore) campusStore = new CampusSessionStore(app.getPath('userData'));
  return campusStore;
}
function session() { return store().startNew(String(loadConfig().campus.user || '').trim()); }
function localStore() {
  if (!studyStore) studyStore = new StudySessionStore(app.getPath('userData'));
  studyStore.startNew();
  return studyStore;
}
function studyConfig() {
  const config = loadConfig().study;
  return { ...config, api_key: config.api_key?.trim() || '' };
}
function localRuntime() {
  if (!studyRuntime) studyRuntime = new LocalAgentRuntime({ tools: createStudyTools({ getTimetable: timetableStore, getChaoxing: chaoxingStore }) });
  return studyRuntime;
}
function savedChaoxingPassword(config) {
  if (!config.password_encrypted) return '';
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error();
    return safeStorage.decryptString(Buffer.from(config.password_encrypted, 'base64'));
  } catch (_) { throw new ChaoxingError('CREDENTIAL_DECRYPT_FAILED', '无法解密已保存的学习通密码，请在设置 → 学习通重新保存密码。'); }
}
function chaoxingConfig() {
  const config = loadConfig().chaoxing;
  // Environment credentials are a pair; never combine one account's password with another account.
  if (process.env.CHAOXING_PHONE || process.env.CHAOXING_PASSWORD) return { enabled: config.enabled,
    phone: process.env.CHAOXING_PHONE?.trim() || '', password: process.env.CHAOXING_PASSWORD || '' };
  return { enabled: config.enabled, phone: config.phone, password: config.enabled === false ? '' : savedChaoxingPassword(config) };
}
function chaoxingStore() {
  if (!chaoxingClient) chaoxingClient = new ChaoxingClient(chaoxingConfig);
  return chaoxingClient;
}
function chatMode(value = 'campus') {
  if (!['campus', 'study'].includes(value)) throw new Error('对话模式无效。');
  return value;
}
function sessionView(mode) {
  const current = mode === 'study' ? localStore().get() : session();
  const target = mode === 'study' ? localStore() : store();
  const pending = mode === 'study' ? studyRequest : activeRequest;
  return { ...target.view(current), mode,
    messages: current.messages.slice(-100), requestId: pending?.session.id === current.id ? pending.id : null };
}
function memoryConfig() {
  const config = loadConfig().memory;
  return { ...config, api_key: config.api_key?.trim() || '',
    key_source: 'memory settings', config_file: configPath() };
}
function memoryStore() {
  if (!memoryReady) {
    memoryService.configure({ dataDir: app.getPath('userData'), getConfig: memoryConfig,
      onDiagnostic: debugLog,
      onChange: info => {
        debugLog('memory.state', { summarizing: info.summarizing, pendingCount: info.pendingCount,
          factCount: info.facts.length, lastSummaryAt: info.lastSummaryAt, error: info.lastError || '' });
        if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('campus-memory-updated', info);
      } });
    memoryReady = true;
  }
  return memoryService;
}
function timetableConfig() {
  const config = loadConfig().timetable;
  return { ...config, api_key: config.api_key?.trim() || '' };
}
function timetableStore() {
  if (!campusTimetable) campusTimetable = new CampusTimetableService(app.getPath('userData'), timetableConfig);
  return campusTimetable;
}
function debugStore() {
  if (!campusDebugLog) campusDebugLog = new CampusDebugLog(app.getPath('userData'), {
    getConfig: () => loadConfig().debug,
    getSecrets: () => {
      const config = loadConfig();
      let chaoxingPassword = '';
      try { chaoxingPassword = savedChaoxingPassword(config.chaoxing); } catch (_) {}
      return [campusAgent.getApiKey(config.campus), config.memory.api_key, config.timetable.api_key,
        config.study.api_key, process.env.ZXL_STUDY_API_KEY, process.env.DASHSCOPE_API_KEY, process.env.ZXL_API_KEY,
        chaoxingPassword, config.chaoxing.phone, process.env.CHAOXING_PHONE, process.env.CHAOXING_PASSWORD];
    },
  });
  return campusDebugLog;
}
function debugLog(event, detail) { try { debugStore().write(event, detail); } catch (_) {} }
function requestLog(request, event, detail = {}) {
  debugLog(event, { requestId: request.id, sessionId: request.session.id,
    mode: request.mode || 'campus',
    durationMs: request.startedAt ? Date.now() - request.startedAt : 0, ...detail });
}
function send(request, channel, data) {
  if (!request.sender.isDestroyed()) request.sender.send(channel, {
    requestId: request.id, sessionId: request.session.id, ...data,
    mode: request.mode || 'campus',
  });
}
function cancelRequest() {
  const request = activeRequest;
  if (!request) return;
  activeRequest = null;
  request.controller.abort();
  request.session.pending = false;
  request.session.uncertain = request.sent === true;
  request.session.lastError = request.sent
    ? '已停止等待。远端操作可能仍在执行；涉及预约时请先查询结果。' : '已停止当前请求，尚未发送到校园平台。';
  requestLog(request, 'chat.cancelled', { stage: request.stage, uncertain: request.session.uncertain });
  try { store().save(); } catch (_) { /* Cancellation still takes effect in memory. */ }
  send(request, 'campus-error', { error: request.session.lastError, uncertain: request.session.uncertain });
}

function cancelStudyRequest() {
  const request = studyRequest;
  if (!request) return;
  studyRequest = null;
  request.controller.abort();
  request.session.pending = false;
  request.session.lastError = '已停止通用学习请求。';
  requestLog(request, 'study.cancelled');
  try { localStore().save(); } catch (_) {}
  send(request, 'campus-error', { error: request.session.lastError, uncertain: false });
}
ipcMain.handle('chat-switch-mode', (event, value) => {
  try {
    if (event.sender !== mainWindow?.webContents) throw new Error('请从聊天窗口切换模式。');
    const mode = chatMode(value);
    const view = sessionView(mode);
    const config = loadConfig();
    config.agent.mode = mode;
    writeConfig(config);
    debugLog('chat.mode.changed', { mode });
    return { ok: true, mode, session: view };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('chat-cancel', (event, value) => {
  try {
    if (event.sender !== mainWindow?.webContents) throw new Error('请从聊天窗口停止请求。');
    const mode = chatMode(value);
    if (mode === 'study') cancelStudyRequest(); else cancelRequest();
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('campus-get-session', (_event, value) => {
  try {
    return { ok: true, session: sessionView(chatMode(value)) };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('campus-new-conversation', (_event, value) => {
  try {
    if (chatMode(value) === 'study') {
      cancelStudyRequest();
      localStore().reset();
      debugLog('session.new', { mode: 'study', sessionId: localStore().get().id });
      return { ok: true, session: sessionView('study') };
    }
    cancelRequest();
    const user = session().user;
    const next = store().reset(user, { preserveWarning: true });
    debugLog('session.new', { sessionId: next.id });
    return { ok: true, session: store().view(next) };
  } catch (error) { return { ok: false, error: error.message }; }
});
async function handleStudyMessage(event, payload) {
  const request = { id: payload?.requestId, mode: 'study', sender: event.sender,
    session: { id: payload?.sessionId }, startedAt: Date.now(), stage: 'validation' };
  try {
    if (typeof request.id !== 'string' || !request.id) throw new Error('请求标识无效，请重新发送。');
    const query = typeof payload.query === 'string' ? payload.query.trim() : '';
    if (!query || query.length > 8000) throw new Error('请输入 1 到 8000 字的问题。');
    const current = localStore().get();
    if (current.id !== payload.sessionId) throw new Error('会话已变化，请新建会话后发送。');
    if (studyRequest) throw new Error('通用学习模式上一条消息还在处理中。');
    const config = studyConfig();
    validateStudyConfig(config);
    request.session = current;
    request.controller = new AbortController();
    studyRequest = request;
    current.pending = true;
    current.lastError = '';
    current.messages.push({ role: 'user', content: query, at: Date.now() });
    current.messages = current.messages.slice(-100);
    localStore().save();
    requestLog(request, 'study.received', { userQuery: query, provider: config.provider, model: config.model });
    let memoryContext = '';
    let warning = '';
    if (memoryConfig().enabled !== false) {
      request.stage = 'memory';
      send(request, 'chat-progress', { stage: 'memory', text: '正在读取长期记忆…' });
      try {
        const memory = memoryStore();
        if (!current.turns.length) {
          // The shared summarizer keeps its own persisted backlog across session resets.
          const preparation = await memory.flushSummary(memoryConfig());
          if (preparation.ok === false) warning = '长期记忆整理暂未完成，本轮先参考已有记忆。';
          requestLog(request, 'study.memory.prepared', preparation);
        }
        if (studyRequest !== request) return;
        memoryContext = memory.getMemoryBackground();
        requestLog(request, 'study.memory.context', { injected: Boolean(memoryContext) });
      } catch (error) {
        warning = '长期记忆暂时无法读取，本次先正常对话。';
        requestLog(request, 'study.memory.failed', { error: error.message });
      }
      if (studyRequest !== request) return;
    }
    request.stage = 'runtime';
    const result = await localRuntime().send({ query, history: localStore().history(config.context_rounds), memoryContext, config,
      signal: request.controller.signal,
      onProgress: progress => send(request, 'chat-progress', progress),
      onDiagnostic: (name, detail) => requestLog(request, name, detail) });
    if (studyRequest !== request) return;
    current.pending = false;
    localStore().appendTurn(result.messages, result.trace);
    current.messages.push({ role: 'assistant', content: result.answer, at: Date.now(), tools: result.trace });
    current.messages = current.messages.slice(-100);
    try { localStore().save(); } catch (_) { warning += (warning ? '\n' : '') + '回复已收到，但本轮通用学习会话未能保存到本机。'; }
    if (memoryConfig().enabled !== false) {
      try { memoryStore().appendRound(query, result.answer, memoryConfig()); }
      catch (error) {
        warning += (warning ? '\n' : '') + '本轮长期记忆未能保存，正常回复不受影响。';
        requestLog(request, 'study.memory.append-failed', { error: error.message });
      }
    }
    requestLog(request, 'study.completed', { answer: result.answer, tools: result.trace, warning });
    studyRequest = null;
    send(request, 'campus-reply', { answer: result.answer, warning, tools: result.trace, session: localStore().view(current) });
  } catch (error) {
    if (request.controller && studyRequest !== request) return;
    requestLog(request, 'study.failed', { stage: request.stage, error: error.message });
    if (studyRequest === request) {
      studyRequest = null;
      request.session.pending = false;
      request.session.lastError = error.message;
      try { localStore().save(); } catch (_) {}
    }
    send(request, 'campus-error', { error: error.message, uncertain: false });
  }
}
ipcMain.on('campus-chat-send', async (event, payload) => {
  if (event.sender !== mainWindow?.webContents) return;
  if (payload?.mode === 'study') return handleStudyMessage(event, payload);
  if (payload?.mode !== undefined && payload.mode !== 'campus') return;
  const request = { id: payload?.requestId, sender: event.sender, session: { id: payload?.sessionId }, startedAt: Date.now(), stage: 'validation' };
  try {
    if (typeof request.id !== 'string' || !request.id) throw new Error('请求标识无效，请重新发送。');
    const query = typeof payload.query === 'string' ? payload.query.trim() : '';
    if (!query || query.length > 8000) throw new Error('请输入 1 到 8000 字的问题。');
    const current = session();
    if (current.id !== payload.sessionId) throw new Error('会话已变化，请新建会话后发送。');
    if (activeRequest) throw new Error('上一条消息还在处理中，请等待回复。');
    request.session = current;
    request.controller = new AbortController();
    activeRequest = request;
    requestLog(request, 'chat.received', { userQuery: query, conversationId: current.conversationId || null });
    current.pending = true;
    current.lastError = '';
    current.uncertain = false;
    current.messages.push({ role: 'user', content: query, at: Date.now() });
    current.messages = current.messages.slice(-100);
    store().save();
    let platformQuery = query;
    let memoryWarning = '';
    if (!current.conversationId) {
      request.stage = 'memory';
      try {
        const memory = memoryStore();
        // Finish the previous short dialogue before taking this session's one snapshot.
        // This only calls the separate extraction model, never a business tool.
        const preparation = await memory.flushSummary(memoryConfig());
        platformQuery = memory.getCampusQuery(query);
        requestLog(request, 'memory.prepared', { ...preparation, injected: platformQuery !== query,
          model: memoryConfig().model });
      } catch (error) {
        memoryWarning = '本地记忆暂时无法读取，本次先正常对话。';
        requestLog(request, 'memory.failed', { error: error.message });
      }
      if (activeRequest !== request) return;
    }
    request.stage = 'context';
    try { platformQuery = timetableStore().getCampusQuery(platformQuery); }
    catch (_) {
      platformQuery = timetableStore().getCampusQuery(platformQuery, new Date(), true);
      memoryWarning += (memoryWarning ? '\n' : '') + '本地课表暂时无法读取，本次未附上课表。';
      requestLog(request, 'timetable.failed', { error: '本地课表读取失败' });
    }
    requestLog(request, 'chat.context', { platformQuery, newPlatformConversation: !current.conversationId });
    request.stage = 'platform';
    request.sent = true;
    const result = await campusAgent.send({ query: platformQuery, user: current.user,
      conversationId: current.conversationId, signal: request.controller.signal,
      onDiagnostic: (eventName, detail) => requestLog(request, eventName, detail) }, loadConfig().campus);
    if (activeRequest !== request) return;
    current.conversationId = result.conversationId;
    current.pending = false;
    current.messages.push({ role: 'assistant', content: result.answer, at: Date.now() });
    request.stage = 'storage';
    let warning = memoryWarning;
    try { store().save(); }
    catch (_) { warning += (warning ? '\n' : '') + '回复已收到，但本次会话未能保存。'; }
    try { memoryStore().appendRound(query, result.answer, memoryConfig()); }
    catch (_) { warning += (warning ? '\n' : '') + '本轮长期记忆未能保存，正常回复不受影响。'; }
    requestLog(request, 'chat.completed', { answer: result.answer, conversationId: result.conversationId,
      feedback: result.feedback, warning });
    activeRequest = null;
    send(request, 'campus-reply', { answer: result.answer, feedback: result.feedback, warning, session: store().view(current) });
  } catch (error) {
    if (request.controller && activeRequest !== request) return;
    requestLog(request, 'chat.failed', { stage: request.stage, error: error.message, uncertain: error.uncertain === true });
    if (activeRequest === request) {
      activeRequest = null;
      request.session.pending = false;
      request.session.lastError = error.message;
      request.session.uncertain = error.uncertain === true;
      try { store().save(); } catch (_) { /* Display the failure regardless of disk state. */ }
    }
    send(request, 'campus-error', { error: error.message, uncertain: error.uncertain === true });
  }
});

ipcMain.handle('get-config', () => publicConfig());
// Plaintext keys belong only to the local settings editor, never chat/broadcast payloads.
ipcMain.handle('settings-get-config', event => {
  if (event.sender !== settingsWindow?.webContents) throw new Error('请从设置窗口读取配置。');
  const config = loadConfig();
  const result = publicConfig();
  for (const section of ['campus', 'study', 'memory', 'timetable']) result[section].api_key = config[section].api_key || '';
  return result;
});
ipcMain.handle('campus-debug-info', () => {
  try { return { ok: true, ...debugStore().info() }; }
  catch (_) { return { ok: false, error: '无法读取调试日志状态。' }; }
});
ipcMain.handle('campus-debug-open', async () => {
  try {
    const directory = debugStore().directory;
    fs.mkdirSync(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error();
    return { ok: true };
  } catch (_) { return { ok: false, error: '无法打开日志目录。' }; }
});
ipcMain.handle('campus-debug-export', async () => {
  try {
    const result = await dialog.showSaveDialog(settingsWindow || mainWindow, { title: '导出对话调试日志',
      defaultPath: '智小理-对话调试-' + new Date().toISOString().slice(0, 10) + '.jsonl',
      filters: [{ name: 'JSON Lines 日志', extensions: ['jsonl'] }] });
    if (result.canceled || !result.filePath) return { ok: true, cancelled: true };
    const content = debugStore().snapshot();
    const target = path.resolve(result.filePath);
    const liveFiles = [debugStore().file, debugStore().file + '.1', debugStore().file + '.2', configPath()];
    if (liveFiles.some(file => path.resolve(file).toLowerCase() === target.toLowerCase()) ||
        path.dirname(target).toLowerCase() === app.getPath('userData').toLowerCase()) throw new Error('请选择数据目录以外的导出位置。');
    fs.writeFileSync(target, content, 'utf8');
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message || '日志导出失败。' }; }
});
// Only the local settings editor may access source bytes or submit recognition requests.
function timetableIPC(channel, callback) {
  ipcMain.handle(channel, async (event, payload) => {
    const startedAt = Date.now();
    const traceParse = channel === 'campus-timetable-parse';
    try {
      if (event.sender !== settingsWindow?.webContents) throw new Error('请从设置中的“我的课表”操作。');
      if (traceParse) debugLog('timetable.parse.started', { sourceId: payload?.sourceId,
        model: timetableConfig().model, pages: payload?.images?.length });
      const result = await callback(payload);
      if (traceParse) debugLog('timetable.parse.completed', { sourceId: payload?.sourceId,
        durationMs: Date.now() - startedAt, coursesCount: result.table.courses.length, warnings: result.warnings });
      return { ok: true, ...result };
    } catch (error) {
      if (traceParse) debugLog('timetable.parse.failed', { sourceId: payload?.sourceId, durationMs: Date.now() - startedAt, error: error.message });
      return { ok: false, error: error.message };
    }
  });
}
timetableIPC('campus-timetable-get', () => timetableStore().view());
timetableIPC('campus-timetable-select', async () => {
  const result = await dialog.showOpenDialog(settingsWindow, { title: '导入个人课表', properties: ['openFile'],
    filters: [{ name: '课表图片或 PDF', extensions: ['png', 'jpg', 'jpeg', 'webp', 'pdf'] }] });
  if (result.canceled || !result.filePaths.length) return { cancelled: true };
  return { source: timetableStore().select(result.filePaths[0]) };
});
timetableIPC('campus-timetable-source', () => ({ source: timetableStore().source() }));
timetableIPC('campus-timetable-parse', payload => timetableStore().parse(payload));
timetableIPC('campus-timetable-save', payload => timetableStore().save(payload));
timetableIPC('campus-timetable-clear', () => timetableStore().clear());
timetableIPC('campus-timetable-cancel', () => { campusTimetable?.cancel(); return {}; });
ipcMain.handle('campus-memory-get', () => {
  try { return { ok: true, memory: memoryStore().getMemoryInfo() }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('campus-memory-update', (_event, data) => {
  try { return { ok: true, memory: memoryStore().updateMemory(data) }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('campus-memory-clear', () => {
  try { memoryStore().clearMemory(); return { ok: true, memory: memoryStore().getMemoryInfo() }; }
  catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.handle('campus-memory-summarize', async () => {
  try {
    const memory = memoryStore();
    const result = await memory.flushSummary(memoryConfig());
    return { ...result, memory: memory.getMemoryInfo() };
  } catch (error) { return { ok: false, error: error.message }; }
});
ipcMain.on('speech-stop', () => speech.stop());
ipcMain.handle('speech-synthesize', async (_event, text) => {
  try {
    const config = loadConfig().speech;
    if (!config.enabled) return { ok: false, cancelled: true };
    if (typeof text !== 'string' || !text.trim() || text.length > 6100) throw new Error('朗读文本长度无效。');
    return { ok: true, audio: await speech.synthesize(text, config) };
  } catch (error) { return { ok: false, cancelled: Boolean(error.cancelled), error: error.message }; }
});
ipcMain.handle('save-config', (_event, patch = {}) => {
  try {
    if (_event.sender !== settingsWindow?.webContents) throw new Error('请从设置窗口保存配置。');
    const config = loadConfig();
    const oldUser = config.campus.user;
    const oldChaoxing = JSON.stringify(config.chaoxing);
    if (patch.campus) {
      config.campus.user = String(patch.campus.user || '').trim();
      config.campus.timeout_seconds = Math.max(10, Math.min(300, Number(patch.campus.timeout_seconds) || 120));
      if (typeof patch.campus.api_key === 'string') config.campus.api_key = patch.campus.api_key.trim();
    }
    if (patch.ui) {
      config.ui.font_size = Math.max(11, Math.min(20, Number(patch.ui.font_size) || 13));
      if (/^#[0-9a-f]{6}$/i.test(patch.ui.theme_color || '')) config.ui.theme_color = patch.ui.theme_color;
      if (typeof patch.ui.custom_image === 'string') config.ui.custom_image = patch.ui.custom_image;
      if (typeof patch.ui.layered_portrait === 'boolean') config.ui.layered_portrait = patch.ui.layered_portrait;
    }
    if (patch.speech) {
      speech.stop();
      config.speech = {
        enabled: patch.speech.enabled !== false,
        voice: patch.speech.voice === 'zh-CN-YunxiNeural' ? patch.speech.voice : 'zh-CN-XiaoxiaoNeural',
        rate: Math.max(-30, Math.min(30, Number(patch.speech.rate) || 0)),
      };
    }
    if (patch.memory) {
      const input = patch.memory;
      const base = String(input.api_base || '').trim().replace(/\/+$/, '');
      const url = new URL(base);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
        throw new Error('百炼接口地址须为不含账号、查询参数的HTTPS地址。');
      }
      const model = String(input.model || '').trim();
      if (!model || model.length > 120) throw new Error('请填写有效的记忆整理模型名称。');
      config.memory = { ...config.memory, enabled: input.enabled !== false,
        api_base: base, model, context_rounds: Math.max(1, Math.min(20, Math.round(Number(input.context_rounds) || 3))) };
      if (typeof input.api_key === 'string') config.memory.api_key = input.api_key.trim();
    }
    if (patch.timetable) {
      const input = patch.timetable;
      const base = String(input.api_base || '').trim().replace(/\/+$/, '');
      if (base) {
        const url = new URL(base);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('百炼接口地址须为不含账号、查询参数的HTTPS地址。');
      }
      const model = String(input.model || '').trim();
      if (!model || model.length > 120) throw new Error('请填写有效的课表视觉模型名称。');
      config.timetable = { ...config.timetable, api_base: base, model };
      if (typeof input.api_key === 'string') config.timetable.api_key = input.api_key.trim();
    }
    if (patch.debug) config.debug = { enabled: patch.debug.enabled === true };
    if (patch.study) {
      const input = patch.study;
      const next = { ...config.study, provider: String(input.provider || 'custom'),
        api_base: String(input.api_base || '').trim().replace(/\/+$/, ''), model: String(input.model || '').trim(),
        timeout_seconds: Math.max(10, Math.min(300, Math.round(Number(input.timeout_seconds) || 120))),
        context_rounds: Math.max(1, Math.min(30, Math.round(Number(input.context_rounds) || 12))),
        max_rounds: Math.max(1, Math.min(8, Math.round(Number(input.max_rounds) || 6))) };
      validateStudyConfig(next);
      if (typeof input.api_key === 'string') next.api_key = input.api_key.trim();
      config.study = next;
    }
    if (patch.chaoxing) {
      if (_event.sender !== settingsWindow?.webContents) throw new Error('请从设置窗口保存学习通账号。');
      const input = patch.chaoxing;
      const phone = String(input.phone || '').trim();
      if (phone.length > 80 || /[\x00-\x20]/.test(phone)) throw new Error('请填写有效的学习通手机号或账号。');
      const next = { enabled: input.enabled !== false, phone,
        password_encrypted: phone === config.chaoxing.phone ? config.chaoxing.password_encrypted : '' };
      if (input.clear_password === true) next.password_encrypted = '';
      if (typeof input.password === 'string' && input.password) {
        if (!phone) throw new Error('保存学习通密码前请先填写账号。');
        if (input.password.length > 256) throw new Error('学习通密码长度无效。');
        if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) {
          throw new Error('当前系统安全存储不可用，请改用 CHAOXING_PHONE 和 CHAOXING_PASSWORD 环境变量。');
        }
        next.password_encrypted = safeStorage.encryptString(input.password).toString('base64');
      }
      config.chaoxing = next;
    }
    writeConfig(config);
    debugLog('settings.saved', { configurationFile: configPath(),
      sections: Object.keys(patch).filter(key => ['campus', 'study', 'chaoxing', 'memory', 'timetable', 'ui', 'speech', 'debug'].includes(key)) });
    if (patch.memory && memoryReady) memoryService.cancelSummary();
    if (patch.timetable || patch.memory) campusTimetable?.cancel();
    if (oldUser !== config.campus.user) cancelRequest();
    if (oldChaoxing !== JSON.stringify(config.chaoxing)) { cancelStudyRequest(); chaoxingClient?.reset(); }
    const updated = publicConfig();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('config-updated', updated);
    return { ok: true, config: updated };
  } catch (error) {
    debugLog('settings.failed', { error: error.message });
    return { ok: false, error: error.message };
  }
});

function placeWindow(scale, preservePosition = true) {
  if (!mainWindow) return;
  const config = loadConfig();
  const normalized = Math.max(0.6, Math.min(1.8, Number(scale) || 1));
  const area = screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  const width = Math.min(area.width, Math.max(360, Math.round(560 * normalized)));
  const height = Math.min(area.height, Math.max(540, Math.round(800 * normalized)));
  const old = mainWindow.getBounds();
  const x = preservePosition ? old.x + old.width - width : area.x + area.width - width - 16;
  const y = preservePosition ? old.y + old.height - height : area.y + area.height - height - 16;
  mainWindow.setResizable(true);
  mainWindow.setBounds({ x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)), width, height });
  mainWindow.setResizable(false);
  config.window = { ...config.window, scale: normalized };
  writeConfig(config);
}
ipcMain.on('set-ignore-mouse', (_event, ignore) => mainWindow?.setIgnoreMouseEvents(Boolean(ignore), { forward: true }));
ipcMain.on('window-drag', (_event, dx, dy) => {
  if (!mainWindow || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
});
ipcMain.on('window-resize', (_event, scale) => placeWindow(scale));
// Uploaded pictures use the same reserved character area; do not shrink the reply/input space.
ipcMain.handle('resize-to-content', () => ({ ok: true, scale: loadConfig().window.scale }));
ipcMain.handle('choose-custom-image', async () => {
  try {
    const result = await dialog.showOpenDialog(settingsWindow || mainWindow, {
      title: '选择校园助手形象', properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }],
    });
    return result.canceled || !result.filePaths.length ? { ok: false, error: '已取消' }
      : { ok: true, url: pathToFileURL(result.filePaths[0]).href };
  } catch (error) { return { ok: false, error: error.message }; }
});

function openSettings(section = 'campus') {
  section = typeof section === 'string' ? section : 'campus';
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus(); settingsWindow.webContents.send('settings-section', section); return;
  }
  settingsWindow = new BrowserWindow({ width: 1100, height: 800, minWidth: 760, minHeight: 580, icon: APP_ICON,
    title: '智小理设置', autoHideMenuBar: true, alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'campus-settings.html'), { query: { section } });
  settingsWindow.on('closed', () => { campusTimetable?.release(); settingsWindow = null; });
}
ipcMain.on('open-settings-window', (_event, section) => openSettings(section));
function openTimetable() {
  openSettings('timetable');
}
ipcMain.on('open-timetable-window', openTimetable);
ipcMain.handle('open-external', async (_event, value) => {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return { ok: false };
    await shell.openExternal(url.href);
    return { ok: true };
  } catch (_) { return { ok: false }; }
});
ipcMain.on('quit-app', () => app.quit());
ipcMain.on('show-context-menu', () => {
  if (!mainWindow) return;
  Menu.buildFromTemplate([
    { label: '智小理设置', click: openSettings },
    { label: '我的课表', click: openTimetable },
    { label: '置顶', type: 'checkbox', checked: mainWindow.isAlwaysOnTop(), click: item => mainWindow.setAlwaysOnTop(item.checked) },
    { label: '重置位置', click: () => placeWindow(loadConfig().window.scale, false) },
    { type: 'separator' },
    { label: '表情', submenu: [
      ...[['认真倾听', 'attentive'], ['轻轻开心', 'happy'], ['温柔', 'gentle'], ['疑惑', 'curious'], ['关心', 'concerned']]
        .map(([label, name]) => ({ label, click: () => mainWindow.webContents.send('portrait-action', 'face-' + name) })),
    ] },
    { label: '动作', submenu: [
      ...[['挥挥手', 'wave'], ['开心弹跳', 'bounce'], ['轻轻摇摆', 'sway'], ['点头回应', 'nod'], ['眨眨眼', 'blink']]
        .map(([label, name]) => ({ label, click: () => mainWindow.webContents.send('portrait-action', name) })),
      { type: 'separator' },
      { label: '恢复待机', click: () => mainWindow.webContents.send('portrait-action', 'reset') },
    ] },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]).popup({ window: mainWindow });
});

app.whenReady().then(() => {
  debugLog('app.started', { version: app.getVersion(), packaged: app.isPackaged, configurationFile: configPath() });
  mainWindow = new BrowserWindow({ width: 560, height: 800, transparent: true, frame: false, icon: APP_ICON,
    alwaysOnTop: true, resizable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  placeWindow(loadConfig().window.scale, false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; app.quit(); });
  try {
    tray = new Tray(APP_ICON);
    tray.setToolTip('智小理');
    tray.on('click', () => mainWindow?.show());
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示智小理', click: () => mainWindow?.show() },
      { label: '设置', click: openSettings },
      { label: '我的课表', click: openTimetable },
      { label: '退出', click: () => app.quit() },
    ]));
  } catch (_) { /* The main window remains available without a tray icon. */ }
});
app.on('before-quit', () => { cancelRequest(); cancelStudyRequest(); chaoxingClient?.reset(); speech.stop(); memoryService.cancelSummary(); campusTimetable?.release(); });
app.on('window-all-closed', () => app.quit());
