'use strict';
const fs = require('fs');
const path = require('path');

module.exports = context => {
  if (context.electronPlatformName !== 'win32') return;
  const root = path.join(context.packager.appDir, '.runtime', 'tts-python');
  const required = ['python.exe', 'python313.dll', 'python313.zip', 'python313._pth',
    'Lib/site-packages/edge_tts/__main__.py'];
  if (required.some(file => !fs.existsSync(path.join(root, file)))) {
    throw new Error('Windows朗读运行环境不完整，请先运行 npm run prepare:tts，再制作安装包。');
  }
};
