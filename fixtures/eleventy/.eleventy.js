module.exports = function (config) {
  config.addPassthroughCopy('src/img');
  return { dir: { input: 'src', output: '_site' } };
};
