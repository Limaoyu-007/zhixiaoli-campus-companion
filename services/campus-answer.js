// Campus-only display helpers, 2026-10-22. Shared by main process and page.
(function (root) {
  'use strict';
  function stripThinking(value) {
    const text = String(value || '');
    const tags = /<\/?think\b[^>]*>/gi;
    let depth = 0;
    let cursor = 0;
    let result = '';
    let match;
    while ((match = tags.exec(text))) {
      if (depth === 0) result += text.slice(cursor, match.index);
      if (/^<\//.test(match[0])) depth = Math.max(0, depth - 1);
      else depth++;
      cursor = tags.lastIndex;
    }
    if (depth === 0) result += text.slice(cursor);
    return result.trim();
  }
  const helpers = { stripThinking };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  else root.CampusAnswer = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this);
