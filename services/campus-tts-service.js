// Focused Edge TTS adapter. Does not load the original multi-provider application.
'use strict';
const { spawn } = require('child_process');
const path = require('path');

class CampusTTSService {
  constructor() { this.active = null; }
  stop() { this.active?.cancel(); }

  synthesize(text, config) {
    this.stop();
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
      const runtime = path.join(__dirname, '..', '.runtime', 'python').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
      const rate = Math.max(-30, Math.min(30, Number(config.rate) || 0));
      const voice = config.voice === 'zh-CN-YunxiNeural' ? config.voice : 'zh-CN-XiaoxiaoNeural';
      child = spawn(process.env.ZXL_TTS_PYTHON || 'python', [
        '-m', 'edge_tts', `--text=${text}`, `--voice=${voice}`, `--rate=${rate >= 0 ? '+' : ''}${rate}%`, '--write-media=-',
      ], {
        windowsHide: true,
        env: { ...process.env, PYTHONPATH: [runtime, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter), PYTHONIOENCODING: 'utf-8' },
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
      child.on('error', () => finish(new Error('语音组件无法启动，请检查 Python 和朗读依赖；文字回复不受影响。')));
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
