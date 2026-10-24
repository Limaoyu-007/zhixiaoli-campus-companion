// Campus integration added locally, 2026-10-22.
'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Platform dialogue restarts once per process. Long-term facts live in campus-memory.json.
class CampusSessionStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'campus-session.json');
    this.session = null;
    this.startupResetDone = false;
  }

  create(user) {
    return { id: randomUUID(), user: user || `desktop_${randomUUID()}`, conversationId: '', messages: [], pending: false, lastError: '', uncertain: false };
  }

  get(user = '') {
    if (!this.session) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (!saved.id || !saved.user || !Array.isArray(saved.messages)) throw new Error('Invalid session');
        this.session = saved;
        if (saved.pending) {
          saved.pending = false;
          saved.uncertain = true;
          saved.lastError = '上次请求在回复前中断，结果尚不确定；涉及预约时请先查询结果。';
          this.save();
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('校园会话文件无法读取，请保留文件并检查格式或权限。');
        this.session = this.create(user);
        this.save();
      }
    }
    if (user && this.session.user !== user) return this.reset(user);
    return this.session;
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.session, null, 2), 'utf8');
    fs.renameSync(temporary, this.file);
  }

  startNew(user = '') {
    const current = this.get(user);
    if (this.startupResetDone) return current;
    const next = this.reset(current.user, { preserveWarning: true });
    this.startupResetDone = true;
    return next;
  }

  reset(user = '', { preserveWarning = false } = {}) {
    const warning = preserveWarning && this.session?.uncertain ? this.session.lastError : '';
    this.session = this.create(user || this.session?.user);
    if (warning) { this.session.lastError = warning; this.session.uncertain = true; }
    this.save();
    return this.session;
  }

  view(session = this.get()) {
    return {
      id: session.id, user: session.user, conversationId: session.conversationId,
      pending: session.pending, lastError: session.lastError,
      lastAnswer: [...session.messages].reverse().find(message => message.role === 'assistant')?.content || '',
    };
  }
}

module.exports = { CampusSessionStore };
