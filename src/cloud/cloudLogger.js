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

module.exports = cloudLogger;
