// Application configuration, independent credentials and settings validation.
'use strict';
const fs = require('fs');
const path = require('path');
const { resolvePortraitURL } = require('./portrait-asset');
const campusAgent = require('./campus-agent-service');
const { ChaoxingError } = require('./chaoxing/errors');
const { validateConfig: validateStudyConfig } = require('./agent/model-provider');
const { ConfigStore, validate: validateStoredConfig } = require('./config-store');

function createAppConfig({ root, dataDir, packaged, safeStorage, isSpeechAvailable }) {
  const store = new ConfigStore(path.join(dataDir, 'config.json'));
  let cachedEncrypted = '';
  let cachedPassword = '';
  function configPath() { return store.file; }
  function configStore() { return store; }
  function initialConfig() {
    try { return validateStoredConfig(JSON.parse(fs.readFileSync(path.join(root, 'distribution.defaults.json'), 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return {};
      throw new Error('内置体验配置无法读取，请重新安装或联系提供者。');
    }
  }
  function loadConfig() {
    const saved = configStore().read(initialConfig);
    return {
      ...saved,
      campus: { api_key: '', user: '', timeout_seconds: 120, ...saved.campus, enabled: true },
      ui: { font_size: 13, theme_color: '#5B8CFF', layered_portrait: true, ...saved.ui,
        custom_image: resolvePortraitURL(saved.ui?.custom_image, root) },
      window: { scale: 1, ...saved.window },
      speech: { enabled: true, voice: 'zh-CN-XiaoxiaoNeural', rate: 0, ...saved.speech },
      memory: { enabled: true, api_base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        api_key: '', model: 'qwen-flash', context_rounds: 3, ...saved.memory },
      timetable: { api_base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_key: '', model: 'qwen3-vl-plus', ...saved.timetable },
      debug: { enabled: !packaged, ...saved.debug },
      agent: { mode: saved.agent?.mode === 'study' ? 'study' : 'campus' },
      study: { provider: 'qwen', api_base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        api_key: '', model: 'qwen-plus', timeout_seconds: 120, context_rounds: 12, max_rounds: 6, ...saved.study },
      chaoxing: { enabled: true, phone: '', password_encrypted: '', ...saved.chaoxing },
    };
  }
  function writeConfig(config) {
    try { configStore().write(config); }
    catch (_) { throw new Error('配置保存失败，请检查数据目录权限和磁盘空间；未完成的保存不会作为成功处理。'); }
  }
  function publicConfig() {
    const config = loadConfig();
    // Legacy provider settings and credentials are not sent to the campus page.
    return {
      campus: { enabled: true, api_key: '', user: config.campus.user,
        timeout_seconds: config.campus.timeout_seconds, has_api_key: campusAgent.hasApiKey(config.campus) },
      ui: config.ui, window: config.window, speech: { ...config.speech, available: isSpeechAvailable() },
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
  function studyConfig() {
    const config = loadConfig().study;
    return { ...config, api_key: config.api_key?.trim() || '' };
  }
  function savedChaoxingPassword(config) {
    const encrypted = config?.password_encrypted || '';
    if (!encrypted) return '';
    if (encrypted === cachedEncrypted) return cachedPassword;
    try {
      if (!safeStorage.isEncryptionAvailable()) throw new Error();
      const plain = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      cachedEncrypted = encrypted;
      cachedPassword = plain;
      return plain;
    } catch (_) { throw new ChaoxingError('CREDENTIAL_DECRYPT_FAILED', '无法解密已保存的学习通密码，请在设置 → 学习通重新保存密码。'); }
  }
  function chaoxingConfig() {
    const config = loadConfig().chaoxing;
    // Environment credentials are a pair; never combine one account's password with another account.
    if (process.env.CHAOXING_PHONE || process.env.CHAOXING_PASSWORD) return { enabled: config.enabled,
      phone: process.env.CHAOXING_PHONE?.trim() || '', password: process.env.CHAOXING_PASSWORD || '' };
    return { enabled: config.enabled, phone: config.phone, password: config.enabled === false ? '' : savedChaoxingPassword(config) };
  }
  function memoryConfig() {
    const config = loadConfig().memory;
    return { ...config, api_key: config.api_key?.trim() || '',
      key_source: 'memory settings', config_file: configPath() };
  }
  function timetableConfig() {
    const config = loadConfig().timetable;
    return { ...config, api_key: config.api_key?.trim() || '' };
  }
  function update(patch = {}) {
    const config = loadConfig();
    const trackedSections = ['campus', 'study', 'chaoxing', 'memory', 'timetable', 'ui', 'speech', 'debug'];
    const before = Object.fromEntries(trackedSections.map(key => [key, JSON.stringify(config[key])]));
    const oldUser = config.campus.user;
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
    const sections = trackedSections.filter(key => before[key] !== JSON.stringify(config[key]));
    return {
      config,
      sections,
      userChanged: oldUser !== config.campus.user,
      chaoxingChanged: before.chaoxing !== JSON.stringify(config.chaoxing),
      speechChanged: before.speech !== JSON.stringify(config.speech),
      memoryChanged: before.memory !== JSON.stringify(config.memory),
      timetableChanged: before.timetable !== JSON.stringify(config.timetable),
    };
  }
  function settingsConfig() {
    const config = loadConfig();
    const result = publicConfig();
    for (const section of ['campus', 'study', 'memory', 'timetable']) result[section].api_key = config[section].api_key || '';
    return result;
  }
  return { load: loadConfig, write: writeConfig, path: configPath, store: configStore,
    initial: initialConfig, public: publicConfig, settings: settingsConfig, update,
    study: studyConfig, memory: memoryConfig, timetable: timetableConfig,
    chaoxing: chaoxingConfig, savedChaoxingPassword };
}
module.exports = { createAppConfig };
