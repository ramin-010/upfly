const path = require('path');
const fs = require('fs').promises;
const { convertImage, ensureServerRootDir, generateFileName, slugify } = require('../webify');
const { createTestFile, cleanupTestFiles, createMockFile } = require('./test-utils');
const sharp = require('sharp');

// Enable test logging
process.env.DEBUG = 'webify:test:*';

// Mock sharp
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

describe('Core Functions', () => {
  // Create a test directory for file operations
  const testDir = path.join(__dirname, '..', 'test-temp');
  
  beforeAll(async () => {
    // Ensure test directory exists
    await fs.mkdir(testDir, { recursive: true });
  });
  
  afterAll(async () => {
    // Clean up test directory after all tests
    await fs.rm(testDir, { recursive: true, force: true });
  });
  
  beforeEach(() => {
    // Reset all mocks before each test
    jest.clearAllMocks();
    
    // Reset the mock implementation
    sharp.mockImplementation(() => ({
      toFormat: jest.fn().mockReturnThis(),
      toBuffer: jest.fn().mockResolvedValue(Buffer.from('converted image')),
      metadata: jest.fn().mockResolvedValue({ format: 'webp', width: 100, height: 100 })
    }));
  });

  describe('convertImage', () => {
    it('should convert an image to the specified format', async () => {
      console.log('Starting convertImage test...');
      const inputBuffer = Buffer.from('test image');
      const format = 'webp';
      const quality = 80;
      
      // Debug: Log the sharp mock implementation
      console.log('Sharp mock implementation:', sharp.mock.calls);
      
      const result = await convertImage(inputBuffer, format, quality);
      
      // Inspect first sharp instance
      const firstInstance = sharp.mock.results[0]?.value;
      expect(sharp).toHaveBeenCalledWith(inputBuffer);
      expect(firstInstance.toFormat).toHaveBeenCalledWith(format, { quality });
      expect(Buffer.isBuffer(result)).toBe(true);
    });

    it('should throw an error if conversion fails', async () => {
      sharp.mockImplementationOnce(() => ({
        toFormat: jest.fn().mockReturnThis(),
        toBuffer: jest.fn().mockRejectedValue(new Error('Conversion failed')),
        metadata: jest.fn(),
      }));
      
      await expect(convertImage(Buffer.from('test'), 'webp', 80))
        .rejects
        .toThrow('Conversion failed');
    });
  });

  describe('ensureServerRootDir', () => {
    it('should create directory if it does not exist', async () => {
      const testDir = path.join(__dirname, '..', 'test-dir');
      
      // Clean up in case it exists
      try {
        await fs.rm(testDir, { recursive: true, force: true });
      } catch (err) { /* Ignore */ }
      
      const result = await ensureServerRootDir('./test-dir');
      
      expect(result).toBe(testDir);
      await expect(fs.access(testDir)).resolves.not.toThrow();
      
      // Clean up
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it('should handle absolute paths', async () => {
      const absPath = path.resolve(__dirname, '..', 'test-abs-dir');
      
      try {
        await fs.rm(absPath, { recursive: true, force: true });
      } catch (err) { /* Ignore */ }
      
      const result = await ensureServerRootDir(absPath);
      
      expect(result).toBe(absPath);
      await expect(fs.access(absPath)).resolves.not.toThrow();
      
      // Clean up
      await fs.rm(absPath, { recursive: true, force: true });
    });
  });

  describe('generateFileName', () => {
    it('should generate a sanitized filename with the correct extension', () => {
      const file = {
        originalname: 'Test File Name 123.jpg',
        mimetype: 'image/jpeg'
      };
      
      const result = generateFileName(file, 'webp');
      
      // unique suffix is 4 hex chars in implementation
      expect(result).toMatch(/^test-file-name-123-[0-9a-f]{4}\.webp$/);
    });

    it('should handle files without extension', () => {
      const file = {
        originalname: 'noextension',
        mimetype: 'image/jpeg'
      };
      
      const result = generateFileName(file, 'webp');
      
      expect(result).toMatch(/^noextension-[0-9a-f]{4}\.webp$/);
    });
  });

  describe('slugify', () => {
    it('should convert a string to a URL-friendly slug', () => {
      expect(slugify('Hello World 123!@#')).toBe('hello-world-123');
      expect(slugify('Test with spaces')).toBe('test-with-spaces');
      expect(slugify('Special!@#Chars$%^&*()')).toBe('special-chars');
    });

    it('should handle empty strings', () => {
      expect(slugify('')).toBe('');
    });
  });
});
