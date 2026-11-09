// 智小理·校园陪伴：desktop lifecycle, windows and dual-mode IPC routing.
'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, screen, dialog, shell, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const campusAgent = require('./services/campus-agent-service');
const memoryService = require('./services/memory-service');
const { CampusTimetableService } = require('./services/campus-timetable-service');
const { CampusDebugLog } = require('./services/campus-debug-log');
const { CampusTTSService } = require('./services/campus-tts-service');
const { ChaoxingClient } = require('./services/chaoxing/client');
const { createAppConfig } = require('./services/app-config');
const { registerChatCoordinator } = require('./services/chat-coordinator');
const speech = new CampusTTSService({ packaged: app.isPackaged });

// Keep the established data directory while replacing the upstream product identity.
// Existing configuration, memories and timetable files must stay available.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'open-desktop-pet'));
}
app.setName('智小理·校园陪伴');
// Acquire the lock after selecting userData, before any configuration or
// session writes. A duplicate process must not initialize the application.
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  return;
}
const APP_ICON = path.join(__dirname, 'assets', 'brand', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

app.commandLine.appendSwitch('ignore-gpu-blocklist');
let mainWindow = null;
let settingsWindow = null;
let tray = null;
let memoryReady = false;
let campusTimetable = null;
let campusDebugLog = null;
let chaoxingClient = null;
let pendingActivation = false;
let settingsAfterRecovery = false;

function activateExistingWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingActivation = true;
    return;
  }
  pendingActivation = false;
  stopPetWalking();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  // Keep an already-open settings editor in front without reloading its draft.
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
  }
}
app.on('second-instance', activateExistingWindow);

const applicationConfig = createAppConfig({ root: __dirname, dataDir: app.getPath('userData'),
  packaged: app.isPackaged, safeStorage, isSpeechAvailable: () => speech.isAvailable() });
const { load: loadConfig, write: writeConfig, path: configPath, store: configStore,
  initial: initialConfig, public: publicConfig, memory: memoryConfig, timetable: timetableConfig,
  chaoxing: chaoxingConfig, savedChaoxingPassword } = applicationConfig;

async function prepareConfiguration() {
  try { loadConfig(); return true; }
  catch (_) {
    const storage = configStore();
    let backup = null;
    try { backup = storage.readBackup(); } catch (_) {}
    const buttons = backup ? ['恢复上一份配置', '重新配置', '退出'] : ['重新配置', '退出'];
    const result = await dialog.showMessageBox({ type: 'warning', title: '智小理配置需要恢复',
      message: '本机配置无法读取或格式损坏。',
      detail: `配置位置：${configPath()}\n恢复或重新配置前会保留原文件。重新配置将使用安装包初始设置，已清空的凭据也会恢复为初始值；聊天记录、记忆和课表不会删除。`,
      buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true });
    if (result.response === buttons.length - 1) return false;
    const restoringBackup = backup && result.response === 0;
    storage.recover(restoringBackup ? backup : initialConfig());
    settingsAfterRecovery = !restoringBackup;
    loadConfig();
    return true;
  }
}
function chaoxingStore() {
  if (!chaoxingClient) chaoxingClient = new ChaoxingClient(chaoxingConfig);
  return chaoxingClient;
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
const chat = registerChatCoordinator({ ipcMain, getMainWebContents: () => mainWindow?.webContents,
  dataDir: app.getPath('userData'), config: applicationConfig,
  memoryStore, timetableStore, chaoxingStore, debugLog });

ipcMain.handle('get-config', () => publicConfig());
// Plaintext keys belong only to the local settings editor, never chat/broadcast payloads.
ipcMain.handle('settings-get-config', event => {
  if (event.sender !== settingsWindow?.webContents) throw new Error('请从设置窗口读取配置。');
  return applicationConfig.settings();
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
ipcMain.handle('save-config', (event, patch = {}) => {
  try {
    if (event.sender !== settingsWindow?.webContents) throw new Error('请从设置窗口保存配置。');
    const changed = applicationConfig.update(patch);
    debugLog('settings.saved', { configurationFile: configPath(),
      sections: changed.sections });
    if (changed.speechChanged) speech.stop();
    if (changed.memoryChanged && memoryReady) memoryService.cancelSummary();
    if (changed.timetableChanged) campusTimetable?.cancel();
    if (changed.userChanged) chat.cancelCampus();
    if (changed.chaoxingChanged) { chat.cancelStudy(); chaoxingClient?.reset(); }
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
let ignoringPetMouse = true;
ipcMain.on('set-ignore-mouse', (event, ignore) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  const next = Boolean(ignore);
  if (next === ignoringPetMouse) return;
  ignoringPetMouse = next;
  mainWindow.setIgnoreMouseEvents(next, { forward: true });
});
let petWalkTimer = null;
function stopPetWalking() {
  if (!petWalkTimer) return;
  clearInterval(petWalkTimer);
  petWalkTimer = null;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pet-walking-state', { walking: false });
}
ipcMain.on('pet-walking', (event, direction) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  stopPetWalking();
  if (direction !== -1 && direction !== 1) return;
  let last = Date.now(), remainder = 0;
  const scale = Number(loadConfig().window.scale) || 1;
  mainWindow.webContents.send('pet-walking-state', { walking: true, direction });
  petWalkTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) { stopPetWalking(); return; }
    const now = Date.now(), bounds = mainWindow.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    remainder += Math.min(now - last, 100) / 1000 * 60 * scale;
    last = now;
    const step = Math.floor(remainder);
    remainder -= step;
    const maxX = Math.max(area.x, area.x + area.width - bounds.width);
    const x = Math.max(area.x, Math.min(maxX, bounds.x + step * direction));
    if (x !== bounds.x) mainWindow.setPosition(x, bounds.y, false);
    if ((direction < 0 && x === area.x) || (direction > 0 && x === maxX)) stopPetWalking();
  }, 33);
});
ipcMain.on('window-drag', (_event, dx, dy) => {
  if (!mainWindow || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
  stopPetWalking();
  const [x, y] = mainWindow.getPosition();
  const nextX = Math.round(x + dx), nextY = Math.round(y + dy);
  if (nextX !== x || nextY !== y) mainWindow.setPosition(nextX, nextY, false);
});
function resizeWindowSafely(scale, preservePosition = true) {
  try { placeWindow(scale === undefined ? loadConfig().window.scale : scale, preservePosition); }
  catch (_) { dialog.showErrorBox('窗口设置未能保存', '请检查数据目录权限及磁盘空间。当前聊天仍可继续。'); }
}
ipcMain.on('window-resize', (_event, scale) => resizeWindowSafely(scale));
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
    { label: '重置位置', click: () => resizeWindowSafely(undefined, false) },
    { type: 'separator' },
    { label: '表情', submenu: [
      ...[['认真倾听', 'attentive'], ['轻轻开心', 'happy'], ['温柔', 'gentle'], ['疑惑', 'curious'], ['关心', 'concerned']]
        .map(([label, name]) => ({ label, click: () => mainWindow.webContents.send('portrait-action', 'face-' + name) })),
    ] },
    { label: '动作', submenu: [
      { label: '向左走', click: () => mainWindow.webContents.send('portrait-action', 'walk-left') },
      { label: '向右走', click: () => mainWindow.webContents.send('portrait-action', 'walk-right') },
      { label: '停止走动', click: stopPetWalking },
      { label: '口型预览（闭口→半开→张口）', click: () => {
        stopPetWalking();
        mainWindow.webContents.send('portrait-action', 'mouth-preview');
      } },
      ...[['开心弹跳', 'bounce'], ['轻轻摇摆', 'sway'], ['点头回应', 'nod'], ['眨眨眼', 'blink']]
        .map(([label, name]) => ({ label, click: () => mainWindow.webContents.send('portrait-action', name) })),
      { type: 'separator' },
      { label: '恢复待机', click: () => mainWindow.webContents.send('portrait-action', 'reset') },
    ] },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]).popup({ window: mainWindow });
});

app.whenReady().then(async () => {
  if (!await prepareConfiguration()) { app.quit(); return; }
  debugLog('app.started', { version: app.getVersion(), packaged: app.isPackaged, configurationFile: configPath() });
  mainWindow = new BrowserWindow({ width: 560, height: 800, transparent: true, frame: false, icon: APP_ICON,
    alwaysOnTop: true, resizable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  placeWindow(loadConfig().window.scale, false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.webContents.on('did-start-loading', stopPetWalking);
  mainWindow.setIgnoreMouseEvents(true, { forward: true });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; stopPetWalking(); app.quit(); });
  if (pendingActivation) activateExistingWindow();
  if (settingsAfterRecovery) openSettings();
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
}).catch(() => {
  dialog.showErrorBox('智小理未能启动', `无法初始化配置或窗口，请检查数据目录权限及磁盘空间。\n数据目录：${app.getPath('userData')}\n原有聊天记录、记忆和课表未清空。`);
  app.quit();
});
app.on('before-quit', () => { chat.stop(); chaoxingClient?.reset(); speech.stop(); memoryService.cancelSummary(); campusTimetable?.release(); });
app.on('window-all-closed', () => app.quit());
