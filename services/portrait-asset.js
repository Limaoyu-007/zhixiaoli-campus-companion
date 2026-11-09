'use strict';
const fs = require('fs');
const path = require('path');
const { fileURLToPath, pathToFileURL } = require('url');

// Preserve uploaded images; only canonicalize the bundled portrait and its
// historical workspace alias, which was saved as custom_image by older builds.
function resolvePortraitURL(saved, root) {
  const bundled = path.join(root, 'assets', 'zhixiaoli', 'portrait.png');
  const canonical = pathToFileURL(bundled).href;
  if (!saved) return canonical;
  try {
    const candidate = fileURLToPath(saved);
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (key(path.normalize(candidate)) === key(path.normalize('D:/zhixiaoli/OpenDesktop-Pet/assets/zhixiaoli/portrait.png')))
      return canonical;
    if (key(fs.realpathSync(candidate)) === key(fs.realpathSync(bundled))) return canonical;
  } catch (_) { /* Non-file URLs and missing custom images retain their identity. */ }
  return saved;
}
module.exports = { resolvePortraitURL };
