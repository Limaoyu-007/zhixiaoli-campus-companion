'use strict';
const fs = require('fs');
const path = require('path');
const MAX_BYTES = 5 * 1024 * 1024;
const FILE_NAME = 'campus-dialogue.jsonl';

// Development traces are independent of the student memory and session stores.
class CampusDebugLog {
  constructor(dataDir, options = {}) {
    this.directory = path.join(dataDir, 'logs');
    this.file = path.join(this.directory, FILE_NAME);
    this.getConfig = options.getConfig || (() => ({ enabled: false }));
    this.getSecrets = options.getSecrets || (() => []);
    this.lastError = '';
  }
  sanitize(value, secrets = [], depth = 0) {
    if (depth > 12) return '[内容层级过深，已省略]';
    if (typeof value === 'string') {
      let content = value;
      for (const secret of secrets) if (typeof secret === 'string' && secret.length >= 4) content = content.split(secret).join('[凭据已脱敏]');
      content = content.replace(/data:(?:image|application)\/[^\s"']+/gi, '[文件数据已省略]')
        .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[密钥已脱敏]')
        .replace(/\bBearer\s+[A-Za-z0-9_.~+\/-]+=*/gi, 'Bearer [已脱敏]')
        .replace(/((?:(?:门锁|开锁|登录|预约)?密码|密钥|password|api[_ -]?key|access[_ -]?token|token)["'\s*\x60]*(?:是|为|[:：=])?["'\s*\x60]*)([A-Za-z0-9_.-]{4,})/gi, '$1[已脱敏]');
      return content.length > 64000 ? content.slice(0, 64000) + '\n[长文本已截断]' : content;
    }
    if (Array.isArray(value)) return value.slice(0, 200).map(item => this.sanitize(item, secrets, depth + 1));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [
      key, /api.?key|authorization|access.?token|secret|password|密码|凭据/i.test(key)
        ? '[已脱敏]' : this.sanitize(item, secrets, depth + 1),
    ]));
    return value;
  }
  rotate() {
    if (!fs.existsSync(this.file) || fs.statSync(this.file).size < MAX_BYTES) return;
    if (fs.existsSync(this.file + '.2')) fs.unlinkSync(this.file + '.2');
    if (fs.existsSync(this.file + '.1')) fs.renameSync(this.file + '.1', this.file + '.2');
    fs.renameSync(this.file, this.file + '.1');
  }
  write(event, detail = {}) {
    try {
      if (this.getConfig().enabled !== true) return;
      const record = this.sanitize({ at: new Date().toISOString(), event, ...detail }, this.getSecrets());
      fs.mkdirSync(this.directory, { recursive: true });
      this.rotate();
      fs.appendFileSync(this.file, JSON.stringify(record) + '\n', 'utf8');
      this.lastError = '';
    } catch (_) { this.lastError = '调试日志写入失败，请检查本地目录权限。'; }
  }
  info() {
    const files = [this.file, this.file + '.1', this.file + '.2'].flatMap(file => {
      try { const stat = fs.statSync(file); return [{ name: path.basename(file), bytes: stat.size, updatedAt: stat.mtime.toISOString() }]; }
      catch (_) { return []; }
    });
    return { enabled: this.getConfig().enabled === true, directory: this.directory, files, lastError: this.lastError };
  }
  snapshot() {
    const parts = [];
    for (const file of [this.file + '.2', this.file + '.1', this.file]) {
      try { parts.push(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('调试日志读取失败。'); }
    }
    if (!parts.length) throw new Error('尚无调试记录。开启后发送一轮消息即可记录。');
    // Redact again at export in case a credential was configured after an older trace.
    const secrets = this.getSecrets();
    return parts.join('').split('\n').filter(Boolean).map(line => {
      try { return JSON.stringify(this.sanitize(JSON.parse(line), secrets)); }
      catch (_) { return JSON.stringify({ event: 'log.unreadable', message: '一条不完整记录已省略。' }); }
    }).join('\n') + '\n';
  }
}
module.exports = { CampusDebugLog };
