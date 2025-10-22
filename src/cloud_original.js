const { Readable } = require('stream');
const fs = require('fs');
const path = require('path')
//! ========================================
//! CLOUD LOGGER UTILITIES
//! ========================================

const cloudLogger = {
  validationSuccess: (provider, fieldname) => {
    console.log(
      `\x1b[32m[CLOUD READY]\x1b[0m ${provider} connection validated for field \x1b[36m"${fieldname}"\x1b[0m`
    );
  },

  validationError: (provider, fieldname, error) => {
    console.error(
      `\x1b[31m[CLOUD CONFIG ERROR]\x1b[0m ${provider} validation failed for field \x1b[33m"${fieldname}"\x1b[0m: ${error}`
    );
  },

  uploadStart: (provider, filename, fieldname) => {
    console.log(
      `\x1b[36m[CLOUD UPLOAD]\x1b[0m Starting upload to \x1b[32m${provider}\x1b[0m | ` +
      `File: \x1b[33m"${filename}"\x1b[0m | Field: \x1b[36m"${fieldname}"\x1b[0m`
    );
  },

  uploadSuccess: (provider, filename, url, size) => {
    console.log(
      `\x1b[32m[CLOUD SUCCESS]\x1b[0m ${provider} upload complete | ` +
      `File: \x1b[33m"${filename}"\x1b[0m | ` +
      `Size: \x1b[32m${(size / 1024).toFixed(2)} KB\x1b[0m\n` +
      `  → URL: \x1b[36m${url}\x1b[0m`
    );
  },

  uploadError: (provider, filename, error) => {
    console.error(
      `\x1b[31m[CLOUD ERROR]\x1b[0m ${provider} upload failed | ` +
      `File: \x1b[33m"${filename}"\x1b[0m: ${error}`
    );
  },

  retrying: (provider, filename) => {
    console.log(
      `\x1b[33m[CLOUD RETRY]\x1b[0m Retrying ${provider} upload with backup | ` +
      `File: \x1b[33m"${filename}"\x1b[0m`
    );
  },

  retrySuccess: (provider, filename) => {
    console.log(
      `\x1b[32m[CLOUD RETRY SUCCESS]\x1b[0m ${provider} backup upload succeeded | ` +
      `File: \x1b[33m"${filename}"\x1b[0m`
    );
  },

  retryFailed: (provider, filename, error) => {
    console.error(
      `\x1b[31m[CLOUD RETRY FAILED]\x1b[0m ${provider} backup upload failed | ` +
      `File: \x1b[33m"${filename}"\x1b[0m: ${error}`
    );
  },

  configMissing: (fieldname, missingFields) => {
    console.error(
      `\x1b[31m[CLOUD CONFIG MISSING]\x1b[0m Field \x1b[33m"${fieldname}"\x1b[0m ` +
      `missing required config: ${missingFields.join(', ')}`
    );
  }
};

//! ========================================
//! CLOUD ADAPTER BASE CLASS
//! ========================================

class CloudAdapter {
  constructor(config) {
    this.config = config;
  }

  /**
   * Validate cloud configuration and test connection
   * @returns {Promise<boolean>}
   */
  async validateConnection() {
    throw new Error('validateConnection() must be implemented by subclass');
  }

  /**
   * Upload stream to cloud provider
   * @param {Readable} stream - File stream
   * @param {Object} metadata - File metadata (originalname, mimetype, etc.)
   * @returns {Promise<Object>} Upload result with url, publicId, etc.
   */
  async upload(stream, metadata) {
    throw new Error('upload() must be implemented by subclass');
  }

  /**
   * Delete file from cloud provider
   * @param {string} publicId - File identifier
   * @returns {Promise<void>}
   */
  async delete(publicId) {
    throw new Error('delete() must be implemented by subclass');
  }
}

//! ========================================
//! CLOUDINARY ADAPTER
//! ========================================

class CloudinaryAdapter extends CloudAdapter {
  constructor(config) {
    super(config);
    
    

    try {
      const cloudinary = require('cloudinary').v2;
      
      cloudinary.config({
        cloud_name: config.cloud_name,
        api_key: config.api_key,
        api_secret: config.api_secret,
        secure: config.secure !== false // Default to true
      });
      
      this.cloudinary = cloudinary;
    } catch (err) {
      throw new Error('Cloudinary SDK not found. Install with: npm install cloudinary');
    }
  }

  async validateConnection() {
    try {
      // Test connection by fetching account details
      await this.cloudinary.api.ping();
    
      return true;
    } catch (error) {
      throw new Error(`Cloudinary validation failed: ${error.message}`);
    }
  }

  async upload(stream, metadata) {
    return new Promise((resolve, reject) => {
      // Determine resource_type based on mimetype
    
      let resourceType = 'auto'; // default

      if (metadata?.mimetype) {
        const mime = metadata.mimetype.toLowerCase();

        if (mime.startsWith('image/')) {
          console.log("its image")

          resourceType = 'image';
        } else if (mime.startsWith('video/')) {
          
          resourceType = 'video';
        } else {
          resourceType = 'raw'; // everything else
        }
      } else {
       
        const ext = (metadata?.originalname || '').split('.').pop()?.toLowerCase();
        if (ext && !['jpg','jpeg','png','gif','webp','svg','mp4','mov','avi'].includes(ext)) {
          resourceType = 'raw';
        }
      }


      // For raw files, preserve the full filename including extension
      const filename = metadata.originalname || metadata.filename || 'file';
      const ext = path.extname(filename);
      const baseName = path.parse(filename).name;
      const folderPath = this.config.folder || 'upfly';
      
      const uploadOptions = {
        folder: folderPath,
        resource_type: resourceType,
        use_filename: false, // We'll set public_id manually
        unique_filename: true,
        overwrite: false,
        // For raw files, include the extension in public_id
        public_id: resourceType === 'raw' 
          ? baseName + ext
          : undefined, 
        ...this.config.uploadOptions // Allow custom options
      };
   
  

      const uploadStream = this.cloudinary.uploader.upload_stream(
        uploadOptions,
        (error, result) => {
          if (error) {
            reject(new Error(`Cloudinary upload failed: ${error.message}`));
          } else {
            // For raw files, manually construct URL with proper extension
            // let finalUrl = result.secure_url;
            
            // if (resourceType === 'raw' && !finalUrl.includes('.')) {
            //   // Extract extension from original filename
            //   const ext = filename.split('.').pop();
            //   if (ext && ext !== filename) {
            //     // Append extension to URL if not already there
            //     finalUrl = `${finalUrl}.${ext}`;
            //   }
            // }
            
            resolve({
              cloudProvider: 'cloudinary',
              cloudUrl: result.secure_url,
              cloudPublicId: result.public_id,
              cloudFormat: result.format,
              cloudWidth: result.width,
              cloudHeight: result.height,
              cloudSize: result.bytes,
              cloudCreatedAt: result.created_at,
              cloudResourceType: result.resource_type,
              _cloudRaw: result 
            });
          }
        }
      );
      
      

      stream.pipe(uploadStream);
      
      stream.on('error', (err) => {
        uploadStream.destroy();
        reject(err);
      });
    });
  }

  async delete(publicId) {
    try {
      await this.cloudinary.uploader.destroy(publicId);
    } catch (error) {
      throw new Error(`Cloudinary delete failed: ${error.message}`);
    }
  }
}

//! ========================================
//! AWS S3 ADAPTER
//! ========================================

class S3Adapter extends CloudAdapter {
  constructor(config) {
    super(config);
    
    try {
      const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
      const { Upload } = require('@aws-sdk/lib-storage');
      
      this.S3Client = S3Client;
      this.PutObjectCommand = PutObjectCommand;
      this.Upload = Upload;
      
      this.client = new S3Client({
        region: config.region,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey
        },
        ...config.clientOptions
      });
      
      this.bucket = config.bucket;
    } catch (err) {
      throw new Error('AWS SDK not found. Install with: npm install @aws-sdk/client-s3 @aws-sdk/lib-storage');
    }
  }

  async validateConnection() {
    try {
      const { HeadBucketCommand } = require('@aws-sdk/client-s3');
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch (error) {
      throw new Error(`S3 validation failed: ${error.message}`);
    }
  }

  async upload(stream, metadata) {
    try {
      const key =  metadata.filename || metadata.originalname || 'File';

      const uploadParams = {
        Bucket: this.bucket,
        Key: key,
        Body: stream,
        ContentType: metadata.mimetype,
        ...this.config.uploadParams
      };

      // Only set ACL if explicitly provided (many buckets have ACLs disabled)
      if (this.config.acl) {
        uploadParams.ACL = this.config.acl;
      }

      const upload = new this.Upload({
        client: this.client,
        params: uploadParams
      });

      const result = await upload.done();

      // Construct public URL
      const publicUrl = this.config.customDomain
        ? `${this.config.customDomain}/${key}`
        : `https://${this.bucket}.s3.${this.config.region}.amazonaws.com/${key}`;

      return {
        cloudProvider: 's3',
        cloudUrl: publicUrl,
        cloudPublicId: key,
        cloudBucket: this.bucket,
        cloudRegion: this.config.region,
        cloudETag: result.ETag,
        cloudSize: metadata.size,
        _cloudRaw: result
      };
    } catch (error) {
      throw new Error(`S3 upload failed: ${error.message}`);
    }
  }

  async delete(key) {
    try {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      await this.client.send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key
      }));
    } catch (error) {
      throw new Error(`S3 delete failed: ${error.message}`);
    }
  }
}

//! ========================================
//! GOOGLE CLOUD STORAGE ADAPTER
//! ========================================

class GCSAdapter extends CloudAdapter {
  constructor(config) {
    super(config);
    
    try {
      const { Storage } = require('@google-cloud/storage');
      
      const storageConfig = {};
      
      if (config.keyFilename) {
        storageConfig.keyFilename = config.keyFilename;
      } else if (config.credentials) {
        storageConfig.credentials = config.credentials;
      }
      
      if (config.projectId) {
        storageConfig.projectId = config.projectId;
      }
      
      this.storage = new Storage(storageConfig);
      this.bucket = this.storage.bucket(config.bucket);
      this.bucketName = config.bucket;
    } catch (err) {
      throw new Error('Google Cloud Storage SDK not found. Install with: npm install @google-cloud/storage');
    }
  }

  async validateConnection() {
    try {
      const [exists] = await this.bucket.exists();
      if (!exists) {
        throw new Error(`Bucket "${this.bucketName}" does not exist`);
      }
      return true;
    } catch (error) {
      throw new Error(`GCS validation failed: ${error.message}`);
    }
  }

  async upload(stream, metadata) {
    try {
      const filename = metadata.filename || metadata.originalname || 'file';

      const file = this.bucket.file(filename);
      
      const writeStream = file.createWriteStream({
        metadata: {
          contentType: metadata.mimetype,
          ...this.config.metadata
        },
        resumable: this.config.resumable !== false,
        ...this.config.uploadOptions
      });

      return new Promise((resolve, reject) => {
        stream.pipe(writeStream)
          .on('error', (error) => {
            reject(new Error(`GCS upload failed: ${error.message}`));
          })
          .on('finish', async () => {
            try {
              // Make file public if configured
              if (this.config.public !== false) {
                await file.makePublic();
              }

              const publicUrl = this.config.customDomain
                ? `${this.config.customDomain}/${filename}`
                : `https://storage.googleapis.com/${this.bucketName}/${filename}`;

              resolve({
                cloudProvider: 'gcs',
                cloudUrl: publicUrl,
                cloudPublicId: filename,
                cloudBucket: this.bucketName,
                cloudSize: metadata.size,
                cloudContentType: metadata.mimetype,
                _cloudRaw: { bucket: this.bucketName, name: filename }
              });
            } catch (error) {
              reject(new Error(`GCS post-upload processing failed: ${error.message}`));
            }
          });
      });
    } catch (error) {
      throw new Error(`GCS upload failed: ${error.message}`);
    }
  }

  async delete(filename) {
    try {
      await this.bucket.file(filename).delete();
    } catch (error) {
      throw new Error(`GCS delete failed: ${error.message}`);
    }
  }
}

//! ========================================
//! ADAPTER FACTORY
//! ========================================

function createCloudAdapter(provider, config) {
  switch (provider.toLowerCase()) {
    case 'cloudinary':
      return new CloudinaryAdapter(config);
    case 's3':
    case 'aws':
      return new S3Adapter(config);
    case 'gcs':
    case 'google':
      return new GCSAdapter(config);
    default:
      throw new Error(
        `Unsupported cloud provider: "${provider}". ` +
        `Supported providers: cloudinary, s3, gcs`
      );
  }
}

//! ========================================
//! CLOUD CONFIG VALIDATION
//! ========================================

function validateCloudConfig(fieldname, cloudProvider, cloudConfig) {
  if (!cloudProvider) {
    throw new TypeError(
      `Field "${fieldname}" has cloudStorage enabled but missing "cloudProvider". ` +
      `Supported: cloudinary, s3, gcs`
    );
  }

  if (!cloudConfig || typeof cloudConfig !== 'object') {
    throw new TypeError(
      `Field "${fieldname}" has cloudStorage enabled but "cloudConfig" is missing or invalid`
    );
  }

  const provider = cloudProvider.toLowerCase();
  const missing = [];

  // Provider-specific validation
  switch (provider) {
    case 'cloudinary':
      if (!cloudConfig.cloud_name) missing.push('cloud_name');
      if (!cloudConfig.api_key) missing.push('api_key');
      if (!cloudConfig.api_secret) missing.push('api_secret');
      break;

    case 's3':
    case 'aws':
      if (!cloudConfig.region) missing.push('region');
      if (!cloudConfig.bucket) missing.push('bucket');
      if (!cloudConfig.accessKeyId) missing.push('accessKeyId');
      if (!cloudConfig.secretAccessKey) missing.push('secretAccessKey');
      break;

    case 'gcs':
    case 'google':
      if (!cloudConfig.bucket) missing.push('bucket');
      if (!cloudConfig.keyFilename && !cloudConfig.credentials) {
        missing.push('keyFilename or credentials');
      }
      break;

    default:
      throw new Error(
        `Unsupported cloud provider: "${cloudProvider}". ` +
        `Supported: cloudinary, s3, gcs`
      );
  }

  if (missing.length > 0) {
    cloudLogger.configMissing(fieldname, missing);
    throw new Error(
      `Field "${fieldname}" cloudConfig missing required fields: ${missing.join(', ')}`
    );
  }
}

//! ========================================
//! PRE-FLIGHT VALIDATION (at startup)
//! ========================================

async function validateAllCloudConfigs(fields) {
  const validationPromises = [];

  for (const [fieldname, config] of Object.entries(fields)) {
    if (!config.cloudStorage) continue;

    // Validate config structure
    validateCloudConfig(fieldname, config.cloudProvider, config.cloudConfig);

    // Test connection
    const validationPromise = (async () => {
      try {
        const adapter = createCloudAdapter(config.cloudProvider, config.cloudConfig);
        await adapter.validateConnection();
        cloudLogger.validationSuccess(config.cloudProvider, fieldname);
      } catch (error) {
        cloudLogger.validationError(config.cloudProvider, fieldname, error.message);
        throw new Error(
          `Cloud config validation failed for field "${fieldname}" ` +
          `(${config.cloudProvider}): ${error.message}`
        );
      }
    })();

    validationPromises.push(validationPromise);
  }

  // Wait for all validations
  await Promise.all(validationPromises);
}

//! ========================================
//! CORE UPLOAD FUNCTION
//! ========================================

async function uploadToCloud(stream, metadata, cloudProvider, cloudConfig, backup = null) {
  const adapter = createCloudAdapter(cloudProvider, cloudConfig);
  cloudLogger.uploadStart(cloudProvider, metadata.originalname, metadata.fieldname);

  try {
    // First attempt with primary stream
    const result = await adapter.upload(stream, metadata);
    cloudLogger.uploadSuccess(
      cloudProvider,
      metadata.originalname,
      result.cloudUrl,
      result.cloudSize || metadata.size || 0
    );
    return result;
  } catch (error) {
    cloudLogger.uploadError(cloudProvider, metadata.originalname, error.message);

    // Retry with backup if available (only once)
    if (backup && (backup.buffer || backup.path)) {
      cloudLogger.retrying(cloudProvider, metadata.originalname);

      try {
        const retryStream = backup.path
          ? fs.createReadStream(backup.path)
          : Readable.from(backup.buffer);

        const result = await adapter.upload(retryStream, metadata);
        cloudLogger.retrySuccess(cloudProvider, metadata.originalname);
        cloudLogger.uploadSuccess(
          cloudProvider,
          metadata.originalname,
          result.cloudUrl,
          result.cloudSize || metadata.size || 0
        );
        return result;
      } catch (retryError) {
        cloudLogger.retryFailed(cloudProvider, metadata.originalname, retryError.message);
        throw retryError;
      }
    }

    throw error;
  }
}

//! ========================================
//! EXPORTS
//! ========================================

module.exports = {
  uploadToCloud,
  validateAllCloudConfigs,
  createCloudAdapter,
  CloudAdapter,
  CloudinaryAdapter,
  S3Adapter,
  GCSAdapter
};