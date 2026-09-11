module.exports = function (config) {
  config.addPassthroughCopy('src/img');
  // Without this the emitted site links a stylesheet that was never copied:
  // `_site/index.html` asks for `/css/site.css` and nothing puts it there. Eleventy
  // does not warn, so the build passed green while shipping a broken page — found
  // by the link check's baseline, which is the whole reason a baseline is run.
  config.addPassthroughCopy('src/css');
  return { dir: { input: 'src', output: '_site' } };
};
