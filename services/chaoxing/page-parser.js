'use strict';
const { load } = require('cheerio');
const { ChaoxingError } = require('./errors');
const compact = value => String(value || '').replace(/\s+/g, ' ').trim();

function courseFromURL(value) {
  let url;
  try { url = new URL(value, 'https://mooc1.chaoxing.com'); } catch (_) { return null; }
  if (!url.pathname.endsWith('/visit/stucoursemiddle')) return null;
  const courseId = url.searchParams.get('courseid'), classId = url.searchParams.get('clazzid'), cpi = url.searchParams.get('cpi');
  if (![courseId, classId, cpi].every(value => /^\d{1,30}$/.test(value || ''))) return null;
  return { courseId, classId, cpi, key: [courseId, classId, cpi].join(':') };
}
function courseName($, element) {
  let node = $(element);
  for (let depth = 0; node.length && depth < 6; depth++, node = node.parent()) {
    const names = node.find('[class*="course-name"][title]').add(node.filter('[class*="course-name"][title]'));
    const values = [...new Set(names.map((_i, item) => compact($(item).attr('title'))).get().filter(Boolean))];
    if (values.length === 1) return values[0].slice(0, 200);
    if (values.length > 1) break;
  }
  return '';
}
function parseCourses(html) {
  const $ = load(html), courses = new Map();
  $('[href]').each((_i, element) => {
    const course = courseFromURL($(element).attr('href'));
    if (!course) return;
    const name = courseName($, element);
    const previous = courses.get(course.key);
    courses.set(course.key, { ...course, name: name || previous?.name || '' });
  });
  // Preserve the Java client's fallback for course links embedded outside href attributes.
  const pattern = /stucoursemiddle\?courseid=(\d+)(?:&amp;|&)clazzid=(\d+)(?:&amp;|&)cpi=(\d+)/g;
  const matches = [...html.matchAll(pattern)];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index], course = courseFromURL('/visit/' + match[0].replace(/&amp;/g, '&'));
    if (!course || courses.get(course.key)?.name) continue;
    const end = Math.min(match.index + match[0].length + 1600, matches[index + 1]?.index || html.length);
    const fragment = load(html.slice(match.index + match[0].length, end));
    const name = compact(fragment('[class*="course-name"][title]').first().attr('title')).slice(0, 200);
    courses.set(course.key, { ...course, name });
  }
  if (courses.size > 500) throw new ChaoxingError('COURSE_LIMIT', '课程数量超出本次读取范围，未进行不完整查询。');
  if (!courses.size) throw new ChaoxingError('COURSE_LIST_PARSE_FAILED', '未识别到课程列表，可能是登录失效、暂无课程或页面结构变化，不能据此断言没有作业。');
  return [...courses.values()];
}
function hiddenValue(html, id) {
  const $ = load(html);
  return $('input').filter((_i, element) => $(element).attr('id') === id).first().attr('value') || '';
}
function isLoginPage(response) {
  const url = new URL(response.url);
  if (url.hostname === 'passport2.chaoxing.com' && /login/i.test(url.pathname)) return true;
  const $ = load(response.body);
  return $('input[type="password"]').length > 0 && /登录|login/i.test(response.body);
}
function visibleText($) {
  const body = $('body').clone();
  body.find('script,style,template,[hidden]').remove();
  body.find('*').each((_i, element) => {
    const item = $(element);
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(item.attr('style') || '') ||
        /(?:^|\s)(?:hide|hidden|dn)(?:\s|$)/.test(item.attr('class') || '')) item.remove();
  });
  return compact(body.text());
}
function parseHomework(html) {
  const $ = load(html);
  const text = visibleText($);
  if (/没有此页面访问权限|无权访问|无访问权限/.test(text)) throw new ChaoxingError('SIGNATURE_REJECTED', '学习通作业页签名校验失败，未取得作业列表。');
  const rows = $('li[onclick]').filter((_i, element) => /goTask\s*\(/.test($(element).attr('onclick') || ''));
  if ($('li p.overHidden2').length > rows.length) throw new ChaoxingError('HOMEWORK_PARSE_FAILED', '页面存在未能识别的作业候选条目，未返回不完整列表。');
  const items = [];
  rows.each((_i, element) => {
    const row = $(element), title = compact(row.find('p.overHidden2').first().text());
    if (!title) throw new ChaoxingError('HOMEWORK_PARSE_FAILED', '识别到作业条目但无法读取名称，页面可能已变化。');
    items.push({ title: title.slice(0, 500), status: compact(row.find('p.status').first().text()).slice(0, 120) || '状态未知' });
  });
  if (items.length > 200) throw new ChaoxingError('HOMEWORK_LIMIT', '作业数量超过本次读取范围，未返回不完整列表。');
  const match = html.match(/<span[^>]*>\s*(\d+)\s*\/\s*(\d+)\s*<\/span>\s*<\/div>\s*<\/div>/i);
  const progress = match ? match[1] + '/' + match[2] : null;
  const confirmedEmpty = /暂无(?:相关)?作业|没有(?:相关)?作业|还没有(?:发布)?作业|未发布作业/.test(text) ||
    (progress === '0/0' && /作业/.test(text));
  if (!items.length && !confirmedEmpty) throw new ChaoxingError('HOMEWORK_PARSE_FAILED', '未识别到作业条目，也没有明确的空列表标记，不能判断没有作业。');
  if (!items.length && progress && Number(match[2]) > 0) throw new ChaoxingError('HOMEWORK_PARSE_FAILED', '作业进度显示存在记录，但未解析到列表，不能判断没有作业。');
  return { progress, items, confirmedEmpty: items.length === 0 };
}
module.exports = { parseCourses, hiddenValue, isLoginPage, parseHomework };
