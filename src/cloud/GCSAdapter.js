const CloudAdapter = require('./CloudAdapter');

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
      const filename = this.config.prefix
        ? `${this.config.prefix}/${metadata.filename || metadata.originalname}`
        : metadata.filename || metadata.originalname;

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

module.exports = GCSAdapter;
