//! ========================================
//! CLOUD LOGGER UTILITIES
//! ========================================

const colors = {
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    gray: '\x1b[90m',
    reset: '\x1b[0m'
};

const prefix = (color, text) => `${color}[upfly:${text}]${colors.reset}`;

const cloudLogger = {
  validationSuccess: (provider, fieldname) => {
    console.log(`${prefix(colors.green, 'cloud')} ${provider} validated for field "${fieldname}"`);
  },

  validationError: (provider, fieldname, error) => {
    console.error(`${prefix(colors.red, 'error')} ${provider} validation failed for field "${fieldname}": ${error}`);
  },

  uploadStart: (provider, filename, fieldname) => {
    console.log(`${prefix(colors.cyan, 'upload')} Starting ${provider} upload for "${filename}"`);
  },

  uploadSuccess: (provider, filename, url, size) => {
    // size is only printed when the provider actually reported one. Printing a
    // placeholder "0.0 KB" for providers that do not report a stored size is worse
    // than printing nothing.
    const sizePart = Number.isFinite(size) && size > 0
      ? ` ${colors.gray}| ${(size / 1024).toFixed(1)} KB${colors.reset}`
      : '';
    console.log(
      `${prefix(colors.green, 'success')} ${provider} upload complete for "${filename}"${sizePart}\n` +
      `  → ${url}`
    );
  },

  uploadError: (provider, filename, error) => {
    console.error(`${prefix(colors.red, 'error')} ${provider} upload failed for "${filename}": ${error}`);
  },

  retrying: (provider, filename) => {
    console.log(`${prefix(colors.yellow, 'retry')} Retrying ${provider} upload with backup for "${filename}"`);
  },

  retrySuccess: (provider, filename) => {
    console.log(`${prefix(colors.green, 'success')} ${provider} backup upload succeeded for "${filename}"`);
  },

  retryFailed: (provider, filename, error) => {
    console.error(`${prefix(colors.red, 'error')} ${provider} backup upload failed for "${filename}": ${error}`);
  },

  configMissing: (fieldname, missingFields) => {
    console.error(`${prefix(colors.red, 'error')} Field "${fieldname}" missing cloud config: ${missingFields.join(', ')}`);
  }
};

module.exports = cloudLogger;
