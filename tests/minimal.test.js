const { convertImage } = require('../webify');
const sharp = require('sharp');

// Mock sharp (dynamic metadata.format based on toFormat)
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

describe('Minimal convertImage Test', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should convert an image to the specified format', async () => {
    console.log('Starting minimal convertImage test...');
    
    const inputBuffer = Buffer.from('test image');
    const format = 'webp';
    const quality = 80;
    
    // Call the function
    const result = await convertImage(inputBuffer, format, quality);
    
    // Basic assertions
    expect(Buffer.isBuffer(result)).toBe(true);
    
    // Check if sharp was called correctly
    expect(sharp).toHaveBeenCalledWith(inputBuffer);
    
    // Check if toFormat was called with the right arguments using the first instance
    const firstInstance = sharp.mock.results[0]?.value;
    expect(firstInstance && firstInstance.toFormat).toBeDefined();
    expect(firstInstance.toFormat).toHaveBeenCalledWith(format, { quality });
    
    console.log('Minimal test completed successfully');
  });
});
