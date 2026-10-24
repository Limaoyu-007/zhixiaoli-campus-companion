// Campus answer presentation, 2026-10-22.
'use strict';

window.CampusMarkdown = {
  render(target, text) {
    const html = window.marked.parse(text, { gfm: true, breaks: true });
    const fragment = window.DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 's', 'ul', 'ol', 'li',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'blockquote', 'hr',
        'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'a'],
      ALLOWED_ATTR: ['href', 'title', 'align', 'start'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      RETURN_DOM_FRAGMENT: true,
    });
    target.replaceChildren(fragment);
  },
};
