// CommonJS, because a repository built over ten years has both.

const icon192 = require('../../public/icons/icon-192.png');
const icon512 = require('../../public/icons/icon-512.png');
const favicon = require('../../public/favicon.png');

module.exports = {
  icons: [icon192, icon512],
  shortcut: '/favicon.png',
  maskable: '/icons/mask.svg',
  missing: '/icons/icon-1024.png',
  packaged: require('some-ui-kit/dist/icon.png'),
};
