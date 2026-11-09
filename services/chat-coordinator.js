// Dual-mode request lifecycle, sessions, cancellation and response delivery.
'use strict';
const campusAgent = require('./campus-agent-service');
const { CampusSessionStore } = require('./campus-session-store');
const { StudySessionStore } = require('./agent/study-session-store');
const { LocalAgentRuntime } = require('./agent/local-agent-runtime');
const { createStudyTools } = require('./agent/study-tools');
const { validateConfig: validateStudyConfig } = require('./agent/model-provider');

function registerChatCoordinator({ ipcMain, getMainWebContents, dataDir, config,
  memoryStore, timetableStore, chaoxingStore, debugLog }) {
  const { load: loadConfig, write: writeConfig, study: studyConfig, memory: memoryConfig } = config;
  let campusStore = null, studyStore = null, studyRuntime = null;
  let activeRequest = null, studyRequest = null;
  function store() {
    if (!campusStore) campusStore = new CampusSessionStore(dataDir);
    return campusStore;
  }
  function session() { return store().startNew(String(loadConfig().campus.user || '').trim()); }
  function localStore() {
    if (!studyStore) studyStore = new StudySessionStore(dataDir);
    studyStore.startNew();
    return studyStore;
  }
  function localRuntime() {
    if (!studyRuntime) studyRuntime = new LocalAgentRuntime({ tools: createStudyTools({ getTimetable: timetableStore, getChaoxing: chaoxingStore }) });
    return studyRuntime;
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
      if (event.sender !== getMainWebContents()) throw new Error('请从聊天窗口切换模式。');
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
      if (event.sender !== getMainWebContents()) throw new Error('请从聊天窗口停止请求。');
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
    if (event.sender !== getMainWebContents()) return;
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

  return { cancelCampus: cancelRequest, cancelStudy: cancelStudyRequest,
    stop() { cancelRequest(); cancelStudyRequest(); } };
}
module.exports = { registerChatCoordinator };
