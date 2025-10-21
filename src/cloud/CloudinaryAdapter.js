const CloudAdapter = require('./CloudAdapter');

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


      const uploadOptions = {
        folder: this.config.folder || 'upfly',
        resource_type: resourceType,
        use_filename: true,
        unique_filename: true,
        overwrite: false,
        ...this.config.uploadOptions // Allow custom options
      };
   
      const uploadStream = this.cloudinary.uploader.upload_stream(
        uploadOptions,
        (error, result) => {
          if (error) {
            reject(new Error(`Cloudinary upload failed: ${error.message}`));
          } else {
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
     
      stream.on('data', (chunk)=>{
        console.log('processing chunk')
      })

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

module.exports = CloudinaryAdapter;
