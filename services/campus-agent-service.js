// Campus integration added locally, 2026-10-22.
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { decodeResponse } = require('./campus-response');

// Reuse the existing campus demo endpoint and exact certificate pin.
const ENDPOINT = 'https://aiagent.cqut.edu.cn:31134/v1/chat-messages';
const CERTIFICATE = '2F:E2:16:17:B1:75:04:3C:15:EF:D4:AD:AF:D7:3E:69:F2:98:8F:A9:EF:B8:18:10:14:65:C6:6B:9E:72:9B:C6';

function getApiKey(config = {}) {
  if (process.env.ZXL_API_KEY?.trim()) return process.env.ZXL_API_KEY.trim();
  if (config.api_key?.trim()) return config.api_key.trim();
  try {
    return String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'campus.local.json'), 'utf8')).api_key || '').trim();
  } catch (_) {
    return '';
  }
}

function send({ query, user, conversationId, signal, onDiagnostic }, config = {}) {
  const report = (event, detail) => { try { onDiagnostic?.(event, detail); } catch (_) {} };
  const key = getApiKey(config);
  if (!key) return Promise.reject(new Error('请在设置中填写校园 Agent API Key，或配置 ZXL_API_KEY。'));
  const payload = JSON.stringify({ input_data: {}, query, user, conversation_id: conversationId || '', mode: 'streaming' });
  const timeout = Math.max(10, Math.min(300, Number(config.timeout_seconds) || 120)) * 1000;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let request;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const stop = (message) => {
      const error = new Error(message);
      // A lost response cannot establish whether a booking executed remotely.
      error.uncertain = true;
      finish(error);
      request?.destroy();
    };
    const abort = () => stop('已停止等待。远端操作可能仍在执行；涉及预约时，请先查询结果，不要直接重复提交。');
    if (signal?.aborted) { abort(); return; }

    request = https.request(ENDPOINT, {
      method: 'POST', agent: false, rejectUnauthorized: false,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json' },
    }, response => {
      let body = '';
      report('platform.http', { httpStatus: response.statusCode, contentType: response.headers['content-type'] || '' });
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 2_000_000) stop('平台响应过长，未能读取完整结果。涉及预约时请先查询结果。');
      });
      response.on('error', () => stop('平台响应中断，结果尚不确定；涉及预约时请先查询结果。'));
      response.on('aborted', () => stop('平台响应中断，结果尚不确定；涉及预约时请先查询结果。'));
      response.on('end', () => {
        if (settled) return;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          // Do not expose upstream bodies, which may contain internal details.
          stop(`校园平台请求失败（HTTP ${response.statusCode}）。涉及预约时请先查询执行结果。`);
          return;
        }
        let result;
        try { result = decodeResponse(body, report); }
        catch (error) {
          report('platform.decode-failed', { reason: error.message, responseCharacters: body.length });
          stop('平台未返回完整有效的回复，结果尚不确定；涉及预约时请先查询执行结果。');
          return;
        }
        if (conversationId && result.conversationId !== conversationId) {
          report('platform.conversation-mismatch', {});
          stop('平台返回的会话标识不匹配，结果尚不确定；涉及预约时请先查询执行结果。');
          return;
        }
        finish(null, result);
      });
    });
    request.on('socket', socket => {
      socket.once('secureConnect', () => {
        if (settled) return;
        if (socket.getPeerCertificate()?.fingerprint256 !== CERTIFICATE) {
          report('platform.certificate-mismatch', {});
          finish(new Error('校园平台证书已变化，已停止发送凭据。'));
          request.destroy();
          return;
        }
        // Neither authorization nor request body is sent until the pin matches.
        request.setHeader('Authorization', `Bearer ${key}`);
        request.end(payload);
      });
    });
    request.on('error', () => stop('连接校园平台失败，结果尚不确定；涉及预约时请先查询结果。'));
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('校园平台响应超时，预约可能已经执行；请先查询结果，不要直接重复提交。'), timeout);
  });
}

module.exports = { send, hasApiKey: config => Boolean(getApiKey(config)), getApiKey, ENDPOINT };
