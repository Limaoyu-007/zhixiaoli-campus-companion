// Ephemeral speech bubbles: newest at the bottom, oldest moves up and fades away.
'use strict';

window.CampusBubbles = class {
  constructor(container) {
    this.container = container;
    this.messages = [];
    this.frame = null;
    this.lastTick = performance.now();
    this.observer = new ResizeObserver(() => this.layout());
    this.observer.observe(container);
    this.timer = setInterval(() => this.tick(), 250);
    window.addEventListener('pagehide', () => {
      clearInterval(this.timer);
      this.observer.disconnect();
    }, { once: true });
  }

  add(options) {
    const node = document.createElement('article');
    node.className = 'speech-bubble entering';
    const author = document.createElement('div');
    author.className = 'speech-author';
    const body = document.createElement('div');
    body.className = 'speech-body';
    const outcome = document.createElement('div');
    outcome.className = 'speech-outcome';
    outcome.hidden = true;
    node.append(author, outcome, body);
    const message = { node, author, outcome, body, expiresAt: Infinity, pending: false };
    this.messages.push(message);
    this.container.appendChild(node);
    this.observer.observe(node);
    this.update(message, options);
    while (this.messages.length > 3) this.remove(this.messages[0]);
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.remove('entering')));
    return message;
  }

  update(message, { text, label = '智小理', markdown = false, warning = '', kind = 'assistant', pending = false, feedback = null }) {
    if (!this.messages.includes(message)) return this.add({ text, label, markdown, warning, kind, pending, feedback });
    message.pending = pending;
    message.node.dataset.kind = kind;
    message.node.classList.toggle('pending', pending);
    message.author.textContent = label;
    const result = !pending && kind !== 'user' ? window.CampusFeedback.describe(feedback) : null;
    message.outcome.hidden = !result;
    message.outcome.textContent = result?.label || '';
    message.outcome.dataset.status = result?.status || '';
    message.body.classList.toggle('markdown-body', markdown);
    if (markdown) window.CampusMarkdown.render(message.body, text);
    else message.body.textContent = text;
    if (warning) {
      const note = document.createElement('p');
      note.className = 'reply-warning';
      note.textContent = warning;
      message.body.appendChild(note);
    }
    const lifetime = kind === 'user' ? 12000 : Math.min(90000, Math.max(18000, text.length * 55));
    message.expiresAt = pending ? Infinity : performance.now() + lifetime;
    message.body.scrollTop = 0;
    this.layout();
    return message;
  }

  remove(message) {
    const index = this.messages.indexOf(message);
    if (index < 0) return;
    this.messages.splice(index, 1);
    this.observer.unobserve(message.node);
    message.node.classList.add('leaving');
    setTimeout(() => message.node.remove(), 260);
    this.layout();
  }

  clear() {
    this.messages.forEach(message => this.observer.unobserve(message.node));
    this.messages = [];
    this.container.replaceChildren();
    window._campusBubbleHover = false;
    window._chatAreaHover = false;
    this.layout();
  }

  tick() {
    const now = performance.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;
    if (this.container.matches(':hover')) {
      // Pause while reading, selecting text or scrolling a long answer.
      this.messages.forEach(message => { if (!message.pending) message.expiresAt += elapsed; });
      return;
    }
    // Always retire the oldest first, so an older answer never drops back down.
    while (this.messages[0] && !this.messages[0].pending && this.messages[0].expiresAt <= now) {
      this.remove(this.messages[0]);
    }
  }

  layout() {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      let offset = 0;
      [...this.messages].reverse().forEach((message, depth) => {
        message.node.style.setProperty('--bubble-y', `${-offset}px`);
        message.node.style.setProperty('--bubble-opacity', String(1 - depth * 0.16));
        message.node.style.zIndex = String(3 - depth);
        offset += message.node.offsetHeight + 10;
      });
      this.container.classList.toggle('visible', this.messages.length > 0);
    });
  }
};
