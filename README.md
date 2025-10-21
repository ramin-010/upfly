# 🚀 Upfly

> **Stop wrestling with file uploads. Start flying.**

[![npm version](https://img.shields.io/npm/v/upfly.svg)](https://www.npmjs.com/package/upfly)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/ramin-010/upfly/actions/workflows/ci.yml/badge.svg)](https://github.com/ramin-010/upfly/actions/workflows/ci.yml)
[![downloads](https://img.shields.io/npm/dm/upfly.svg)](https://www.npmjs.com/package/upfly)

**The all-in-one Express middleware that turns file upload chaos into a single line of code.**

[🌐 Website](https://ramin-010.github.io/upfly/) • [📖 Docs](https://ramin-010.github.io/upfly/) • [💬 Support](https://github.com/ramin-010/upfly/issues)

---

## 😩 The Problem

Building file uploads in Express feels like this:

```js
// The old way: A nightmare of boilerplate
const multer = require('multer');
const sharp = require('sharp');
const cloudinary = require('cloudinary');
const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');

// 50+ lines of storage configuration...
// Error handling for each step...
// Manual image optimization...
// Cloud upload logic...
// Cleanup and fallbacks...
// Different code for each provider...

// And you STILL don't have proper error handling! 😱
```

**Sound familiar?** You wanted to upload an image, not build a file processing pipeline.

---

## ✨ The Solution

```js
// The Upfly way: One line, infinite possibilities
const { upflyUpload } = require('upfly');

app.post('/upload', 
  upflyUpload({
    fields: {
      avatar: { 
        cloudStorage: true,
        cloudProvider: 'cloudinary',
        cloudConfig: { cloud_name: 'demo', api_key: 'key', api_secret: 'secret' }
      }
    }
  }),
  (req, res) => res.json({ url: req.files.avatar[0].cloudUrl })
);

// That's it. Production-ready uploads with optimization and cloud storage. 🎉
```

---

## 🎯 Why Developers Choose Upfly

### ⚡ **Instant Setup**
- One middleware replaces 200+ lines of boilerplate
- Works with your existing Express app
- Zero configuration files needed
- Production-ready in 30 minutes

### 🌍 **Multi-Cloud Ready**
- **Cloudinary** - Images & videos with transformations
- **AWS S3** - Scalable object storage with custom domains
- **Google Cloud Storage** - Enterprise-grade storage
- Switch providers with one line change
- Provider-agnostic API design

### 🛡️ **Production Hardened**
- Automatic backup fallback system (`safeFile` option)
- Memory-efficient streaming for large files (>7MB threshold)
- Stream-based, non-blocking I/O architecture
- Graceful error handling (your app never crashes)
- Smart cleanup and temp file management
- Automatic temp file cleanup on process exit

### 🎨 **Smart Image Processing**
- Auto-convert to WebP, AVIF, JPEG, PNG, TIFF, GIF, HEIF
- Quality control (1-100 scale)
- Format validation (only Sharp-supported formats)
- Quality optimization (save 60-80% file size)
- Maintains aspect ratios
- `keepOriginal` option to skip conversion

---

## 🚀 Quick Start (30 seconds)

### 1. Install
```bash
npm install upfly multer
```

### 2. Basic Upload
```js
const express = require('express');
const { upflyUpload } = require('upfly');

const app = express();

app.post('/upload',
  upflyUpload({
    fields: {
      images: { format: 'webp', quality: 80 }  // Auto-optimized!
    }
  }),
  (req, res) => res.json({ files: req.files })
);

app.listen(3000);
```

### 3. Test it
```bash
curl -X POST -F "images=@photo.jpg" http://localhost:3000/upload
```

**That's it!** Your image is now optimized and ready to use.

---

## 🌟 Real-World Examples

### 📸 **Profile Pictures with Cloudinary**
```js
upflyUpload({
  fields: {
    avatar: {
      cloudStorage: true,
      cloudProvider: 'cloudinary',
      cloudConfig: {
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        folder: 'avatars'
      },
      format: 'webp',
      quality: 85
    }
  }
})

// Result: req.files.avatar[0].cloudUrl
// → https://res.cloudinary.com/demo/image/upload/avatars/abc123.webp
```

### 🏢 **Enterprise Storage with AWS S3**
```js
upflyUpload({
  fields: {
    documents: {
      cloudStorage: true,
      cloudProvider: 's3',
      cloudConfig: {
        region: 'us-east-1',
        bucket: 'my-app-uploads',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        acl: 'public-read'
      }
    }
  }
})

// Result: req.files.documents[0].cloudUrl
// → https://my-app-uploads.s3.us-east-1.amazonaws.com/documents/file-abc123.pdf
```

### 🎨 **Multi-Format Gallery**
```js
upflyUpload({
  fields: {
    thumbnails: { format: 'webp', quality: 60, output: 'memory' },
    originals: { format: 'jpeg', quality: 95, output: 'disk' },
    previews: { 
      cloudStorage: true,
      cloudProvider: 'gcs',
      cloudConfig: {
        bucket: 'my-gallery-bucket',
        keyFilename: './service-account.json'
      },
      format: 'avif',
      quality: 70
    }
  },
  outputDir: './uploads',
  safeFile: true  // Enable backup fallback
})
```

---

## 🔧 Complete API Reference

### `upflyUpload(options)`

The main middleware that handles everything.

#### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `fields` | `object` | `{}` | Field configurations (see below) |
| `outputDir` | `string` | `'./uploads'` | Directory for disk storage |
| `limit` | `number` | `10MB` | Max file size in bytes |
| `safeFile` | `boolean` | `false` | Enable backup fallback system |

#### Field Configuration

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `format` | `string` | `'webp'` | Output format: `webp`, `jpeg`, `png`, `avif` |
| `quality` | `number` | `80` | Compression quality (1-100) |
| `output` | `string` | `'memory'` | Storage: `memory` or `disk` |
| `keepOriginal` | `boolean` | `false` | Skip conversion, keep original |
| `cloudStorage` | `boolean` | `false` | Enable cloud upload |
| `cloudProvider` | `string` | - | Provider: `cloudinary`, `s3`, `gcs` |
| `cloudConfig` | `object` | - | Provider-specific configuration |

### `upflyConvert(options)`

Conversion-only middleware for existing uploads.

```js
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

app.post('/convert',
  upload.single('image'),
  upflyConvert({
    fields: {
      image: { format: 'webp', quality: 80 }
    }
  }),
  (req, res) => res.json({ file: req.file })
);
```

---

## 🌍 Cloud Provider Setup

### Cloudinary Configuration
```js
cloudConfig: {
  cloud_name: 'your-cloud-name',      // Required
  api_key: 'your-api-key',            // Required  
  api_secret: 'your-api-secret',      // Required
  folder: 'uploads',                  // Optional: organize uploads
  secure: true,                       // Optional: use HTTPS URLs
  resource_type: 'auto',              // Optional: auto-detect file type
  transformation: { quality: 'auto' }, // Optional: Cloudinary transformations
  tags: ['user-upload']               // Optional: add tags
}
```

### AWS S3 Configuration
```js
cloudConfig: {
  region: 'us-east-1',                // Required
  bucket: 'my-bucket',                // Required
  accessKeyId: 'AKIA...',             // Required
  secretAccessKey: 'secret...',       // Required
  keyPrefix: 'uploads/',              // Optional: folder prefix
  acl: 'public-read',                 // Optional: file permissions
  storageClass: 'STANDARD',           // Optional: storage class
  serverSideEncryption: 'AES256',     // Optional: encryption
  customDomain: 'cdn.example.com'     // Optional: custom domain
}
```

### Google Cloud Storage Configuration
```js
cloudConfig: {
  bucket: 'my-gcs-bucket',            // Required
  keyFilename: './service-account.json', // Required (or credentials)
  projectId: 'my-project-id',         // Optional: auto-detected
  prefix: 'uploads/',                 // Optional: folder prefix
  public: true,                       // Optional: make files public
  storageClass: 'STANDARD',           // Optional: storage class
  customDomain: 'storage.example.com' // Optional: custom domain
}
```

---

## 🛡️ Error Handling & Safety

Upfly is built for production. It handles errors gracefully so your app never crashes.

### Automatic Fallbacks
```js
upflyUpload({
  fields: {
    images: { format: 'webp', quality: 80 }
  },
  safeFile: true  // Enable backup system
})

// If WebP conversion fails:
// 1. Upfly automatically falls back to original file
// 2. Your app continues working
// 3. Error details available in req.files[].metadata
```

### Error Metadata
```js
// Check if processing succeeded
if (req.files.images[0]._metadata?.isSkipped) {
  console.log('Processing failed:', req.files.images[0]._metadata.errors);
  // File is still available as fallback
}

// Check if backup fallback was used
if (req.files.images[0]._metadata?.isBackupFallback) {
  console.log('Used backup fallback due to:', req.files.images[0]._metadata.errors.conversion);
  // Original file was used instead of converted version
}

// Metadata structure:
// {
//   isBackupFallback: boolean,  // true if original file was used as fallback
//   isSkipped: boolean,          // true if processing completely failed
//   isProcessed: boolean,        // true if file was successfully processed
//   errors: {
//     conversion?: string,       // Sharp conversion error
//     cloudUpload?: string,      // Cloud upload error
//     diskWrite?: string,        // Disk write error
//     message?: string           // General error message
//   }
// }
```

### Memory Management
- **Small files** (< 7MB): Processed in memory for speed
- **Large files**: Automatically streamed through temp files
- **Cleanup**: All temp files cleaned up automatically
- **Limits**: Configurable file size limits

---

## 📊 Performance & Optimization

### File Size Savings
- **WebP**: 25-50% smaller than JPEG
- **AVIF**: 50-70% smaller than JPEG  
- **Quality 80**: Sweet spot for size vs quality
- **Smart defaults**: Optimized for web delivery

### Memory Efficiency
```js
// Before: 100MB image = 100MB RAM usage
// After: 100MB image = ~10MB RAM usage (streaming)

upflyUpload({
  fields: {
    photos: { format: 'webp', quality: 75 }  // Optimized settings
  },
  limit: 50 * 1024 * 1024  // 50MB limit
})
```

### Development Insights
```bash
# Enable detailed logging
NODE_ENV=development node app.js

# See conversion stats in your terminal:
# [CONVERT] photo.jpg → webp (quality: 80) | Size: 2.1 MB → 0.8 MB (62% saved)
# [CLOUD] Uploading to cloudinary...
# [CLOUD SUCCESS] Upload complete | URL: https://res.cloudinary.com/...

# Fallback notifications:
# [BACKUP FALLBACK] Using backup for "photo.jpg" (conversion error)
```

### Supported Image Formats

Upfly uses Sharp for image processing. When `keepOriginal: false` (default), only these formats are supported:

**Input formats:** JPEG, PNG, WebP, GIF, AVIF, TIFF, SVG, HEIF/HEIC

**Output formats:** WebP, JPEG, PNG, AVIF, TIFF, GIF, HEIF

**Note:** If you upload an unsupported format with conversion enabled, Upfly will skip the file and return an error in the metadata.

---

## 🔒 Security Features

### Path Safety
```js
// These are safe (resolved under project root):
outputDir: './uploads'     // ✅ Safe
outputDir: '/uploads'      // ✅ Safe (normalized to ./uploads)

// These write outside project (use carefully):
outputDir: 'C:\\data\\uploads'  // ⚠️  Absolute Windows path
outputDir: '/var/uploads'       // ⚠️  Absolute Unix path
```

### File Validation
- Unknown fields automatically ignored
- File type validation by MIME type
- Size limits enforced
- Safe filename generation

---

## 📚 Migration Guide

### From Basic Multer
```js
// Before
const upload = multer({ dest: 'uploads/' });
app.post('/upload', upload.single('image'), (req, res) => {
  // Manual processing needed...
});

// After  
app.post('/upload',
  upflyUpload({
    fields: { image: { output: 'disk' } }
  }),
  (req, res) => res.json({ file: req.file })
);
```

### From Sharp + Multer
```js
// Before: 50+ lines of Sharp processing code

// After: One configuration object
upflyUpload({
  fields: {
    images: { format: 'webp', quality: 80 }
  }
})
```

### Using upflyConvert for Existing Uploads

If you already have a Multer setup and just want to add conversion:

```js
const { upflyConvert } = require('upfly');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

app.post('/convert',
  upload.single('image'),
  upflyConvert({
    fields: {
      image: { format: 'webp', quality: 80, output: 'disk' }
    }
  }),
  (req, res) => {
    // req.file now contains the converted image
    res.json({ file: req.file });
  }
);
```

---

## 🤝 Contributing

We love contributions! Here's how to help:

1. **🐛 Report bugs** - [Open an issue](https://github.com/ramin-010/upfly/issues)
2. **💡 Suggest features** - [Start a discussion](https://github.com/ramin-010/upfly/discussions)  
3. **📝 Improve docs** - Submit a PR
4. **🔧 Add cloud providers** - We're always adding more!

---

## 📄 License

MIT © [Rinkal Kumar](https://github.com/ramin-010)

---

## 🙏 Acknowledgments

Built with ❤️ using:
- [Sharp](https://sharp.pixelplumbing.com/) - High-performance image processing
- [Multer](https://github.com/expressjs/multer) - File upload handling
- [Cloudinary](https://cloudinary.com/) - Image and video management
- [AWS SDK](https://aws.amazon.com/sdk-for-javascript/) - AWS integration
- [Google Cloud](https://cloud.google.com/storage) - GCS integration

---

**Ready to simplify your file uploads?** 

```bash
npm install upfly multer
```

**Questions?** Check out our [examples](https://github.com/ramin-010/upfly/tree/main/examples) or [open an issue](https://github.com/ramin-010/upfly/issues).

---

*Made with 🚀 by developers, for developers.*
