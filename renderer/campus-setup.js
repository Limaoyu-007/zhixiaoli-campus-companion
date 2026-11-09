'use strict';
window.CampusSetupGuide = class {
  constructor() {
    this.panel = document.getElementById('setup-guide');
    this.features = document.getElementById('setup-features');
    document.getElementById('setup-open').addEventListener('click', () => this.show());
    document.getElementById('setup-close').addEventListener('click', () => {
      this.panel.hidden = true;
      try { localStorage.setItem('campus-setup-seen-v1', 'true'); } catch (_) {}
      document.getElementById('chat-input').focus();
    });
  }
  ready(mode) {
    const config = this.config;
    if (!config) return false;
    if (mode === 'campus') return Boolean(config.campus.has_api_key);
    const study = config.study;
    try {
      const url = new URL(study.api_base);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      return ['qwen', 'deepseek', 'custom'].includes(study.provider) && Boolean(study.model?.trim()) && study.model.length <= 120 &&
        !url.username && !url.password && !url.search && !url.hash &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) &&
        (study.has_api_key || loopback);
    } catch (_) { return false; }
  }
  show() {
    if (!this.config) return;
    this.panel.hidden = false;
    window.electronAPI.setIgnoreMouse(false);
    document.getElementById('setup-close').focus();
  }
  update(config) {
    this.config = config;
    const configured = value => value?.has_api_key && value.api_base && value.model;
    const account = config.chaoxing;
    const homework = account.enabled !== false && (account.uses_environment ? account.environment_complete : account.phone && account.has_password);
    const entries = [
      ['校园业务', this.ready('campus') ? '已配置 · 查询、预约以平台权限为准' : '待配置校园 API Key', 'campus'],
      ['通用学习', this.ready('study') ? '已配置 · 可开始学习问答' : '待配置模型接口、模型名称或 API Key', 'study'],
      ['个人课表', configured(config.timetable) ? '可手动录入 · 图片/PDF识别已配置' : '可手动录入 · 图片/PDF识别待配置', 'timetable'],
      ['学习通作业', homework ? '已配置账号 · 按课程查询作业' : '待配置账号与密码', 'chaoxing'],
      ['长期记忆', config.memory.enabled === false ? '已关闭 · 不影响普通问答' : configured(config.memory) ? '已配置 · 整理成功问答' : '待配置整理模型 · 不影响普通问答', 'memory'],
      ['回复朗读', !config.speech.enabled ? '已关闭' : config.speech.available === false ? '组件缺失 · 文字聊天仍可使用' : '组件已准备 · 朗读需要联网', 'speech'],
    ];
    this.features.replaceChildren();
    for (const [name, status, section] of entries) {
      const row = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = name + '\n' + status;
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = '去设置'; button.setAttribute('aria-label', '设置' + name);
      button.addEventListener('click', () => window.electronAPI.openSettingsWindow(section));
      row.append(text, button); this.features.append(row);
    }
  }
  start(mode) {
    let seen = false;
    try { seen = localStorage.getItem('campus-setup-seen-v1') === 'true'; } catch (_) {}
    if (!seen || !this.ready(mode)) this.show();
  }
};
