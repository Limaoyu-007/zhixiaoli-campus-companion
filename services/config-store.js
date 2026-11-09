'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validate(config) {
  if (!object(config)) throw new Error('配置必须是JSON对象。');
  const fields = {
    campus: { api_key: 'string', user: 'string', timeout_seconds: 'number' },
    study: { api_key: 'string', api_base: 'string', model: 'string', provider: 'string', timeout_seconds: 'number', context_rounds: 'number', max_rounds: 'number' },
    memory: { enabled: 'boolean', api_key: 'string', api_base: 'string', model: 'string', context_rounds: 'number' },
    timetable: { api_key: 'string', api_base: 'string', model: 'string' },
    chaoxing: { enabled: 'boolean', phone: 'string', password_encrypted: 'string' },
    speech: { enabled: 'boolean', voice: 'string', rate: 'number' },
    ui: { font_size: 'number', theme_color: 'string', custom_image: 'string', layered_portrait: 'boolean' },
    window: { scale: 'number' }, agent: { mode: 'string' }, debug: { enabled: 'boolean' },
  };
  for (const [section, types] of Object.entries(fields)) {
    if (!Object.hasOwn(config, section)) continue;
    if (!object(config[section])) throw new Error('配置分类格式无效。');
    for (const [field, type] of Object.entries(types)) {
      if (!Object.hasOwn(config[section], field)) continue;
      const value = config[section][field];
      if (typeof value !== type || (type === 'number' && !Number.isFinite(value))) throw new Error('配置字段类型无效。');
    }
  }
  return config;
}

class ConfigStore {
  constructor(file) { this.file = file; this.backup = file + '.bak'; this.cached = null; }
  readFile(file) { return validate(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  read(initial) {
    if (this.cached) return structuredClone(this.cached);
    try {
      this.cached = this.readFile(this.file);
      return structuredClone(this.cached);
    } catch (error) {
      if (error.code === 'ENOENT' && !fs.existsSync(this.backup)) {
        this.cached = validate(initial());
        return structuredClone(this.cached);
      }
      throw new Error('本机配置无法读取，需恢复备份或重新配置。');
    }
  }
  readBackup() { return this.readFile(this.backup); }
  replace(file, text) {
    const temporary = file + '.' + randomUUID() + '.tmp';
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, text, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, file);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (_) {}
    }
  }
  write(config, { backup = true } = {}) {
    validate(config);
    this.cached = null;
    const nextText = JSON.stringify(config, null, 2);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (backup) {
      let previous;
      try { previous = this.readFile(this.file); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('原配置无法读取，未覆盖；请重启应用处理配置恢复。'); }
      if (previous) {
        const previousText = JSON.stringify(previous, null, 2);
        if (previousText === nextText) {
          this.cached = structuredClone(config);
          return;
        }
        this.replace(this.backup, previousText);
      }
    }
    this.replace(this.file, nextText);
    this.cached = structuredClone(config);
  }
  recover(config) {
    validate(config);
    this.cached = null;
    // Preserve the exact damaged file before replacing it. Failure to preserve
    // it aborts recovery; never silently discard the user's configuration.
    try { fs.copyFileSync(this.file, this.file + '.damaged-' + Date.now() + '-' + randomUUID(), fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.write(config, { backup: false });
  }
}
module.exports = { ConfigStore, validate };
