'use strict';

/**
 * End-to-end smoke tests for the v2 middleware line.
 *
 * These drive real multipart HTTP requests through upflyUpload/upflyConvert against a
 * plain node:http server — no express, no test framework, no mocks of sharp. They exist
 * so CI proves the published package actually works, rather than only that it packs.
 *
 * Run: npm test   (node --test)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const multer = require('multer');

const { upflyUpload, upflyConvert } = require('../src/index.js');

// Relative to cwd on purpose: ensureServerRootDir() deliberately re-roots
// slash-prefixed paths under the project directory, so an absolute POSIX path
// would not land where a test expects.
const TMP_DIR = `./.tmp-test-${process.pid}`;

test.after(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

const makePng = (width = 64, height = 64) =>
  sharp({ create: { width, height, channels: 3, background: { r: 220, g: 40, b: 40 } } })
    .png()
    .toBuffer();

const isWebp = (buf) =>
  buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
  buf.subarray(8, 12).toString('latin1') === 'WEBP';

const isPng = (buf) => buf.length >= 8 && buf.subarray(1, 4).toString('latin1') === 'PNG';

/** Serialise req.files into something JSON-safe that still lets us assert on bytes. */
function describeFiles(files) {
  const out = {};
  for (const [field, list] of Object.entries(files || {})) {
    out[field] = list.map((f) => ({
      originalname: f.originalname,
      mimetype: f.mimetype,
      size: f.size,
      path: f.path,
      head: f.buffer ? f.buffer.subarray(0, 16).toString('hex') : null,
      bufferLength: f.buffer ? f.buffer.length : null,
      metadata: f._metadata ?? null,
    }));
  }
  return out;
}

/** Start a one-shot server running `middleware`, POST `form` to it, return parsed JSON. */
async function postForm(middleware, form) {
  const server = http.createServer((req, res) => {
    middleware(req, res, (err) => {
      res.setHeader('content-type', 'application/json');
      if (err) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: err.message }));
      }
      res.end(JSON.stringify({ files: describeFiles(req.files) }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/upload`, { method: 'POST', body: form });
    const body = await response.json();
    assert.equal(response.status, 200, `server error: ${body.error}`);
    return body;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Chain multer(memoryStorage) -> upflyConvert, the documented upflyConvert setup. */
function chain(...middlewares) {
  return (req, res, next) => {
    let i = 0;
    const run = (err) => {
      if (err || i >= middlewares.length) return next(err);
      middlewares[i++](req, res, run);
    };
    run();
  };
}

// ---------------------------------------------------------------- tests

test('upflyUpload converts an uploaded PNG to WebP in memory', async () => {
  const png = await makePng();
  const form = new FormData();
  form.append('img', new Blob([png], { type: 'image/png' }), 'photo.png');

  const { files } = await postForm(
    upflyUpload({ fields: { img: { format: 'webp', quality: 80 } } }),
    form
  );

  assert.ok(files.img, 'expected req.files.img');
  assert.equal(files.img.length, 1);

  const file = files.img[0];
  assert.equal(file.mimetype, 'image/webp');
  assert.ok(isWebp(Buffer.from(file.head, 'hex')), 'buffer should carry WebP magic bytes');
  assert.ok(file.bufferLength > 0, 'converted buffer should not be empty');
  assert.equal(file.size, file.bufferLength, 'size should match the converted buffer length');
});

test('upflyUpload honours keepOriginal (no conversion)', async () => {
  const png = await makePng();
  const form = new FormData();
  form.append('raw', new Blob([png], { type: 'image/png' }), 'keep.png');

  const { files } = await postForm(
    upflyUpload({ fields: { raw: { keepOriginal: true } } }),
    form
  );

  const file = files.raw[0];
  assert.ok(isPng(Buffer.from(file.head, 'hex')), 'should still be a PNG');
  assert.equal(file.bufferLength, png.length, 'bytes should pass through untouched');
});

test('upflyUpload writes converted files to disk with output: disk', async () => {
  const png = await makePng();
  const form = new FormData();
  form.append('img', new Blob([png], { type: 'image/png' }), 'disk.png');

  const { files } = await postForm(
    upflyUpload({
      fields: { img: { format: 'webp', output: 'disk' } },
      outputDir: TMP_DIR,
    }),
    form
  );

  const file = files.img[0];
  assert.ok(file.path, 'expected a path for disk output');
  assert.ok(fs.existsSync(file.path), `file should exist at ${file.path}`);
  assert.equal(path.extname(file.path), '.webp');
  assert.ok(isWebp(fs.readFileSync(file.path)), 'file on disk should be a real WebP');
});

test('upflyUpload passes non-image files through untouched', async () => {
  const text = Buffer.from('plain text attachment, not an image');
  const form = new FormData();
  form.append('doc', new Blob([text], { type: 'text/plain' }), 'notes.txt');

  const { files } = await postForm(
    upflyUpload({ fields: { doc: {} } }),
    form
  );

  const file = files.doc[0];
  assert.equal(file.bufferLength, text.length);
  assert.equal(file.head, text.subarray(0, 16).toString('hex'), 'leading bytes should be unchanged');
});

test('upflyUpload supports wildcard field names', async () => {
  const png = await makePng();
  const form = new FormData();
  form.append('image_hero', new Blob([png], { type: 'image/png' }), 'hero.png');
  form.append('image_thumb', new Blob([png], { type: 'image/png' }), 'thumb.png');

  const { files } = await postForm(
    upflyUpload({ fields: { 'image_*': { format: 'webp' } } }),
    form
  );

  assert.ok(files.image_hero && files.image_thumb, 'both wildcard fields should be captured');
  for (const field of ['image_hero', 'image_thumb']) {
    assert.ok(isWebp(Buffer.from(files[field][0].head, 'hex')), `${field} should be WebP`);
  }
});

test('upflyConvert converts buffers already parsed by multer', async () => {
  const png = await makePng();
  const form = new FormData();
  form.append('avatar', new Blob([png], { type: 'image/png' }), 'avatar.png');

  const { files } = await postForm(
    chain(
      multer({ storage: multer.memoryStorage() }).fields([{ name: 'avatar', maxCount: 1 }]),
      upflyConvert({ fields: { avatar: { format: 'webp', quality: 70 } } })
    ),
    form
  );

  const file = files.avatar[0];
  assert.equal(file.mimetype, 'image/webp');
  assert.ok(isWebp(Buffer.from(file.head, 'hex')), 'upflyConvert should emit WebP');
});

test('upflyUpload rejects invalid configuration eagerly', () => {
  assert.throws(() => upflyUpload({ fields: 'nope' }), TypeError);
  assert.throws(() => upflyUpload({ fields: { a: { quality: 500 } } }), RangeError);
  assert.throws(() => upflyUpload({ fields: { a: { output: 'ftp' } } }), RangeError);
  assert.throws(
    () => upflyUpload({ fields: { a: { cloudStorage: true, output: 'disk' } } }),
    /cloud storage requires output/i
  );
});
