// Shared by the main process and the timetable editor; no model or filesystem access.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TimetableUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000;
  const weekdays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  function integer(value, min, max, label) {
    if (value === '' || value == null) return null;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw new Error(label + '超出范围。');
    return number;
  }
  function text(value, max = 120) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
  function dateNumber(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('请填写有效的日期。');
    const time = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new Error('请填写有效的日期。');
    return time;
  }
  function time(value) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('节次时间请使用 HH:mm 格式。');
    return value;
  }
  function parseWeeks(value, totalWeeks) {
    if (value == null || value === '') return [];
    if (Array.isArray(value)) {
      const values = value.map(v => integer(v, 1, 53, '周次'));
      if (values.includes(null)) throw new Error('周次中存在空值。');
      return [...new Set(values)].sort((a, b) => a - b);
    }
    let source = String(value).trim().replace(/第|周|\s/g, '').replace(/[，、；;]/g, ',').replace(/[~～—–至]/g, '-').replace(/（/g, '(').replace(/）/g, ')');
    if (!source) return [];
    const parity = source.includes('单') ? 1 : source.includes('双') ? 0 : null;
    if (source.includes('单') && source.includes('双')) throw new Error('请将单双周分别填写为明确周次。');
    source = source.replace(/\(?[单双]\)?/g, '');
    if (!source && parity !== null && totalWeeks) source = '1-' + totalWeeks;
    if (!source) throw new Error('仅填写单双周时，请先补充学期总周数。');
    const result = [];
    for (const part of source.split(',')) {
      const match = part.match(/^(\d{1,2})(?:-(\d{1,2}))?$/);
      if (!match) throw new Error('周次请填写为 1-16、1-16(单) 或 1-8,10-16。');
      const start = integer(match[1], 1, 53, '周次');
      const end = match[2] ? integer(match[2], 1, 53, '周次') : start;
      if (end < start) throw new Error('结束周次不能早于开始周次。');
      for (let i = start; i <= end; i++) if (parity === null || i % 2 === parity) result.push(i);
    }
    return [...new Set(result)].sort((a, b) => a - b);
  }
  function formatWeeks(weeks) {
    if (!weeks?.length) return '';
    const sorted = [...new Set(weeks)].sort((a, b) => a - b);
    const pieces = [];
    for (let i = 0; i < sorted.length; i++) {
      const start = sorted[i];
      while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
      pieces.push(start === sorted[i] ? String(start) : start + '-' + sorted[i]);
    }
    return pieces.join(',');
  }
  function normalize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('课表数据格式无效。');
    const totalWeeks = integer(input.totalWeeks, 1, 53, '学期总周数');
    const week1Monday = text(input.week1Monday, 10) || null;
    if (week1Monday && new Date(dateNumber(week1Monday)).getUTCDay() !== 1) throw new Error('第一教学周起始日期必须是周一。');
    if (!Array.isArray(input.courses) || input.courses.length > 150) throw new Error('课程列表无效，最多保存150条课程安排。');
    if (!Array.isArray(input.periods) || input.periods.length > 24) throw new Error('节次列表无效，最多24节。');
    const seen = new Set();
    const periods = input.periods.map(p => {
      if (!p || typeof p !== 'object') throw new Error('节次格式无效。');
      const section = integer(p.section, 1, 24, '节次');
      if (!section || seen.has(section)) throw new Error('节次不能为空或重复。');
      seen.add(section);
      const startTime = time(p.startTime), endTime = time(p.endTime);
      if (startTime && endTime && endTime <= startTime) throw new Error('节次结束时间必须晚于开始时间。');
      return { section, startTime, endTime };
    }).sort((a, b) => a.section - b.section);
    const courses = input.courses.map((c, i) => {
      if (!c || typeof c !== 'object') throw new Error('课程格式无效。');
      const name = text(c.name);
      if (!name) throw new Error('第' + (i + 1) + '条课程缺少名称，请填写或删除该行。');
      const startSection = integer(c.startSection, 1, 24, '开始节次');
      const endSection = integer(c.endSection, 1, 24, '结束节次');
      if (startSection && endSection && endSection < startSection) throw new Error(name + '的结束节次早于开始节次。');
      const weeks = parseWeeks(c.weeks, totalWeeks);
      if (totalWeeks && weeks.some(w => w > totalWeeks)) throw new Error(name + '的上课周次超出学期总周数。');
      return { name, dayOfWeek: integer(c.dayOfWeek, 1, 7, '星期'), startSection, endSection, weeks,
        location: text(c.location), teacher: text(c.teacher, 60) };
    });
    return { enabled: input.enabled !== false, termName: text(input.termName), week1Monday, totalWeeks, periods, courses,
      notes: text(input.notes, 2000) };
  }
  function warnings(table) {
    const result = [];
    if (!table.week1Monday) result.push('缺少第一教学周周一日期，无法确定今天是第几周。');
    if (!table.totalWeeks) result.push('学期总周数未填写，无法确定学期结束日期。');
    if (!table.courses.length) result.push('尚无课程记录，不能据此断定没有课。');
    const periods = new Map(table.periods.map(p => [p.section, p]));
    for (const c of table.courses) {
      const missing = [];
      if (!c.dayOfWeek) missing.push('星期');
      if (!c.startSection || !c.endSection) missing.push('节次');
      if (!c.weeks.length) missing.push('上课周次');
      if (!c.location) missing.push('地点');
      if (c.startSection && c.endSection && (!periods.get(c.startSection)?.startTime || !periods.get(c.endSection)?.endTime)) missing.push('实际钟点');
      if (missing.length) result.push(c.name + '待补充：' + missing.join('、'));
    }
    return result;
  }
  function beijing(now = new Date()) {
    const local = new Date(now.getTime() + 8 * 3600000);
    return { date: local.toISOString().slice(0, 10), time: local.toISOString().slice(11, 19),
      dayOfWeek: local.getUTCDay() || 7 };
  }
  function teachingWeek(table, date) {
    return table.week1Monday ? Math.floor((dateNumber(date) - dateNumber(table.week1Monday)) / (7 * DAY)) + 1 : null;
  }
  return { normalize, warnings, parseWeeks, formatWeeks, beijing, teachingWeek, weekdays };
});
