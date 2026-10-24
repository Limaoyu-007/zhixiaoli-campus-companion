'use strict';
const https = require('https');
const { ChaoxingError } = require('./errors');
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/118.0.0.0 Safari/537.36';

// A private in-memory cookie jar; never shared with the model, logs or normal browser.
class HttpSession {
  constructor() { this.cookies = new Map(); }
  storeCookies(values, url) {
    for (const line of values || []) {
      const parts = line.split(';');
      const equal = parts[0].indexOf('=');
      if (equal < 1) continue;
      const cookie = { name: parts[0].slice(0, equal).trim(), value: parts[0].slice(equal + 1).trim(),
        domain: url.hostname, hostOnly: true, secure: false, expires: Infinity,
        path: url.pathname.lastIndexOf('/') > 0 ? url.pathname.slice(0, url.pathname.lastIndexOf('/')) : '/' };
      if (!/^[a-zA-Z0-9_-]+$/.test(cookie.name)) continue;
      let maxAge = null, valid = true;
      for (const part of parts.slice(1)) {
        const split = part.indexOf('=');
        const name = (split < 0 ? part : part.slice(0, split)).trim().toLowerCase();
        const value = split < 0 ? '' : part.slice(split + 1).trim();
        if (name === 'domain') {
          const domain = value.replace(/^\./, '').toLowerCase();
          if (!(domain === 'chaoxing.com' || domain.endsWith('.chaoxing.com')) ||
              !(url.hostname === domain || url.hostname.endsWith('.' + domain))) valid = false;
          cookie.domain = domain; cookie.hostOnly = false;
        } else if (name === 'path' && value.startsWith('/')) cookie.path = value;
        else if (name === 'secure') cookie.secure = true;
        else if (name === 'max-age' && /^-?\d+$/.test(value)) maxAge = Number(value);
        else if (name === 'expires' && Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value);
      }
      if (!valid) continue;
      if (maxAge !== null) cookie.expires = Date.now() + maxAge * 1000;
      const key = cookie.domain + '|' + cookie.path + '|' + cookie.name;
      if (cookie.expires <= Date.now()) this.cookies.delete(key); else this.cookies.set(key, cookie);
      if (this.cookies.size > 256) throw new ChaoxingError('COOKIE_LIMIT', '学习通会话数据异常，请重新查询。');
    }
  }
  header(url) {
    const values = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expires <= Date.now()) { this.cookies.delete(key); continue; }
      const domainMatch = cookie.hostOnly ? url.hostname === cookie.domain
        : url.hostname === cookie.domain || url.hostname.endsWith('.' + cookie.domain);
      const pathMatch = url.pathname === cookie.path ||
        (url.pathname.startsWith(cookie.path) && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/'));
      if (domainMatch && pathMatch && (!cookie.secure || url.protocol === 'https:')) values.push(cookie);
    }
    return values.sort((a, b) => b.path.length - a.path.length).map(cookie => cookie.name + '=' + cookie.value).join('; ');
  }
  cookieValue(name) {
    return [...this.cookies.values()].reverse().find(cookie => cookie.name === name && cookie.expires > Date.now())?.value || '';
  }
  async request(target, { method = 'GET', body = '', signal } = {}) {
    let url = new URL(target);
    for (let redirects = 0; redirects <= 6; redirects++) {
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
          !(url.hostname === 'chaoxing.com' || url.hostname.endsWith('.chaoxing.com'))) {
        throw new ChaoxingError('REDIRECT_BLOCKED', '学习通请求跳转到了不支持的地址，已停止。');
      }
      const response = await this.once(url, { method, body, signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      if (!response.location) throw new ChaoxingError('REDIRECT_INVALID', '学习通返回了无效跳转。');
      url = new URL(response.location, url);
      if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) { method = 'GET'; body = ''; }
    }
    throw new ChaoxingError('REDIRECT_LIMIT', '学习通跳转次数过多，请稍后重试。');
  }
  once(url, { method, body, signal }) {
    return new Promise((resolve, reject) => {
      let request, timer, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => {
        request?.destroy();
        finish(signal?.reason instanceof ChaoxingError ? signal.reason : new ChaoxingError('CANCELLED', '学习通查询已停止。'));
      };
      if (signal?.aborted) return abort();
      const headers = { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', Cookie: this.header(url) };
      if (method === 'POST') { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(body); }
      request = https.request(url, { method, headers }, response => {
        if (settled || signal?.aborted) { response.resume(); return abort(); }
        try { this.storeCookies(response.headers['set-cookie'], url); }
        catch (error) { response.resume(); return finish(error); }
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
          response.resume(); return finish(new ChaoxingError('RESPONSE_ENCODING', '学习通响应编码暂不支持，未解析作业。'));
        }
        const chunks = []; let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 3 * 1024 * 1024) { response.destroy(); finish(new ChaoxingError('RESPONSE_LIMIT', '学习通页面过大，已停止读取。')); }
          else chunks.push(chunk);
        });
        response.on('error', () => finish(new ChaoxingError('NETWORK_ERROR', '学习通响应中断，请稍后重试。')));
        response.on('end', () => finish(null, { status: response.statusCode, url: url.href,
          location: response.headers.location || '', body: Buffer.concat(chunks).toString('utf8') }));
      });
      request.on('error', () => finish(new ChaoxingError('NETWORK_ERROR', '无法连接学习通，请检查网络后重试。')));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        finish(new ChaoxingError('REQUEST_TIMEOUT', '学习通单次请求超过20秒，已停止。'));
        request.destroy();
      }, 20000);
      request.end(body || undefined);
    });
  }
}
module.exports = { HttpSession };
