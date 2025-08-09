# upfly

Upload & on-the-fly image conversion for Express (Multer peer + Sharp).

## Install

```bash
npm i upfly sharp multer
# or
yarn add upfly sharp multer
```

- Requires Node.js >= 18
- `multer` is a peer dependency: you control its version (>=1.4 <3)

## API

### upflyUpload(options)
Handles upload (via memory storage) + conversion/saving.

```js
const express = require('express');
const { upflyUpload } = require('upfly');

const app = express();

app.post(
  '/upload',
  upflyUpload({
    fields: {
      images1: { output: 'disk', quality: 50, format: 'webp' },
      images2: { output: 'memory', quality: 80, format: 'jpeg' }
    },
    outputDir: './uploads',
    limit: 5 * 1024 * 1024
  }),
  (req, res) => {
    res.json({ files: req.files, file: req.file });
  }
);
```

### upflyConvert(options)
Conversion-only middleware for already-uploaded files (e.g., if you supply your own multer).

```js
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });
const { upflyConvert } = require('upfly');

app.post(
  '/convert',
  upload.fields([{ name: 'images', maxCount: 10 }]),
  upflyConvert({ fields: { images: { format: 'webp', quality: 80 } } }),
  (req, res) => {
    res.json({ files: req.files, file: req.file });
  }
);
```

## Options
- fields: Record<string, FieldConfig>
  - format: "webp" | "jpeg" | "png" | "avif" (default: webp)
  - quality: number (1-100, default: 80)
  - output: 'memory' | 'disk' (default: memory in uploadAndWebify)
- outputDir: string path for disk saves (default: ./uploads)
- limit: file size in bytes (default: 5MB)


## Behavior
- Non-image files are passed through unchanged (memory) or saved as-is (disk).
- On sharp conversion error:
  - disk: raw file is saved with original format
  - memory: original file is returned unchanged

## Types
`index.d.ts` includes typings for options and middleware signatures.

## License
MIT
