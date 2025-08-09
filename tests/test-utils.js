const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');

// Helper to create a test file
const createTestFile = async (content, extension = 'jpg') => {
  const testDir = path.join(__dirname, '..', 'test-temp');
  await fs.mkdir(testDir, { recursive: true });
  
  const fileName = `test-${uuidv4()}.${extension}`;
  const filePath = path.join(testDir, fileName);
  
  await fs.writeFile(filePath, content);
  return { filePath, fileName };
};

// Helper to clean up test files
const cleanupTestFiles = async () => {
  const testDir = path.join(__dirname, '..', 'test-temp');
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
};

// Mock file object for testing
const createMockFile = (buffer, options = {}) => ({
  fieldname: 'file',
  originalname: options.originalname || 'test.jpg',
  encoding: '7bit',
  mimetype: options.mimetype || 'image/jpeg',
  buffer: buffer || Buffer.from('test image content'),
  size: options.size || 1024,
});

module.exports = {
  createTestFile,
  cleanupTestFiles,
  createMockFile,
};
