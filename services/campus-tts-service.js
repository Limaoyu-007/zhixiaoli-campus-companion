// Focused Edge TTS adapter. Does not load the original multi-provider application.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class CampusTTSService {
  constructor({ packaged = false } = {}) { this.active = null; this.unavailable = false; this.packaged = packaged; }
  stop() { this.active?.cancel(); }
  isAvailable() { return !this.unavailable && Boolean(this.runtime()); }

  runtime() {
    const root = path.join(__dirname, '..').replace(/app\.asar([\\/]|$)/, 'app.asar.unpacked$1');
    const bundled = path.join(root, '.runtime', 'tts-python');
    if (process.platform === 'win32' && fs.existsSync(path.join(bundled, 'python.exe')) &&
        fs.existsSync(path.join(bundled, 'Lib', 'site-packages', 'edge_tts', '__main__.py'))) {
      return { executable: path.join(bundled, 'python.exe'), dependencies: path.join(bundled, 'Lib', 'site-packages') };
    }
    // Packaged Windows builds must not depend on the user's PATH or Python.
    if (process.platform === 'win32' && this.packaged) return null;
    const dependencies = path.join(root, '.runtime', 'python');
    if (!fs.existsSync(path.join(dependencies, 'edge_tts', '__main__.py'))) return null;
    return { executable: process.env.ZXL_TTS_PYTHON || 'python', dependencies };
  }

  synthesize(text, config) {
    this.stop();
    if (this.unavailable) return Promise.reject(Object.assign(new Error('朗读组件不可用'), { cancelled: true }));
    const runtime = this.runtime();
    if (!runtime) {
      this.unavailable = true;
      return Promise.reject(new Error('朗读组件缺失，本次运行已暂停朗读；请重新安装完整版本。文字回复不受影响。'));
    }
    return new Promise((resolve, reject) => {
      let finished = false;
      let timer;
      let child;
      const job = { cancel: () => finish(Object.assign(new Error('已停止朗读'), { cancelled: true })) };
      const finish = (error, audio) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (this.active === job) this.active = null;
        if (error) { child?.kill(); reject(error); } else resolve(audio);
      };
      this.active = job;
      // Python cannot import inside app.asar; dependencies are unpacked when packaged.
      const rate = Math.max(-30, Math.min(30, Number(config.rate) || 0));
      const voice = config.voice === 'zh-CN-YunxiNeural' ? config.voice : 'zh-CN-XiaoxiaoNeural';
      child = spawn(runtime.executable, [
        '-m', 'edge_tts', `--text=${text}`, `--voice=${voice}`, `--rate=${rate >= 0 ? '+' : ''}${rate}%`, '--write-media=-',
      ], {
        windowsHide: true,
        env: { ...process.env, PYTHONPATH: runtime.dependencies, PYTHONIOENCODING: 'utf-8', PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks = [];
      let bytes = 0;
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 15_000_000) { finish(new Error('朗读音频过长，请查看文字回复。')); return; }
        chunks.push(chunk);
      });
      child.stderr.on('data', () => {});
      child.on('error', () => {
        this.unavailable = true;
        finish(new Error('朗读组件无法启动，本次运行已暂停朗读；请重新安装完整版本。文字回复不受影响。'));
      });
      child.on('close', code => {
        if (finished) return;
        if (code !== 0 || bytes === 0) { finish(new Error('语音生成失败，请检查网络或稍后再试；文字回复不受影响。')); return; }
        finish(null, Buffer.concat(chunks));
      });
      timer = setTimeout(() => finish(new Error('语音生成超时，已保留文字回复。')), 120000);
    });
  }
}

module.exports = { CampusTTSService };
