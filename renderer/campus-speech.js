// Reply playback and amplitude-driven character mouth movement.
'use strict';

window.CampusSpeech = class {
  constructor(onError) {
    this.onError = onError;
    this.config = { enabled: true };
    this.context = null;
    this.source = null;
    this.animation = null;
    this.generation = 0;
    this.onVisibility = () => { if (document.hidden) this.stop(); };
    document.addEventListener('visibilitychange', this.onVisibility);
  }
  configure(config) {
    this.stop();
    this.config = config || { enabled: true };
  }
  prepare() {
    if (!this.config.enabled) return;
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.connect(this.context.destination);
      }
      if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    } catch (_) { /* Audio initialization must never prevent sending a text message. */ }
  }
  stop() {
    ++this.generation;
    window.electronAPI.stopSpeech();
    if (this.source) { try { this.source.stop(); } catch (_) {} this.source = null; }
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    this.animation = null;
    window.setPetSpeaking?.(false);
    window.setLipSync?.(0);
  }
  destroy() {
    this.stop();
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.context) this.context.close().catch(() => {});
  }
  plainText(markdown) {
    const holder = document.createElement('div');
    window.CampusMarkdown.render(holder, markdown);
    holder.querySelectorAll('pre').forEach(node => node.remove());
    holder.querySelectorAll('td, th').forEach(node => node.append('，'));
    holder.querySelectorAll('p, li, tr, h1, h2, h3, h4, h5, h6, blockquote').forEach(node => node.append('\n'));
    holder.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    const text = holder.textContent.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return text.length > 6000 ? text.slice(0, 6000) + '。后续内容请查看文字回复。' : text;
  }
  async speak(markdown) {
    this.stop();
    if (!this.config.enabled) return;
    const generation = this.generation;
    try {
      this.prepare();
      if (!this.context || !this.analyser) throw new Error('当前环境无法初始化语音播放，文字回复已保留。');
      const text = this.plainText(markdown);
      if (!text) return;
      const result = await window.electronAPI.synthesizeSpeech(text);
      if (generation !== this.generation) return;
      if (!result.ok) {
        if (!result.cancelled) throw new Error(result.error);
        return;
      }
      const bytes = new Uint8Array(result.audio);
      const audio = await this.context.decodeAudioData(bytes.buffer);
      if (generation !== this.generation) return;
      await this.context.resume();
      if (generation !== this.generation) return;
      const source = this.context.createBufferSource();
      this.source = source;
      source.buffer = audio;
      source.connect(this.analyser);
      source.onended = () => {
        source.disconnect();
        if (generation !== this.generation) return;
        this.source = null;
        if (this.animation !== null) cancelAnimationFrame(this.animation);
        this.animation = null;
        window.setPetSpeaking?.(false);
        window.setLipSync?.(0);
      };
      source.start();
      window.setPetSpeaking?.(true);
      const samples = new Uint8Array(this.analyser.fftSize);
      const tick = () => {
        if (generation !== this.generation || !this.source) return;
        this.analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        window.setLipSync?.(Math.min(1, Math.sqrt(sum / samples.length) * 6));
        this.animation = requestAnimationFrame(tick);
      };
      tick();
    } catch (error) {
      if (generation === this.generation) { this.stop(); this.onError(error.message); }
    }
  }
};
