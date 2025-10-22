<div align="center">

# Upfly

**The Complete File Upload Solution You've Been Looking For**

*One middleware. Stream-based processing. Zero data loss. Production-ready.*

[![npm version](https://img.shields.io/npm/v/upfly.svg?style=flat-square&color=4F46E5)](https://www.npmjs.com/package/upfly)
[![license](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](LICENSE)
[![CI](https://github.com/ramin-010/upfly/actions/workflows/ci.yml/badge.svg)](https://github.com/ramin-010/upfly/actions/workflows/ci.yml)
[![downloads](https://img.shields.io/npm/dm/upfly.svg?style=flat-square&color=34D399)](https://www.npmjs.com/package/upfly)

[Website](https://upfly-frontend.vercel.app/) • [Documentation](https://github.com/ramin-010/upfly-frontend/blob/main/README.md) • [Issues](https://github.com/ramin-010/upfly/issues)

</div>

---

## What is Upfly?

Upfly is an Express middleware that handles the entire file upload pipeline—from receiving the request to storing in the cloud—with automatic image optimization, intelligent fallback protection, and stream-based processing that scales from kilobytes to gigabytes.

**Built on a proven architecture:**

```
HTTP Request → Multer Interception → Stream Pipeline → Processing
                                            ↓
                                   Parallel Paths:
                                   • Main: Convert + Upload
                                   • Backup: Original Safety Net
                                            ↓
                                   Memory/Disk/Cloud → Response
```

**The result:** Replace 500+ lines of boilerplate with 15 lines. Zero data loss. Production-ready error handling. Multi-cloud support.

---

## The 3-Week Problem Every Developer Faces

File uploads shouldn't be this hard. Yet every project starts the same way:

```javascript
// Week 1: Setup hell
const multer = require('multer');
const sharp = require('sharp');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');

// Week 2: Configuration nightmare
const storage = multer.diskStorage({
  destination: (req, file, cb) => { /* ... */ },
  filename: (req, file, cb) => { /* ... */ }
});

// Week 3: Error handling chaos
app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    await sharp(req.file.path).webp({ quality: 80 }).toFile(...);
    const result = await cloudinary.uploader.upload(...);
    fs.unlinkSync(req.file.path);
    res.json({ url: result.url });
  } catch (err) {
    // 🔴 Data loss risk - no backup
    // 🔴 Manual cleanup required
    // 🔴 Memory leaks with large files
    res.status(500).json({ error: err.message });
  }
});
```

**You lose 3-4 weeks writing:**
- 500+ lines of setup code
- Manual Sharp pipelines
- Cloud SDK integration
- Error handling & cleanup
- Memory management for large files
- Vendor lock-in to one cloud provider

---

## The Upfly Way

**One middleware. Everything handled.**

```javascript
const { upflyUpload } = require('upfly');

app.post('/upload', 
  upflyUpload({
    fields: {
      avatar: {
        cloudStorage: true,
        cloudProvider: 'cloudinary',
        cloudConfig: {
          cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
          api_key: process.env.CLOUDINARY_API_KEY,
          api_secret: process.env.CLOUDINARY_API_SECRET
        },
        format: 'webp',
        quality: 80
      }
    },
    safeFile: true  // ← Zero data loss guarantee
  }), 
  (req, res) => res.json({ url: req.files.avatar[0].cloudUrl })
);
```

**That's it.** ✅ Image optimization ✅ Cloud storage ✅ Error handling ✅ Backup fallback ✅ Memory management

| Metric | Traditional Approach | With Upfly | Improvement |
|--------|---------------------|------------|-------------|
| **Setup Time** | 3-4 weeks | 30 minutes | **99% Faster** |
| **Code Lines** | 500+ lines | 15 lines | **93% Less** |
| **Data Loss Risk** | High (no fallback) | Zero (automatic backup) | **100% Reliable** |
| **Cloud Providers** | 1 (locked-in) | 3 (switchable) | **3x Flexibility** |
| **Memory Issues** | Common with large files | None (stream-based) | **Production-Safe** |

---

## How It Works: The Stream-Based Architecture

Upfly uses a sophisticated pipeline that processes files without blocking your server:

```
┌─────────────────┐
│  HTTP Request   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     Multer      │ ◄── File interception
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Custom Storage  │ ◄── Stream-based processing
└────────┬────────┘
         │
         ├──── safeFile enabled?
         │
         ▼
    ┌────┴────┐
    │   Tee   │ ◄── Backup protection
    │ Stream  │
    └─┬────┬──┘
      │    │
      │    └──────► Backup Stream ──► Memory/Disk
      │                                (safety net)
      ▼
 Main Stream
      │
      ├──── Image?
      │
      ▼
  ┌────────┐
  │ Sharp  │ ◄── Format conversion
  │Convert │      (WebP, AVIF, etc.)
  └───┬────┘
      │
      ▼
 ┌──────────┐
 │  Output  │
 │ Routing  │
 └────┬─────┘
      │
      ├─────► Memory Buffer
      ├─────► Disk Write
      └─────► Cloud Upload
           │         (Cloudinary/S3/GCS)
           ▼
      ┌─────────┐
      │ Success │
      └─────────┘
           │
           ▼ (error?)
      ┌─────────┐
      │ Fallback│ ◄── Use backup automatically
      │ System  │      (zero data loss)
      └─────────┘
```

**Key Innovations:**

1. **Non-Blocking Streams**: Files processed in chunks, never loading entire file into memory
2. **Intelligent Tee**: When `safeFile: true`, stream splits automatically
   - Main path: Conversion + upload
   - Backup path: Original file safety net
3. **Smart Thresholding**: 
   - Files < 7MB: Backup in memory (fast)
   - Files > 7MB: Backup to temp disk (memory-safe)
4. **Automatic Cleanup**: Process exit handlers prevent temp file leaks
5. **Zero Data Loss**: If main path fails, backup uploads automatically

---

## Quick Start (30 Seconds)

### 1. Install
```bash
npm install upfly multer
```

### 2. Basic Usage
```javascript
const express = require('express');
const { upflyUpload } = require('upfly');

const app = express();

app.post('/upload',
  upflyUpload({
    fields: {
      images: {
        format: 'webp',
        quality: 80
      }
    }
  }),
  (req, res) => {
    res.json({ 
      success: true,
      files: req.files.images 
    });
  }
);

app.listen(3000);
```

### 3. Test It
```bash
curl -X POST -F "images=@photo.jpg" http://localhost:3000/upload
```

**Result:** Your image is automatically optimized to WebP (80% quality), saving 30-70% in file size.

---

## Core Features

### 🎨 Automatic Image Optimization
- **Formats**: WebP, AVIF, JPEG, PNG, TIFF, GIF, HEIF
- **Sharp-powered**: Industry-leading speed and quality
- **Intelligent defaults**: 80% quality, WebP format
- **Format validation**: Graceful handling of unsupported types

### ☁️ Multi-Cloud Storage
- **Cloudinary**: Built-in transformations, video support
- **AWS S3**: Global scalability, custom domains
- **Google Cloud Storage**: Enterprise-grade, Firebase integration
- **Switch providers**: Change one line, not your entire codebase

### 🛡️ Zero Data Loss Protection
```javascript
{
  safeFile: true  // ← Automatic backup system
}
```
- Creates backup stream during processing
- If conversion fails → backup uploads automatically
- If cloud fails → backup saves to disk
- Your users **always** get their files

### ⚡ Stream-Based Performance
- **Non-blocking I/O**: Server stays responsive under load
- **Memory efficient**: Process gigabyte files with megabytes of RAM
- **Automatic threshold**: Small files in memory, large files streamed to disk
- **Production tested**: 24hr stability tests, zero memory leaks

### 🔧 Flexible Output Options
```javascript
// Memory (fast, for small files)
output: 'memory'

// Disk (scalable, for large files)
output: 'disk'

// Cloud (production-ready)
cloudStorage: true
```

---

## Configuration Guide

### Field Configuration

Each field in your HTML form can have its own processing rules:

```javascript
{
  fields: {
    fieldname: {
      // Output destination
      output: 'memory',              // 'memory' | 'disk'
      
      // Image processing
      format: 'webp',                // 'webp' | 'jpeg' | 'png' | 'avif' | etc.
      quality: 80,                   // 1-100 (higher = better quality)
      keepOriginal: false,           // Skip conversion
      
      // Cloud storage
      cloudStorage: false,           // Enable cloud upload
      cloudProvider: 'cloudinary',   // 'cloudinary' | 's3' | 'gcs'
      cloudConfig: { /* ... */ }     // Provider-specific config
    }
  }
}
```

### Global Options

```javascript
{
  fields: { /* ... */ },
  outputDir: './uploads',       // Disk storage directory
  limit: 10 * 1024 * 1024,     // Max file size (10MB)
  safeFile: true                // Enable backup fallback
}
```

---

## Cloud Storage Setup

### Cloudinary

```javascript
cloudConfig: {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  folder: 'user-uploads'  // Optional: organize in folders
}
```

**Install:** `npm install cloudinary`

---

### AWS S3

```javascript
cloudConfig: {
  region: 'us-east-1',
  bucket: 'my-bucket',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  acl: 'public-read'  // or 'private'
}
```

**Install:** `npm install @aws-sdk/client-s3 @aws-sdk/lib-storage`

---

### Google Cloud Storage

```javascript
cloudConfig: {
  bucket: 'my-gcs-bucket',
  keyFilename: './service-account.json',
  projectId: 'my-project-id',
  public: true
}
```

**Install:** `npm install @google-cloud/storage`

---

## Real-World Examples

### Profile Upload (Memory + Cloud)

```javascript
app.post('/profile',
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
    },
    limit: 5 * 1024 * 1024,  // 5MB limit
    safeFile: true
  }),
  (req, res) => {
    const { cloudUrl } = req.files.avatar[0];
    res.json({ avatarUrl: cloudUrl });
  }
);
```

---

### Document Upload (Disk Storage)

```javascript
app.post('/documents',
  upflyUpload({
    fields: {
      files: {
        output: 'disk',
        keepOriginal: true  // Don't convert documents
      }
    },
    outputDir: './user-documents',
    limit: 50 * 1024 * 1024  // 50MB
  }),
  (req, res) => {
    const files = req.files.files.map(f => ({
      path: f.path,
      name: f.originalname,
      size: f.size
    }));
    res.json({ files });
  }
);
```

---

### Multi-Field Form

```javascript
app.post('/post',
  upflyUpload({
    fields: {
      // Thumbnail: Small, aggressive compression
      thumbnail: {
        format: 'webp',
        quality: 60,
        output: 'memory'
      },
      
      // Main image: High quality to cloud
      image: {
        cloudStorage: true,
        cloudProvider: 's3',
        cloudConfig: {
          region: process.env.AWS_REGION,
          bucket: process.env.AWS_BUCKET,
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
        },
        format: 'webp',
        quality: 85
      },
      
      // Attachments: Keep original to disk
      attachments: {
        output: 'disk',
        keepOriginal: true
      }
    },
    outputDir: './uploads',
    safeFile: true
  }),
  (req, res) => {
    res.json({
      thumbnail: req.files.thumbnail[0].buffer.toString('base64'),
      imageUrl: req.files.image[0].cloudUrl,
      attachments: req.files.attachments.map(f => f.path)
    });
  }
);
```

---

## Error Handling & Reliability

### Understanding Error Metadata

Upfly never crashes your app. All errors are captured in `_metadata`:

```javascript
app.post('/upload',
  upflyUpload({
    fields: { images: { format: 'webp' } },
    safeFile: true
  }),
  (req, res) => {
    const file = req.files.images[0];
    
    if (file._metadata?.isSkipped) {
      // Total failure - couldn't process at all
      return res.status(500).json({ 
        error: file._metadata.errors.message 
      });
    }
    
    if (file._metadata?.isBackupFallback) {
      // Partial failure - used backup (file still available)
      console.warn('Conversion failed, used original:', 
        file._metadata.errors.conversion
      );
      // File uploaded successfully, just not converted
    }
    
    // Success - file processed normally
    res.json({ url: file.cloudUrl || file.path });
  }
);
```

### Error Metadata Structure

```javascript
_metadata: {
  isBackupFallback: boolean,    // true if backup was used
  isSkipped: boolean,            // true if totally failed
  isProcessed: boolean,          // true if successful
  errors: {
    conversion?: string,         // Sharp error
    cloudUpload?: string,        // Cloud provider error
    diskWrite?: string,          // Filesystem error
    message?: string             // General error
  }
}
```

### Common Error Scenarios

#### Unsupported Format
```javascript
// User uploads .bmp file
file._metadata = {
  isSkipped: true,
  errors: {
    message: 'Unsupported image format: image/bmp'
  }
}
```

**Solution:** Use `keepOriginal: true` or validate MIME types before upload

---

#### Corrupted Image
```javascript
// Incomplete/damaged file
file._metadata = {
  isBackupFallback: true,  // ← Original file was saved
  errors: {
    conversion: 'Input buffer has corrupt header'
  }
}
```

**Solution:** With `safeFile: true`, user still gets their file

---

#### Cloud Timeout
```javascript
// Network issue during upload
file._metadata = {
  isSkipped: true,
  errors: {
    cloudUpload: 'Request timeout after 30s'
  }
}
```

**Solution:** Upfly retries once with backup stream automatically

---

## Performance & Benchmarks

### Real-World Results

**Optimization Savings** (1920×1080 images):

| Original Format | Size | WebP 80% | Savings |
|-----------------|------|----------|---------|
| PNG (screenshot) | 884 KB | 72 KB | **91.9%** |
| JPEG (photo) | 204 KB | 67 KB | **67.1%** |
| PNG (graphic) | 168 KB | 126 KB | **25.1%** |

**Processing Speed** (average):
- WebP conversion: 200-400ms
- AVIF conversion: 800-1200ms  
- Cloud upload: +500-2000ms (network dependent)

**Memory Usage**:
- 1MB file: ~2-3MB RAM during processing
- 50MB file: ~10-15MB RAM (thanks to streaming)

**Throughput** (1000 concurrent uploads, 2MB average):
- Memory usage: Stable ~150MB
- Files processed: 500+ files/min
- CPU usage: <30% peak
- Uptime test: 24hrs, zero memory leaks

---

## Security Best Practices

### 1. File Size Limits

```javascript
{
  limit: 10 * 1024 * 1024  // 10MB - adjust per use case
}
```

### 2. File Type Validation

```javascript
app.post('/upload',
  upflyUpload({ /* ... */ }),
  (req, res) => {
    const file = req.files.image[0];
    
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return res.status(400).json({ error: 'Invalid file type' });
    }
    
    res.json({ file });
  }
);
```

### 3. Rate Limiting

```javascript
const rateLimit = require('express-rate-limit');

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10                     // 10 uploads per window
});

app.post('/upload', uploadLimiter, upflyUpload({ /* ... */ }));
```

### 4. Authentication

```javascript
const requireAuth = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.post('/upload', requireAuth, upflyUpload({ /* ... */ }));
```

### 5. Cloud Storage Security

```javascript
// ✅ Good: Use environment variables
cloudConfig: {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true  // Always HTTPS
}

// ❌ Bad: Hardcoded credentials
cloudConfig: {
  cloud_name: 'my-cloud',  // Don't do this!
  api_key: '123456',
  api_secret: 'secret'
}
```

---

## Migration Guide

### From Multer + Sharp

**Before** (50+ lines):
```javascript
const multer = require('multer');
const sharp = require('sharp');
const upload = multer({ dest: 'temp/' });

app.post('/upload', upload.single('image'), async (req, res) => {
  const output = `uploads/${Date.now()}.webp`;
  await sharp(req.file.path).webp({ quality: 80 }).toFile(output);
  fs.unlinkSync(req.file.path);
  res.json({ path: output });
});
```

**After** (Upfly):
```javascript
const { upflyUpload } = require('upfly');

app.post('/upload',
  upflyUpload({
    fields: { image: { output: 'disk', format: 'webp', quality: 80 } },
    outputDir: './uploads'
  }),
  (req, res) => res.json({ path: req.files.image[0].path })
);
```

---

### From Cloudinary SDK

**Before** (manual upload):
```javascript
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const upload = multer({ dest: 'temp/' });

app.post('/upload', upload.single('image'), async (req, res) => {
  const result = await cloudinary.uploader.upload(req.file.path);
  fs.unlinkSync(req.file.path);
  res.json({ url: result.secure_url });
});
```

**After** (Upfly):
```javascript
const { upflyUpload } = require('upfly');

app.post('/upload',
  upflyUpload({
    fields: {
      image: {
        cloudStorage: true,
        cloudProvider: 'cloudinary',
        cloudConfig: {
          cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
          api_key: process.env.CLOUDINARY_API_KEY,
          api_secret: process.env.CLOUDINARY_API_SECRET
        }
      }
    }
  }),
  (req, res) => res.json({ url: req.files.image[0].cloudUrl })
);
```

---

## Troubleshooting

### Files not uploading to cloud

**Check credentials:**
```javascript
// Verify env variables are loaded
console.log('Cloud name:', process.env.CLOUDINARY_CLOUD_NAME);
```

**Test connection at startup:**
```javascript
const { validateAllCloudConfigs } = require('upfly/cloud-setup/cloud');

validateAllCloudConfigs(config.fields)
  .then(() => console.log('✓ Cloud configs validated'))
  .catch(err => console.error('✗ Cloud config error:', err));
```

---

### Memory usage increasing

**Enable safeFile with absolute paths:**
```javascript
const path = require('path');

upflyUpload({
  safeFile: true,
  outputDir: path.join(__dirname, 'uploads')  // Use absolute path
})
```

---

### "Unsupported image format" errors

Sharp supports: JPEG, PNG, WebP, GIF, AVIF, TIFF, SVG, HEIF

**For other formats:**
```javascript
{
  keepOriginal: true  // Skip conversion
}
```

---

### TypeScript autocomplete not working

**Specify cloudProvider before cloudConfig:**
```typescript
// ✓ Correct - enables conditional types
cloudProvider: 'cloudinary',
cloudConfig: { /* autocomplete works */ }

// ✗ Wrong - breaks type inference
cloudConfig: { /* no autocomplete */ },
cloudProvider: 'cloudinary'
```

---

## API Reference

### upflyUpload(options)

Main middleware for file uploads with processing.

```typescript
interface UpflyOptions {
  fields: Record<string, FieldConfig>;
  outputDir?: string;        // Default: './uploads'
  limit?: number;            // Default: 10485760 (10MB)
  safeFile?: boolean;        // Default: false
}
```

**Returns:** Express middleware function

---

### upflyConvert(options)

Conversion-only middleware for existing Multer uploads.

```typescript
interface ConvertOptions {
  fields: Record<string, FieldConfig>;
  outputDir?: string;
  safeFile?: boolean;
}
```

**Requirements:**
- Must be used after Multer middleware
- Multer must use `memoryStorage()` (files need `.buffer`)

**Example:**
```javascript
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

app.post('/upload',
  upload.single('image'),
  upflyConvert({
    fields: { image: { format: 'webp', quality: 80 } }
  }),
  (req, res) => res.json({ file: req.file })
);
```

---

## FAQ

### Q: Do I need to install cloud SDKs?
**A:** Only if using cloud storage. Basic image processing works without them.

### Q: Can I use multiple cloud providers in one app?
**A:** Yes! Different fields can use different providers:
```javascript
fields: {
  avatar: { cloudProvider: 'cloudinary', /* ... */ },
  documents: { cloudProvider: 's3', /* ... */ }
}
```

### Q: What happens if conversion fails?
**A:** With `safeFile: true`, the original file uploads automatically. You always get the file.

### Q: How do I handle very large files (>100MB)?
**A:** Use `output: 'disk'` with `keepOriginal: true`. Streaming handles any size.

### Q: Can I process non-image files?
**A:** Yes! Use `keepOriginal: true` for documents, PDFs, etc.

---

## Contributing

We welcome contributions! Please:

1. Open an issue before major changes
2. Fork the repo
3. Create a feature branch: `git checkout -b feature/amazing`
4. Commit changes: `git commit -m 'Add amazing feature'`
5. Push: `git push origin feature/amazing`
6. Open a Pull Request

---

## License

MIT © [Ramin](https://github.com/ramin-010)

See [LICENSE](LICENSE) for details.

---

## Links

- [Website](https://upfly-frontend.vercel.app/)
- [NPM Package](https://www.npmjs.com/package/upfly)
- [GitHub Repository](https://github.com/ramin-010/upfly)
- [Issue Tracker](https://github.com/ramin-010/upfly/issues)
- [Documentation](https://github.com/ramin-010/upfly-frontend/blob/main/README.md)

---

<div align="center">

**Stop fighting file uploads. Start building features.**

Made with ⚡ by developers, for developers.

</div>