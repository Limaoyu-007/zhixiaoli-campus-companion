'use strict';

const { stripThinking } = require('./campus-answer');
const WRITES = Object.freeze({
  createMeetingBooking: { operation: 'booking', status: '已预约' },
  createBusBooking: { operation: 'booking', status: '待核销' },
  cancelMeetingBooking: { operation: 'cancel', status: '已取消' },
  cancelBusBooking: { operation: 'cancel', status: '已取消' },
});
const READS = new Set(['queryMeetingRooms', 'queryMyMeetingBookings', 'queryBusSchedules',
  'listMyBusBookings', 'queryBusHistoryAnalysis', 'queryBusFutureAnalysis']);

function object(value) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function businessStatus(tool, value) {
  if (!value) return 'uncertain';
  if (value.success === false && typeof value.code === 'string' && value.code && value.code !== '0') return 'failed';
  if (value.success !== true || value.code !== '0') return 'uncertain';
  const data = object(value.data);
  if (!data || typeof data.recordId !== 'string' || !data.recordId.trim() ||
      data.status !== WRITES[tool].status) return 'uncertain';
  return 'success';
}

function summarize(calls, unknownTool) {
  const writes = [...calls.values()];
  if (!writes.length) return null;
  const operations = new Set(writes.map(call => WRITES[call.tool].operation));
  const operation = operations.size === 1 ? [...operations][0] : 'mixed';
  const statuses = writes.map(call => call.conflict ? 'uncertain' : call.status);
  let status;
  if (unknownTool || statuses.includes('uncertain')) status = 'uncertain';
  else if (statuses.every(value => value === 'success')) status = 'success';
  else if (statuses.every(value => value === 'failed')) status = 'failed';
  else status = 'partial';
  return { source: 'tool', status, operation };
}

function decodeResponse(body, onDiagnostic) {
  const report = (event, detail) => { try { onDiagnostic?.(event, detail); } catch (_) {} };
  const text = String(body).trim();
  if (text.startsWith('{')) {
    // Compatibility with blocking replies: no tool evidence, no business feedback.
    const value = JSON.parse(text);
    return finish(value.answer, value.conversation_id, null);
  }
  let answer = '';
  let conversationId = '';
  let messageId = '';
  let ended = false;
  let unknownTool = false;
  let anonymousCall = 0;
  const calls = new Map();
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter(line => line.startsWith('data:'));
    if (!lines.length) continue; // SSE comments/keep-alive.
    const data = lines.map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data.trim() === '[DONE]') continue;
    const event = object(data);
    if (!event) throw new Error('Invalid stream event.');
    if (event.event === 'error') {
      report('platform.stream-error', { code: event.code, message: event.message });
      throw new Error('Platform stream error.');
    }
    if (event.conversation_id) {
      if (conversationId && conversationId !== event.conversation_id) throw new Error('Conversation changed within response.');
      conversationId = event.conversation_id;
    }
    if (event.message_id) {
      if (messageId && messageId !== event.message_id) throw new Error('Message changed within response.');
      messageId = event.message_id;
    }
    if (ended) throw new Error('Unexpected event after message_end.');
    if (['agent_message', 'message'].includes(event.event) && typeof event.answer === 'string') answer += event.answer;
    if (event.event === 'message_end') {
      ended = true;
      report('platform.message-end', { messageId, usage: object(event.metadata)?.usage || null });
    }
    if (event.event !== 'agent_thought' || !event.tool) continue;
    if (typeof event.tool !== 'string') { unknownTool = true; continue; }
    const tools = event.tool.split(';').map(name => name.trim()).filter(Boolean);
    const observation = object(event.observation);
    for (const tool of tools) {
      const observedResult = object(observation?.[tool]);
      const resultData = object(observedResult?.data);
      report('platform.tool', { tool, position: event.position, input: object(event.tool_input),
        observed: Boolean(observedResult), success: observedResult?.success, code: observedResult?.code,
        message: observedResult?.message, recordId: resultData?.recordId, status: resultData?.status,
        recordsCount: Array.isArray(observedResult?.data) ? observedResult.data.length
          : Array.isArray(resultData?.records) ? resultData.records.length : undefined });
      if (!Object.prototype.hasOwnProperty.call(WRITES, tool)) {
        if (!READS.has(tool)) unknownTool = true;
        continue;
      }
      // Start and observation updates share position in the observed platform stream.
      const position = Number.isInteger(event.position) ? `position:${event.position}`
        : typeof event.id === 'string' && event.id ? `id:${event.id}` : `anonymous:${++anonymousCall}`;
      const key = `${position}:${tool}`;
      const call = calls.get(key) || { tool, status: 'uncertain', fingerprint: null, conflict: false };
      if (observation && Object.prototype.hasOwnProperty.call(observation, tool)) {
        const result = object(observation[tool]);
        const fingerprint = JSON.stringify({ success: result?.success, code: result?.code,
          recordId: result?.data?.recordId, status: result?.data?.status });
        if (call.fingerprint !== null && call.fingerprint !== fingerprint) call.conflict = true;
        call.fingerprint = fingerprint;
        call.status = businessStatus(tool, result);
      }
      calls.set(key, call);
    }
  }
  if (!ended) throw new Error('Stream ended before message_end.');
  return finish(answer, conversationId, summarize(calls, unknownTool));
}

function finish(answer, conversationId, feedback) {
  if (typeof answer !== 'string' || !answer.trim() || typeof conversationId !== 'string' || !conversationId.trim()) {
    throw new Error('Incomplete platform reply.');
  }
  return {
    answer: stripThinking(answer) || '助手没有返回可展示的正文。涉及预约时，请先查询执行结果。',
    conversationId, feedback,
  };
}

module.exports = { decodeResponse };
