(() => {
'use strict';
const api = window.electronAPI;
const U = window.TimetableUtils;
const root = document.getElementById('timetable-editor');
const embedded = Boolean(root);
const $ = id => document.getElementById((embedded ? 'tt-' : '') + id);
const notify = () => { if (embedded) window.dispatchEvent(new Event('timetable-editor-state')); };
let loaded = false, busy = false, recognizing = false, dirty = false, selectedSource = null, draftSourceId = null;
let externalLocked = false;
let savedSource = false, imagePages = [], pdfModule = null, generation = 0;
const blank = () => ({ enabled: true, termName: '', week1Monday: null, totalWeeks: null, courses: [], periods: [], notes: '' });
function status(message) { $('status').textContent = message; }
function controls() {
  for (const id of ['import', 'refresh', 'clear', 'add-course', 'add-period', ...(embedded ? [] : ['save'])]) $(id).disabled = !loaded || busy || externalLocked;
  $('parse').disabled = !loaded || busy || externalLocked || !selectedSource || !imagePages.length;
  $('show-source').disabled = !loaded || busy || externalLocked || !savedSource || Boolean(draftSourceId);
  $('cancel').hidden = !recognizing;
  for (const item of (root || document.querySelector('main')).querySelectorAll('input, select, textarea, td button')) item.disabled = !loaded || busy || externalLocked;
  notify();
}
function input(name, value, type = 'text', placeholder = '') {
  const element = document.createElement('input');
  element.dataset.field = name;
  element.type = type;
  element.value = value ?? '';
  element.placeholder = placeholder;
  if (type === 'number') { element.min = '1'; element.max = '24'; }
  else if (type === 'text') element.maxLength = name === 'weeks' ? 180 : 120;
  element.addEventListener('input', changed);
  return element;
}
function cell(row, child) { const td = row.insertCell(); td.append(child); }
function removeButton(row) {
  const button = document.createElement('button');
  button.textContent = '×';
  button.type = 'button';
  button.setAttribute('aria-label', '删除这一行');
  button.addEventListener('click', () => { row.remove(); changed(); });
  return button;
}
function courseRow(course = {}) {
  const row = $('courses').tBodies[0].insertRow();
  cell(row, input('name', course.name, 'text', '课程名称'));
  const day = document.createElement('select'); day.dataset.field = 'dayOfWeek';
  ['', ...U.weekdays].forEach((label, i) => {
    const option = document.createElement('option'); option.value = i ? String(i) : ''; option.textContent = label || '待补充'; day.append(option);
  });
  day.value = course.dayOfWeek || ''; day.addEventListener('change', changed); cell(row, day);
  cell(row, input('startSection', course.startSection, 'number'));
  cell(row, input('endSection', course.endSection, 'number'));
  cell(row, input('weeks', U.formatWeeks(course.weeks), 'text', '待补充'));
  cell(row, input('location', course.location, 'text', '待补充'));
  cell(row, input('teacher', course.teacher, 'text'));
  cell(row, removeButton(row));
}
function periodRow(period = {}) {
  const row = $('periods').tBodies[0].insertRow();
  cell(row, input('section', period.section, 'number'));
  cell(row, input('startTime', period.startTime, 'time'));
  cell(row, input('endTime', period.endTime, 'time'));
  cell(row, removeButton(row));
}
function rows(id) {
  return [...$(id).tBodies[0].rows].map(row => Object.fromEntries([...row.querySelectorAll('[data-field]')].map(el => [el.dataset.field, el.value.trim()])));
}
function collect() {
  return U.normalize({ enabled: $('enabled').checked, termName: $('term-name').value,
    week1Monday: $('week-monday').value, totalWeeks: $('total-weeks').value,
    courses: rows('courses'), periods: rows('periods'), notes: $('notes').value });
}
function showWarnings(notes = []) {
  try {
    const table = collect();
    const warnings = [...new Set([...notes, ...U.warnings(table)])];
    $('warnings').textContent = warnings.join('\n');
    if (embedded) {
      const overview = $('overview');
      overview.textContent = table.courses.length
        ? table.courses.length + ' 条课程安排 · ' + (warnings.length ? '有 ' + warnings.length + ' 项信息待核对，请查看下方提示。' : '日期、周次与节次信息已填写，可保存后用于查询。')
        : '还没有课程安排。可以导入识别，也可以直接添加课程。';
      overview.dataset.state = warnings.length ? 'incomplete' : 'ready';
      $('week-monday').dataset.incomplete = String(!table.week1Monday);
      $('total-weeks').dataset.incomplete = String(!table.totalWeeks);
    }
  }
  catch (error) { $('warnings').textContent = error.message; }
}
function changed() { dirty = true; showWarnings(); notify(); }
function render(table, warnings = []) {
  table ||= blank();
  $('enabled').checked = table.enabled !== false;
  $('term-name').value = table.termName || '';
  $('week-monday').value = table.week1Monday || '';
  $('total-weeks').value = table.totalWeeks || '';
  $('notes').value = table.notes || '';
  $('courses').tBodies[0].replaceChildren();
  $('periods').tBodies[0].replaceChildren();
  table.courses.forEach(courseRow); table.periods.forEach(periodRow);
  $('saved-info').textContent = table.updatedAt ? '上次保存：' + new Date(table.updatedAt).toLocaleString('zh-CN') : '当前为草稿，保存后才用于聊天。';
  showWarnings(warnings);
}
function checkResult(result) { if (!result.ok) throw new Error(result.error || '操作失败。'); return result; }
function canReplace() { return !dirty || window.confirm('当前有未保存的课表修改，继续将放弃这些修改？'); }
async function refresh() {
  if (!canReplace()) return;
  busy = true; controls();
  try {
    const result = checkResult(await api.campusGetTimetable());
    render(result.table, result.warnings); dirty = false; draftSourceId = null;
    selectedSource = null; imagePages = []; savedSource = Boolean(result.table?.source);
    $('preview').replaceChildren();
    if (embedded) root.querySelector('.timetable-source').open = false;
    $('source-name').textContent = result.table?.source?.name || '支持图片或 PDF；也可直接手动填写。';
    status(result.table ? '已读取本地课表。' : '还没有个人课表。导入识别或手动填写后保存。');
  } catch (error) { status(error.message); }
  finally { busy = false; controls(); }
}
async function loadPdfModule() {
  if (!pdfModule) {
    pdfModule = await import('../node_modules/pdfjs-dist/legacy/build/pdf.mjs');
    pdfModule.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', location.href).href;
  }
  return pdfModule;
}
function jpeg(source, width, height) {
  if (!width || !height || width * height > 80000000) throw new Error('图片尺寸过大或无法读取，请先缩小图片。');
  const scale = Math.min(1, 2600 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const result = canvas.toDataURL('image/jpeg', .92); canvas.width = canvas.height = 1;
  return result;
}
async function sourceImages(source, epoch) {
  const bytes = new Uint8Array(source.bytes);
  if (source.mime !== 'application/pdf') {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: source.mime }));
    try { return [jpeg(bitmap, bitmap.width, bitmap.height)]; }
    finally { bitmap.close(); }
  }
  const pdfjs = await loadPdfModule();
  const root = new URL('../node_modules/pdfjs-dist/', location.href);
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false,
    cMapUrl: new URL('cmaps/', root).href, cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', root).href, wasmUrl: new URL('wasm/', root).href });
  // Password-protected PDFs need an unlocked copy, not an indefinite prompt callback.
  task.onPassword = () => { void task.destroy(); };
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 6) throw new Error('这份PDF超过6页，请先导出课表所在页。');
    const result = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      if (epoch !== generation) throw new Error('文件读取已取消。');
      const page = await pdf.getPage(i), natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(3, 2600 / Math.max(natural.width, natural.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, background: 'rgb(255,255,255)' }).promise;
        result.push(canvas.toDataURL('image/jpeg', .92));
      } finally { canvas.width = canvas.height = 1; page.cleanup(); }
    }
    return result;
  } finally { await task.destroy(); }
}
async function previewSource(source) {
  const epoch = ++generation;
  const pages = await sourceImages(source, epoch);
  if (epoch !== generation) return;
  if (pages.reduce((n, p) => n + p.length, 0) > 28 * 1024 * 1024) throw new Error('图片合计过大，请压缩或拆分文件。');
  const images = pages.map((url, i) => {
    const image = document.createElement('img'); image.src = url; image.alt = '课表第' + (i + 1) + '页'; return image;
  });
  $('preview').replaceChildren(...images);
  if (embedded) root.querySelector('.timetable-source').open = true;
  $('source-name').textContent = source.name + ' · ' + pages.length + '页';
  selectedSource = source; imagePages = pages;
}
$('import').addEventListener('click', async () => {
  busy = true; controls();
  try {
    const result = checkResult(await api.campusSelectTimetable());
    if (result.cancelled) return;
    // Keep the existing draft linked to its recognized original until a new parse succeeds.
    selectedSource = null; imagePages = [];
    status('正在读取课表文件…');
    await previewSource(result.source);
    status('文件已载入。点击“识别为课表草稿”，识别后核对并保存。已保存的课表仍然生效。');
  } catch (error) { status('文件读取失败：' + error.message + ' 加密PDF请先导出未加密版本。'); }
  finally { busy = false; controls(); }
});
$('show-source').addEventListener('click', async () => {
  busy = true; controls(); status('正在读取原课表…');
  try {
    const result = checkResult(await api.campusTimetableSource());
    draftSourceId = null; selectedSource = null; imagePages = [];
    await previewSource(result.source); status('已显示原课表，可对照修改或重新识别。');
  } catch (error) { status(error.message); }
  finally { busy = false; controls(); }
});
$('parse').addEventListener('click', async () => {
  if (!canReplace()) return;
  if (embedded && !await window.CampusSettings.saveConfiguration()) return;
  busy = true; recognizing = true; controls(); status('正在用百炼识别课表，完成后请核对草稿…');
  const epoch = ++generation;
  try {
    const result = checkResult(await api.campusParseTimetable({ sourceId: selectedSource.sourceId, images: imagePages }));
    if (epoch !== generation) return;
    render(result.table, result.warnings); draftSourceId = result.sourceId; dirty = true;
    status('识别完成，尚未保存。请核对星期、节次和单双周，补充第一周日期及节次钟点。');
  } catch (error) { if (epoch === generation) status(error.message); }
  finally { busy = false; recognizing = false; controls(); }
});
$('cancel').addEventListener('click', async () => {
  generation++;
  try { checkResult(await api.campusCancelTimetable()); status('识别已停止，已保存的课表未改动。'); }
  catch (error) { status(error.message); }
});
async function saveDraft() {
  if (!dirty) return;
  if (!loaded || busy) throw new Error('课表正在处理中，请稍后保存。');
  busy = true; controls();
  try {
    const table = collect();
    const result = checkResult(await api.campusSaveTimetable({ table, sourceId: draftSourceId }));
    render(result.table, result.warnings); savedSource = Boolean(result.table.source); dirty = false; draftSourceId = null;
    status(table.enabled ? '课表已保存在本机，从下一条聊天开始使用。' : '课表已保存，聊天中使用课表已关闭。');
  } catch (error) { status(error.message); throw error; }
  finally { busy = false; controls(); }
}
if (!embedded) $('save').addEventListener('click', () => { void saveDraft().catch(() => {}); });
if (embedded) window.CampusTimetableEditor = {
  get dirty() { return dirty; }, get busy() { return busy; },
  validate() { if (dirty) collect(); }, save: saveDraft,
  setLocked(value) {
    if (externalLocked === value) return;
    externalLocked = value;
    controls();
  },
};
$('clear').addEventListener('click', async () => {
  if (!window.confirm('清空本机课表及保存的原文件？长期记忆和已有预约不受影响。')) return;
  busy = true; controls();
  try {
    checkResult(await api.campusClearTimetable());
    render(null); selectedSource = null; draftSourceId = null; imagePages = []; savedSource = false; dirty = false;
    $('preview').replaceChildren(); $('source-name').textContent = '课表已清空。';
    status('已清空本机课表。下一条消息不再附上课表；新会话可移除平台旧对话中的课表背景。');
  } catch (error) { status(error.message); }
  finally { busy = false; controls(); }
});
if (!embedded) $('open-model-settings').addEventListener('click', () => api.openSettingsWindow('timetable'));
function modelInfo(config) {
  if (embedded) return;
  $('model-info').textContent = '视觉模型：' + config.timetable.model + ' · '
    + (config.timetable.has_api_key ? '已有百炼凭据配置。' : '尚未配置百炼凭据，请前往设置填写并保存。');
}
api.onConfigUpdated(modelInfo);
$('add-course').addEventListener('click', () => { courseRow(); changed(); });
$('add-period').addEventListener('click', () => {
  const used = rows('periods').map(p => Number(p.section));
  const next = Array.from({ length: 24 }, (_, i) => i + 1).find(i => !used.includes(i));
  if (!next) { status('最多支持24节。'); return; }
  periodRow({ section: next }); changed();
});
for (const id of ['enabled', 'term-name', 'week-monday', 'total-weeks', 'notes']) $(id).addEventListener('input', changed);
$('refresh').addEventListener('click', refresh);
window.addEventListener('pagehide', () => { generation++; void api.campusCancelTimetable(); });
controls();
void (async () => {
  try {
    const config = await api.getConfig();
    modelInfo(config);
    loaded = true; await refresh();
  } catch (error) { status(error.message); controls(); }
})();

})();
