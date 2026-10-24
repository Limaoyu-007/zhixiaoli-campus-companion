// Campus settings: one save action for all configuration and edited profile fields.
'use strict';
const api = window.electronAPI;
const field = id => document.getElementById(id);
let image = '', loaded = false, configDirty = false, memoryDirty = false;
let saving = false, memoryBusy = false, currentMemory = null;
const dirty = () => configDirty || memoryDirty;
function message(detail = '', error = false) {
  field('save-state').textContent = saving ? '正在保存…' : dirty() ? '有未保存的更改' : loaded ? '当前更改已保存' : '正在读取设置…';
  field('save-detail').textContent = detail;
  field('status').classList.toggle('error', error);
}
function markConfigDirty() { configDirty = true; message('点击右侧“保存更改”后生效。'); }
function controls() {
  field('save').disabled = !loaded || saving || memoryBusy;
  field('save').textContent = saving ? '正在保存…' : '保存更改';
  for (const element of document.querySelectorAll('main input, main select, main textarea')) element.disabled = !loaded || saving;
  for (const id of ['memory-facts', 'memory-summary']) field(id).disabled = !loaded || !currentMemory || saving || memoryBusy;
  for (const id of ['memory-clear', 'memory-refresh']) field(id).disabled = saving || memoryBusy || !currentMemory;
  field('memory-summarize').disabled = saving || memoryBusy || !currentMemory || currentMemory.summarizing;
  for (const id of ['choose-image', 'reset-image', 'debug-open', 'debug-export', 'debug-refresh']) field(id).disabled = !loaded || saving;
}
function selectSection(section) {
  const tab = [...document.querySelectorAll('[data-tab]')].find(item => item.dataset.tab === section);
  if (!tab) return;
  for (const item of document.querySelectorAll('[data-tab]')) {
    if (item === tab) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  }
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== section;
  document.querySelector('main').scrollTop = 0;
  if (section === 'debug') void refreshDebug();
}
for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => selectSection(tab.dataset.tab));
api.onSettingsSection(selectSection);
selectSection(new URLSearchParams(location.search).get('section') || 'campus');
function preview() {
  field('image-preview').hidden = !image;
  if (image) field('image-preview').src = image; else field('image-preview').removeAttribute('src');
}
function credentialStatus(config) {
  field('key-status').textContent = config.campus.has_api_key ? '已有校园接口凭据，留空沿用。' : '尚未配置校园接口凭据。';
  field('memory-key-status').textContent = config.memory.has_api_key ? '已有百炼凭据，留空沿用。' : '尚未配置百炼凭据，填写后点击“保存更改”。';
  field('timetable-key-status').textContent = config.timetable.has_api_key ? '已有可沿用的百炼凭据，留空即可。' : '尚未配置，请在此处或长期记忆中填写，并保存更改。';
  field('study-key-status').textContent = config.study.has_api_key ? '已有通用学习凭据，留空沿用。独立于校园和记忆模型配置。' : '尚未配置通用学习凭据，请填写并保存。';
  field('chaoxing-status').textContent = config.chaoxing.uses_environment
    ? config.chaoxing.environment_complete ? '查询将使用环境变量中的账号密码。' : '环境变量不完整：请同时设置 CHAOXING_PHONE 和 CHAOXING_PASSWORD。'
    : config.chaoxing.has_password ? '已保存加密密码，留空沿用；账号密码仅在查询时读取。' : '尚未保存学习通密码，请填写后点击“保存更改”。';
}
api.getConfig().then(config => {
  field('platform-user').value = config.campus.user || '';
  field('timeout').value = config.campus.timeout_seconds || 120;
  field('font-size').value = config.ui.font_size || 13;
  field('theme').value = config.ui.theme_color || '#5b8cff';
  field('portrait-renderer').value = config.ui.layered_portrait !== false ? 'layered' : 'portrait';
  field('speech-enabled').checked = config.speech?.enabled !== false;
  field('speech-voice').value = config.speech?.voice || 'zh-CN-XiaoxiaoNeural';
  field('speech-rate').value = config.speech?.rate || 0;
  const memory = config.memory || {};
  field('memory-enabled').checked = memory.enabled !== false;
  field('memory-base').value = memory.api_base || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  field('memory-model').value = memory.model || 'qwen-flash';
  field('memory-rounds').value = memory.context_rounds || 3;
  field('timetable-base').value = config.timetable.api_base || '';
  field('timetable-model').value = config.timetable.model || 'qwen3-vl-plus';
  field('debug-enabled').checked = config.debug?.enabled === true;
  const study = config.study;
  field('study-provider').value = study.provider;
  field('study-base').value = study.api_base;
  field('study-model').value = study.model;
  field('study-timeout').value = study.timeout_seconds;
  field('study-context-rounds').value = study.context_rounds;
  field('study-max-rounds').value = study.max_rounds;
  field('chaoxing-enabled').checked = config.chaoxing.enabled !== false;
  field('chaoxing-phone').value = config.chaoxing.phone || '';
  credentialStatus(config);
  image = config.ui.custom_image || ''; preview(); loaded = true; message(); controls();
}).catch(error => message(error.message, true));
field('open-timetable').addEventListener('click', () => api.openTimetableWindow());
field('study-provider').addEventListener('change', () => {
  const preset = { qwen: ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-plus'],
    deepseek: ['https://api.deepseek.com', 'deepseek-flash'] }[field('study-provider').value];
  if (preset) { field('study-base').value = preset[0]; field('study-model').value = preset[1]; }
  field('study-key').value = '';
  field('study-clear-key').checked = true;
  markConfigDirty();
});
field('choose-image').addEventListener('click', async () => {
  try {
    const result = await api.chooseCustomImage();
    if (!result.ok) { if (result.error !== '已取消') message(result.error, true); return; }
    image = result.url; preview(); markConfigDirty();
  } catch (error) { message(error.message, true); }
});
field('reset-image').addEventListener('click', () => { image = ''; preview(); markConfigDirty(); });
for (const element of document.querySelectorAll('main input, main select, main textarea')) {
  if (['memory-facts', 'memory-summary'].includes(element.id)) element.addEventListener('input', () => { memoryDirty = true; message('学生资料和配置将一起保存。'); });
  else element.addEventListener('input', markConfigDirty);
}
function editedMemory() {
  const keys = new Set();
  const facts = field('memory-facts').value.split(/\r?\n/).filter(line => line.trim()).map(line => {
    const match = line.match(/^([^:：]+)[:：](.+)$/);
    if (!match) throw new Error('每项学生资料请填写为“字段：内容”。');
    const key = match[1].trim(), value = match[2].trim();
    if (!currentMemory?.factKeys.includes(key) || keys.has(key) || !value || value.length > 160) throw new Error('学生资料字段不正确、重复或超过160字，请检查后保存。');
    keys.add(key); return { key, value };
  });
  const summary = field('memory-summary').value;
  if (facts.length > 15 || summary.length > 300) throw new Error('学生资料最多15条，近期摘要最多300字。');
  return { facts, summary };
}
async function saveAll() {
  if (!loaded || saving || memoryBusy) return false;
  saving = true; controls(); message();
  let configSaved = false;
  try {
    const profile = memoryDirty ? editedMemory() : null;
    const result = await api.saveConfig({
      campus: { api_key: field('api-key').value.trim(), user: field('platform-user').value.trim(), timeout_seconds: field('timeout').value },
      ui: { custom_image: image, font_size: field('font-size').value, theme_color: field('theme').value,
        layered_portrait: field('portrait-renderer').value === 'layered' },
      speech: { enabled: field('speech-enabled').checked, voice: field('speech-voice').value, rate: field('speech-rate').value },
      memory: { enabled: field('memory-enabled').checked, api_key: field('memory-key').value.trim(), api_base: field('memory-base').value.trim(),
        model: field('memory-model').value.trim(), context_rounds: field('memory-rounds').value },
      timetable: { api_key: field('timetable-key').value.trim(), api_base: field('timetable-base').value.trim(), model: field('timetable-model').value.trim() },
      debug: { enabled: field('debug-enabled').checked },
      study: { provider: field('study-provider').value, api_base: field('study-base').value.trim(),
        api_key: field('study-key').value.trim(), clear_api_key: field('study-clear-key').checked,
        model: field('study-model').value.trim(), timeout_seconds: field('study-timeout').value,
        context_rounds: field('study-context-rounds').value, max_rounds: field('study-max-rounds').value },
      chaoxing: { enabled: field('chaoxing-enabled').checked, phone: field('chaoxing-phone').value.trim(),
        password: field('chaoxing-password').value, clear_password: field('chaoxing-clear-password').checked },
    });
    if (!result.ok) throw new Error(result.error);
    configSaved = true; configDirty = false;
    for (const id of ['api-key', 'memory-key', 'timetable-key', 'study-key', 'chaoxing-password']) field(id).value = '';
    field('study-clear-key').checked = false;
    field('chaoxing-clear-password').checked = false;
    credentialStatus(result.config);
    if (profile) {
      const updated = await api.campusUpdateMemory(profile);
      if (!updated.ok) throw new Error(updated.error);
      renderMemory(updated.memory, true);
    }
    saving = false; message(profile ? '配置及学生资料已保存。修改后的记忆在新会话使用。' : '所有设置已保存。');
    void refreshDebug();
    return true;
  } catch (error) {
    saving = false;
    message((configSaved && memoryDirty ? '配置已保存，学生资料未保存：' : '保存失败：') + error.message, true);
    return false;
  } finally { saving = false; controls(); }
}
field('save').addEventListener('click', () => { void saveAll(); });
function renderMemory(info, force = false) {
  currentMemory = info;
  if (!memoryDirty || force) {
    field('memory-facts').value = info.facts.map(item => item.key + '：' + item.value).join('\n');
    field('memory-summary').value = info.summary; memoryDirty = false;
  }
  field('memory-fact-keys').textContent = '可用字段：' + info.factKeys.join('、') + '。';
  field('memory-info').textContent = '已记录 ' + info.facts.length + ' 项资料，待整理约 ' + Math.ceil(info.pendingCount / 2) + ' 轮。'
    + (info.lastSummaryAt ? ' 上次更新：' + new Date(info.lastSummaryAt).toLocaleString('zh-CN') : '');
  field('memory-status').textContent = info.summarizing ? '正在后台整理。' : info.lastError || '';
  controls();
}
async function refreshMemory(force = false) {
  if (force && memoryDirty && !window.confirm('重新读取会放弃未保存的学生资料修改，是否继续？')) return;
  try {
    const result = await api.campusGetMemory();
    if (!result.ok) throw new Error(result.error);
    renderMemory(result.memory, force);
    if (force) message('已重新读取学生资料。');
  } catch (error) { field('memory-status').textContent = error.message; }
}
field('memory-refresh').addEventListener('click', () => { void refreshMemory(true); });
field('memory-summarize').addEventListener('click', async () => {
  if (dirty() && !await saveAll()) return;
  memoryBusy = true; controls(); field('memory-status').textContent = '正在整理，请稍候…';
  try {
    const result = await api.campusSummarizeMemory();
    if (result.memory) renderMemory(result.memory);
    if (!result.ok) throw new Error(result.error || '整理已取消。');
    field('memory-status').textContent = result.unchanged ? '没有待整理的新对话。' : '记忆已整理并保存。';
  } catch (error) { field('memory-status').textContent = error.message; }
  finally { memoryBusy = false; controls(); }
});
field('memory-clear').addEventListener('click', async () => {
  if (!window.confirm('清空本机全部长期记忆和待整理记录？未保存的资料修改也会丢弃，已有预约不受影响。')) return;
  memoryBusy = true; controls();
  try {
    const result = await api.campusClearMemory();
    if (!result.ok) throw new Error(result.error);
    renderMemory(result.memory, true); message('已清空记忆。新会话将不再携带旧资料。');
  } catch (error) { message(error.message, true); }
  finally { memoryBusy = false; controls(); }
});
async function refreshDebug() {
  try {
    const result = await api.campusDebugInfo();
    if (!result.ok) throw new Error(result.error);
    const total = result.files.reduce((sum, item) => sum + item.bytes, 0);
    field('debug-info').textContent = '当前实际状态：' + (result.enabled ? '已开启' : '已关闭') + '\n目录：' + result.directory
      + '\n已有 ' + result.files.length + ' 个日志文件，共 ' + (total / 1024).toFixed(1) + ' KB。每个约5MB轮转，最多3个。'
      + (result.lastError ? '\n' + result.lastError : '');
  } catch (error) { field('debug-info').textContent = error.message; }
}
field('debug-refresh').addEventListener('click', refreshDebug);
field('debug-open').addEventListener('click', async () => {
  try { const result = await api.campusDebugOpen(); if (!result.ok) throw new Error(result.error); }
  catch (error) { message(error.message, true); }
});
field('debug-export').addEventListener('click', async () => {
  try {
    const result = await api.campusDebugExport();
    if (!result.ok) throw new Error(result.error);
    if (!result.cancelled) message('调试日志已导出。包含对话文字，分享前请检查。');
  } catch (error) { message(error.message, true); }
});
window.addEventListener('beforeunload', event => {
  if (saving || memoryBusy || (dirty() && !window.confirm('还有未保存的修改，确认关闭设置？'))) {
    event.preventDefault(); event.returnValue = false;
  }
});
api.onCampusMemoryUpdated(info => renderMemory(info));
controls(); void refreshMemory(); void refreshDebug();
