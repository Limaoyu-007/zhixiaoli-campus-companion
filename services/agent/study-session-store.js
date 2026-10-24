'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

// Study history is owned locally and never contains a campus conversation ID.
class StudySessionStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'study-session.json'); this.session = null;
    this.startupResetDone = false;
    this.interrupted = false;
  }
  create() { return { id: randomUUID(), mode: 'study', turns: [], messages: [], pending: false, lastError: '' }; }
  get() {
    if (this.session) return this.session;
    try {
      if (fs.statSync(this.file).size > 8 * 1024 * 1024) throw new Error('too large');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!saved.id || saved.mode !== 'study' || !Array.isArray(saved.turns) || !Array.isArray(saved.messages) ||
          saved.turns.some(turn => !Array.isArray(turn.messages))) throw new Error('Invalid study session');
      this.session = saved;
      if (saved.pending) {
        this.interrupted = true;
        saved.pending = false;
        saved.lastError = '上次通用学习请求中断，可以重新提问；未完成轮次不会作为已完成上下文使用。';
        this.save();
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('通用学习会话文件无法读取，请保留文件并检查格式或权限。');
      this.session = this.create();
      this.save();
    }
    return this.session;
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(this.session, null, 2), 'utf8');
    fs.renameSync(temporary, this.file);
  }
  startNew() {
    this.get();
    if (this.startupResetDone) return this.session;
    const current = this.reset({ warning: this.interrupted
      ? '上次通用学习请求中断。本次已新建会话，启用时仍会使用已保存的长期记忆。' : '' });
    this.startupResetDone = true;
    return current;
  }
  reset({ warning = '' } = {}) {
    this.session = this.create();
    this.session.lastError = warning;
    this.save();
    return this.session;
  }
  // Retain complete user/assistant/tool groups; never cut a tool call from its result.
  history(contextRounds) {
    const selected = [];
    let chars = 0;
    for (const turn of this.get().turns.slice(-contextRounds).reverse()) {
      const size = JSON.stringify(turn.messages).length;
      if (chars + size > 48000) break;
      selected.unshift(turn);
      chars += size;
    }
    return selected.flatMap(turn => turn.messages);
  }
  appendTurn(messages, trace) {
    const session = this.get();
    session.turns.push({ at: Date.now(), messages, trace });
    let size = 0;
    session.turns = session.turns.slice(-30).reverse().filter(turn => {
      size += JSON.stringify(turn).length;
      return size <= 1500000;
    }).reverse();
  }
  view(session = this.get()) {
    return { id: session.id, mode: 'study', pending: session.pending, lastError: session.lastError,
      uncertain: false, messages: session.messages.slice(-100),
      lastAnswer: [...session.messages].reverse().find(message => message.role === 'assistant')?.content || '' };
  }
}
module.exports = { StudySessionStore };
