# upfly

[![npm version](https://img.shields.io/npm/v/upfly.svg)](https://www.npmjs.com/package/upfly)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/ramin-010/upfly/actions/workflows/ci.yml/badge.svg)](https://github.com/ramin-010/upfly/actions/workflows/ci.yml)
[![downloads](https://img.shields.io/npm/dm/upfly.svg)](https://www.npmjs.com/package/upfly)

Upload & on‑the‑fly image conversion for Express. Uses Multer (peer) + Sharp.

This is the official upfly npm package for Express image uploads and conversion.

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

### Quick start

```js
const express = require('express');
const { upflyUpload } = require('upfly');

const app = express();

app.post(
  '/upload',
  upflyUpload({
    fields: {
      images: { output: 'memory', format: 'webp', quality: 80 },
      cover: { output: 'disk', format: 'jpeg', quality: 85 },
    },
    outputDir: './uploads',
    limit: 5 * 1024 * 1024, // 5 MB
  }),
  (req, res) => {
    res.json({ files: req.files, file: req.file });
  }
);
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
Conversion‑only middleware. Use when you supply your own Multer setup.

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

## Options
- `fields: Record<string, FieldConfig>`
  - `format`: "webp" | "jpeg" | "png" | "avif" (default: `webp`)
  - `quality`: `number` in 1–100 (default: `80`)
  - `output`: `'memory' | 'disk'` (default: `'memory'` in `upflyUpload`)
- `outputDir: string` directory used when any field has `output: 'disk'` (default: `./uploads`)
- `limit: number` file size in bytes for Multer memory storage (default: `5 * 1024 * 1024`)

## Path resolution and safety
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
