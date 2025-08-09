const { uploadAndWebify, webify } = require('../webify');
const express = require('express');
const request = require('supertest');
const multer = require('multer');
const fs = require('fs').promises;
const path = require('path');
const { createMockFile, cleanupTestFiles } = require('./test-utils');

// Mock sharp for these tests
jest.mock('sharp', () => {
  let lastFormat = 'webp';
  const mockSharp = jest.fn().mockImplementation(() => {
    const instance = {
      toFormat: jest.fn((format) => {
        lastFormat = String(format || '').toLowerCase() || 'webp';
        return instance;
      }),
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('converted image')),
      metadata: jest.fn().mockResolvedValue({ format: lastFormat, width: 100, height: 100 })
    };
    return instance;
  });
  mockSharp.concurrency = jest.fn();
  return mockSharp;
});

describe('uploadAndWebify Middleware', () => {
  let app;
  const testDir = path.join(__dirname, '..', 'test-uploads');
  
  beforeAll(async () => {
    // Clean up test directory before running tests
    await cleanupTestFiles();
    await fs.mkdir(testDir, { recursive: true });
  });
  
  afterAll(async () => {
    // Clean up test directory after all tests
    await fs.rm(testDir, { recursive: true, force: true });
  });
  
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    jest.clearAllMocks();
  });
  
  it('should process single file upload and convert to webp in memory', async () => {
    const middleware = uploadAndWebify({
      fields: {
        image: { format: 'webp', quality: 80 }
      },
      outputDir: testDir
    });
    
    app.post('/upload', middleware, (req, res) => {
      expect(req.files).toBeDefined();
      expect(req.files.image).toHaveLength(1);
      expect(req.files.image[0].mimetype).toBe('image/webp');
      res.status(200).json({ success: true });
    });
    
    await request(app)
      .post('/upload')
      .attach('image', Buffer.from('test image'), 'test.jpg')
      .expect(200);
  });
  
  it('should handle multiple file uploads with different configurations', async () => {
    const middleware = uploadAndWebify({
      fields: {
        avatar: { format: 'webp', quality: 90 },
        cover: { format: 'jpeg', quality: 85 }
      },
      outputDir: testDir
    });
    
    // Use multer.fields behavior implied by middleware
    app.post('/upload-multiple', middleware, (req, res) => {
      expect(req.files.avatar).toHaveLength(1);
      expect(req.files.cover).toHaveLength(1);
      expect(req.files.avatar[0].mimetype).toBe('image/webp');
      expect(req.files.cover[0].mimetype).toBe('image/jpeg');
      res.status(200).json({ success: true });
    });
    
    await request(app)
      .post('/upload-multiple')
      .attach('avatar', Buffer.from('avatar image'), 'avatar.jpg')
      .attach('cover', Buffer.from('cover image'), 'cover.jpg')
      .expect(200);
  });
  
  it('should save files to disk when output is set to disk', async () => {
    const middleware = uploadAndWebify({
      fields: {
        image: { format: 'webp', quality: 80, output: 'disk' }
      },
      outputDir: testDir
    });
    
    app.post('/upload-disk', middleware, (req, res) => {
      expect(req.files.image).toHaveLength(1);
      const file = req.files.image[0];
      expect(file.path).toBeDefined();
      expect(file.path).toContain(testDir);
      expect(file.path).toMatch(/\.webp$/);
      res.status(200).json({ success: true });
    });
    
    await request(app)
      .post('/upload-disk')
      .attach('image', Buffer.from('test image'), 'test.jpg')
      .expect(200);
  });
  
  it('should handle non-image files without conversion', async () => {
    const middleware = uploadAndWebify({
      fields: {
        document: { format: 'webp' } // Will be ignored for non-image files
      },
      outputDir: testDir
    });
    
    app.post('/upload-document', middleware, (req, res) => {
      expect(req.files.document).toHaveLength(1);
      expect(req.files.document[0].mimetype).toBe('application/pdf');
      res.status(200).json({ success: true });
    });
    
    await request(app)
      .post('/upload-document')
      .attach('document', Buffer.from('PDF content'), 'document.pdf')
      .expect(200);
  });
  
  it('should handle file size limits', async () => {
    const middleware = uploadAndWebify({
      fields: {
        image: { format: 'webp' }
      },
      outputDir: testDir,
      limit: 10 // 10 bytes limit
    });
    
    app.post('/upload-limit', middleware, (req, res) => {
      // This should not be called as the middleware should reject the file
      res.status(200).json({ success: true });
    });
    
    app.use((err, req, res, next) => {
      // Error handler for multer
      res.status(413).json({ error: err.message });
    });
    
    await request(app)
      .post('/upload-limit')
      .attach('image', Buffer.from('this is more than 10 bytes'), 'test.jpg')
      .expect(413);
  });
});

describe('webify Middleware', () => {
  let app;
  
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    jest.clearAllMocks();
  });
  
  it('should process single file upload with webify', async () => {
    const upload = multer({ storage: multer.memoryStorage() });
    const middleware = webify({
      fields: { image: { format: 'webp', quality: 80 } }
    });
    
    app.post('/webify', upload.single('image'), middleware, (req, res) => {
      expect(req.file).toBeDefined();
      expect(req.file.mimetype).toBe('image/webp');
      res.status(200).json({ success: true });
    });
    
    await request(app)
      .post('/webify')
      .attach('image', Buffer.from('test image'), 'test.jpg')
      .expect(200);
  });
  
  it('should handle multiple files with webify', async () => {
    const upload = multer({ storage: multer.memoryStorage() });
    const middleware = webify({
      fields: { images: { format: 'webp', quality: 80 } }
    });
    
    // Use fields to ensure req.files.images is an array
    app.post(
      '/webify-multiple',
      upload.fields([{ name: 'images', maxCount: 10 }]),
      middleware,
      (req, res) => {
        expect(req.files.images).toBeDefined();
        expect(req.files.images).toHaveLength(2);
        req.files.images.forEach(file => {
          expect(file.mimetype).toBe('image/webp');
        });
        res.status(200).json({ success: true });
      }
    );
    
    await request(app)
      .post('/webify-multiple')
      .attach('images', Buffer.from('test image 1'), 'test1.jpg')
      .attach('images', Buffer.from('test image 2'), 'test2.jpg')
      .expect(200);
  });
});
