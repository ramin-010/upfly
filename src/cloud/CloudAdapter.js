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

module.exports = CloudAdapter;
