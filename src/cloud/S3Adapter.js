const CloudAdapter = require('./CloudAdapter');

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

module.exports = S3Adapter;
