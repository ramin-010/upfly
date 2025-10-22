const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

const cloudLogger = require('./cloudLogger');
const CloudAdapter = require('./CloudAdapter');
const CloudinaryAdapter = require('./CloudinaryAdapter');
const S3Adapter = require('./S3Adapter');
const GCSAdapter = require('./GCSAdapter');

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
