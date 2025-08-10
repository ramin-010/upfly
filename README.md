## Upfly — Elegant image upload & conversion for Express

[![npm version](https://img.shields.io/npm/v/upfly.svg)](https://www.npmjs.com/package/upfly)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/ramin-010/upfly/actions/workflows/ci.yml/badge.svg)](https://github.com/ramin-010/upfly/actions/workflows/ci.yml)
[![downloads](https://img.shields.io/npm/dm/upfly.svg)](https://www.npmjs.com/package/upfly)

[Website](https://ramin-010.github.io/upfly/)

Optimize images as they upload — one middleware, zero extra steps. Configure what you care about and Upfly handles the rest: safe paths, smart filenames, graceful fallbacks, and fast defaults.

- **Upload + convert**: Accept files and convert images to `webp/jpeg/png/avif`
- **Memory or disk**: Return converted buffers or save to disk
- **Safe paths**: Paths like `/uploads` resolve under your project root; one‑time dev warning explains normalization
- **Graceful fallback**: If conversion fails, files still pass through
- **Typed**: Ships `index.d.ts`

### Install

```bash
npm i upfly multer
# or
yarn add upfly multer
# or
pnpm add upfly multer
```

- Requires Node.js >= 18
- `multer` is a peer dependency (>=1.4 <3). You choose the version that fits your app

### Two APIs — use what fits your flow
- Add it once and stop worrying about image optimization and edge cases — forever.

```js
const { upflyUpload, upflyConvert } = require('upfly');
```
- `upflyUpload` (upload + convert): One middleware handles memory upload and image conversion. Save to memory or disk.
- `upflyConvert` (convert only): Want full control over your Multer logic? Use your own `upload.single/array/fields` and add conversion.

## Quick start (30 seconds)

```js
const express = require('express');
const { upflyUpload } = require('upfly');

const app = express();

app.post(
  '/upload',
  upflyUpload({
    fields: {
      images: {},               // defaults apply: memory + webp + q80
      cover: { output: 'disk' } // disk + webp + q80
    },
    outputDir: './uploads',
  }),
  (req, res) => res.json({ files: req.files })
);
```

## How it works

1. Upload with fast in‑process memory storage
2. Convert on‑the‑fly to your chosen format and quality
3. Return converted buffers (memory) or save to disk with safe paths and smart filenames

Unknown fields are ignored up front and never buffered.

## Why developers love Upfly

- ⚡ Instant conversion during upload (no extra step)
- 🛡️ Safe path handling and guardrails
- 🎯 Memory or disk, per field
- 📦 One middleware replaces boilerplate
- 🔒 Graceful fallbacks on failures
- 📝 Fully typed

## Configure it your way

### 1) Save to memory (ideal for cloud upload)
```js
upflyUpload({
  fields: {
    profilePic: { output: 'memory', format: 'webp', quality: 85 },
    gallery:    { output: 'memory', format: 'avif', quality: 75 },
  }
})
```

### 2) Save to disk
```js
upflyUpload({
  fields: {
    images:    { output: 'disk', format: 'webp', quality: 80 },
    documents: { output: 'disk' }, // non-images saved as-is
  },
  outputDir: './uploads'
})
```

### 3) Mixed scenarios
```js
upflyUpload({
  fields: {
    thumbnails: { output: 'memory', format: 'webp', quality: 60 },
    originals:  { output: 'disk', format: 'jpeg', quality: 95 },
    avatars:    { output: 'disk', format: 'avif', quality: 70 },
  },
  outputDir: './public/uploads',
})
```

### 4) Minimal config (you choose fields; defaults do the rest)
```js
upflyUpload({
  fields: {
    images: {},   // memory + webp + quality 80 (default)
    avatars: {},  // memory + webp + quality 80 (default)
  }
})
```

What happens under the hood when you provide only field names (empty configs):
- format: webp
- quality: 80
- output: memory
- mimetype updated accordingly (e.g., image/webp)
- unknown file fields are ignored (not buffered)
```

### 5) Complete API example
```js
const express = require('express');
const { upflyUpload } = require('upfly');

const app = express();

app.post('/upload',
  upflyUpload({
    fields: {
      images:    { output: 'memory', format: 'webp', quality: 80 },
      documents: { output: 'disk' }, // saved as-is
    },
    outputDir: './uploads',
    limit: 5 * 1024 * 1024,
  }),
  (req, res) => res.json({ message: 'Upload successful!', files: req.files })
);

app.listen(3000);
```

## API

### `upflyUpload(options)`
Handles upload (via Multer memory storage) and image conversion, and optionally saves to disk.

- When `output: 'memory'` (default):
  - Converted images are returned on `req.files[field][i].buffer`
  - `mimetype` is updated (e.g., `image/webp`)
- When `output: 'disk'`:
  - Files are saved to `outputDir`
  - Returned objects omit `buffer` and include `path` and `filename`
 - Unlisted fields:
   - File fields not present in `options.fields` are silently ignored (no Multer error)
   - Efficient: rejected by Multer `fileFilter` and never buffered

Example (saving to disk):
```js
app.post(
  '/upload-disk',
  upflyUpload({
    fields: { image: { output: 'disk', format: 'webp', quality: 80 } },
    outputDir: './uploads',
  }),
  (req, res) => res.json({ files: req.files })
);
```

### `upflyConvert(options)`
Conversion‑only middleware. Use when you supply your own upload setup.

```js
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const { upflyConvert } = require('upfly');

app.post(
  '/convert',
  upload.fields([{ name: 'images', maxCount: 10 }]),
  upflyConvert({ fields: { images: { format: 'webp', quality: 80 } } }),
  (req, res) => res.json({ files: req.files, file: req.file })
);
```

## Edge cases handled for you

- 🖼️ Non‑image files: pass through unchanged (memory) or saved as‑is (disk)
- 🔧 Conversion failures: original file returned/saved; your app stays stable
- 🛡️ Path security: paths like `/uploads` resolve safely under your project root
- 📁 Auto directory creation: `outputDir` is created if missing
- 🏷️ Smart filenames: `{fieldname?}-{slug(originalname)}-{xxxx}.{ext}`
- ⚡ Dev insights: optional conversion logs in development

## Options
- `fields: Record<string, FieldConfig>`
  - `format`: "webp" | "jpeg" | "png" | "avif" (default: `webp`)
  - `quality`: `number` in 1–100 (default: `80`)
  - `output`: `'memory' | 'disk'` (default: `'memory'` in `upflyUpload`)
- `outputDir: string` directory used when any field has `output: 'disk'` (default: `./uploads`)
- `limit: number` file size in bytes for Multer memory storage (default: `5 * 1024 * 1024`)

## Path safety (no surprises)
`outputDir` is normalized by the library to reduce surprises:

- Paths like `'/uploads'` or `'\\uploads'` are treated as project‑root relative and resolved under `process.cwd()` (equivalent to `'./uploads'`).
- In development, a one‑time notice explains the normalization and shows examples of truly absolute paths if you intend to write outside your project.
- To write outside the project root, pass an explicit absolute path:
  - Windows: `C:\\data\\uploads` or `D:/data/uploads`
  - Linux/Mac: `/var/data/uploads`

Examples:
```txt
'/uploads'   → <projectRoot>/uploads
'./uploads'  → <projectRoot>/uploads
'C:\\data\\uploads' → C:\\data\\uploads (absolute Windows path)
'/var/data/uploads'   → /var/data/uploads (absolute POSIX path)
```

## Behavior
- **Non‑image files**
  - `output: 'memory'`: passed through unchanged
  - `output: 'disk'`: saved as‑is to `outputDir`
- **Sharp conversion error**
  - `output: 'disk'`: raw file is saved with its original format
  - `output: 'memory'`: original file object is returned unchanged
- **Filenames when saving to disk**
  - `{fieldname?}-{slug(originalname)}-{xxxx}.{ext}`
  - Example: `images-summer-trip-2a3f.webp`
 - **Unknown fields**
   - Extra multipart file fields not configured in `fields` are skipped and not loaded into memory

## Types
`index.d.ts` includes typings for options and middleware signatures.

```ts
export interface FieldConfig {
  format?: 'webp' | 'jpeg' | 'png' | 'avif';
  quality?: number; // 1-100
  output?: 'memory' | 'disk';
}
```

## Notes
- Sharp may require platform‑specific prerequisites. See the Sharp docs if your environment needs additional packages.

## License
MIT
