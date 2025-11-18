const sharp = require('sharp');
const multer = require('multer')
const path = require('path');
const fs = require('fs');
const fsPromise = fs.promises;
const os = require('os');
const {pipeline } = require('stream/promises');
const { Transform, Readable, PassThrough } = require('stream');


const { uploadToCloud, validateAllCloudConfigs } = require('./cloud/index');


//! ========================================
//! ADVANCED TYPE DEFINITIONS FOR INTELLISENSE
//! ========================================

/**
 * @typedef {'webp' | 'jpeg' | 'jpg' | 'png' | 'avif' | 'tiff' | 'gif' | 'heif'} ImageFormat
 * Supported image output formats for conversion
 */

/**
 * @typedef {'disk' | 'memory'} OutputDestination
 * - 'disk': Save files to filesystem (requires outputDir)
 * - 'memory': Keep files in memory as Buffer (faster, uses more RAM)
 */

/**
 * @typedef {'cloudinary' | 's3' | 'aws' | 'gcs' | 'google'} CloudProvider
 * Supported cloud storage providers
 */

/**
 * @typedef {'us-east-1' | 'us-east-2' | 'us-west-1' | 'us-west-2' | 'eu-west-1' | 'eu-west-2' | 'eu-central-1' | 'ap-south-1' | 'ap-southeast-1' | 'ap-southeast-2' | 'ap-northeast-1' | string} AWSRegion
 * Common AWS regions (allows custom string for other regions)
 */

/**
 * @typedef {'private' | 'public-read' | 'public-read-write' | 'authenticated-read' | 'aws-exec-read' | 'bucket-owner-read' | 'bucket-owner-full-control'} S3ACL
 * AWS S3 Access Control List options
 */

/**
 * @typedef {'STANDARD' | 'REDUCED_REDUNDANCY' | 'STANDARD_IA' | 'ONEZONE_IA' | 'INTELLIGENT_TIERING' | 'GLACIER' | 'DEEP_ARCHIVE'} S3StorageClass
 * AWS S3 storage classes
 */

/**
 * @typedef {'STANDARD' | 'NEARLINE' | 'COLDLINE' | 'ARCHIVE'} GCSStorageClass
 * Google Cloud Storage classes
 */

/**
 * @typedef {'image' | 'video' | 'raw' | 'auto'} CloudinaryResourceType
 * Cloudinary resource types
 */

/**
 * @typedef {Object} CloudinaryConfig
 * @property {string} cloud_name - Your Cloudinary cloud name
 * @property {string} api_key - Your Cloudinary API key
 * @property {string} api_secret - Your Cloudinary API secret
 * @property {string} [folder] - Optional folder path for uploads (e.g., 'avatars', 'products')
 * @property {boolean} [secure=true] - Use HTTPS URLs
 * @property {CloudinaryResourceType} [resource_type='auto'] - Resource type: 'image', 'video', 'raw', 'auto'
 * @property {Object} [transformation] - Cloudinary transformation parameters
 * @property {string} [public_id] - Custom public ID (auto-generated if not provided)
 * @property {boolean} [overwrite=false] - Overwrite existing files with same public_id
 * @property {string[]} [tags] - Array of tags to assign to the upload
 */

/**
 * @typedef {Object} S3Config
 * @property {AWSRegion} region - AWS region (e.g., 'us-east-1', 'eu-west-1')
 * @property {string} bucket - S3 bucket name
 * @property {string} accessKeyId - AWS access key ID
 * @property {string} secretAccessKey - AWS secret access key
 * @property {string} [prefix] - Optional key prefix/folder (e.g., 'uploads/', 'images/')
 * @property {S3ACL} [acl='public-read'] - Access control: 'private', 'public-read', 'public-read-write'
 * @property {Object} [metadata] - Custom metadata object
 * @property {S3StorageClass} [storageClass='STANDARD'] - Storage class: 'STANDARD', 'REDUCED_REDUNDANCY', 'GLACIER'
 * @property {string} [serverSideEncryption] - Encryption: 'AES256', 'aws:kms'
 */

/**
 * @typedef {Object} GCSConfig
 * @property {string} bucket - Google Cloud Storage bucket name
 * @property {string} [keyFilename] - Path to service account key file (.json)
 * @property {Object} [credentials] - Service account credentials object (alternative to keyFilename)
 * @property {string} [projectId] - Google Cloud project ID (auto-detected if using keyFilename)
 * @property {string} [prefix] - Optional object name prefix/folder (e.g., 'uploads/', 'images/')
 * @property {boolean} [public=true] - Make uploaded files publicly accessible
 * @property {Object} [metadata] - Custom metadata object
 * @property {GCSStorageClass} [storageClass='STANDARD'] - Storage class: 'STANDARD', 'NEARLINE', 'COLDLINE', 'ARCHIVE'
 */

/**
 * @typedef {Object} BaseFieldConfig
 * @property {OutputDestination} [output='memory'] - Where to store processed files
 * @property {string} [outputDir] - Field-specific output directory (only for output='disk')
 * @property {ImageFormat} [format='webp'] - Target image format (only for images)
 * @property {number} [quality=80] - Compression quality 1-100 (higher = better quality, larger size)
 * @property {boolean} [keepOriginal=false] - Skip conversion, keep original format and quality
 * @property {boolean} [cloudStorage=false] - Enable cloud storage upload
 */

/**
 * @typedef {BaseFieldConfig & {cloudStorage: false}} LocalFieldConfig
 * Configuration for local-only file processing (no cloud upload)
 */

/**
 * @typedef {BaseFieldConfig & {
 *   cloudStorage: true,
 *   cloudProvider: 'cloudinary',
 *   cloudConfig: CloudinaryConfig
 * }} CloudinaryFieldConfig
 * Configuration for Cloudinary cloud storage
 */

/**
 * @typedef {BaseFieldConfig & {
 *   cloudStorage: true,
 *   cloudProvider: 's3' | 'aws',
 *   cloudConfig: S3Config
 * }} S3FieldConfig
 * Configuration for AWS S3 cloud storage
 */

/**
 * @typedef {BaseFieldConfig & {
 *   cloudStorage: true,
 *   cloudProvider: 'gcs' | 'google',
 *   cloudConfig: GCSConfig
 * }} GCSFieldConfig
 * Configuration for Google Cloud Storage
 */

/**
 * @typedef {LocalFieldConfig | CloudinaryFieldConfig | S3FieldConfig | GCSFieldConfig} FieldConfig
 * Complete field configuration - automatically typed based on cloudStorage and cloudProvider
 * 
 * @example
 * // For better autocomplete, always specify cloudProvider before cloudConfig:
 * {
 *   cloudStorage: true,
 *   cloudProvider: 'cloudinary', // ← Specify this first
 *   cloudConfig: {
 *     // ← Then Ctrl+Space here will show Cloudinary-specific fields
 *     cloud_name: '',
 *     api_key: '',
 *     api_secret: ''
 *   }
 * }
 */

/**
 * @typedef {Object} UpflyOptions
 * @property {Object.<string, FieldConfig>} fields - Field configurations mapped by HTML form field names
 * @property {string} [outputDir='./uploads'] - Global output directory for disk storage (relative to project root)
 * @property {number} [limit=10485760] - Maximum file size in bytes (default: 10MB = 10,485,760 bytes)
 * @property {boolean} [safeFile=false] - Enable backup fallback system for failed conversions
 * 
*/

const LARGE_FILE_THRESHOLD_BYTES = 7 * 1024 * 1024;

// Sharp-supported input formats for conversion
const SHARP_SUPPORTED_FORMATS = new Set([
    'image/jpeg',
    'image/jpg', 
    'image/png',
    'image/webp',
    'image/gif',
    'image/avif',
    'image/tiff',
    'image/svg+xml',
    'image/heif',
    'image/heic'
]); 

const tempFilesPathRegistry = new Set();

process.on('exit', ()=>{
    for(const tempPath of tempFilesPathRegistry){
        try{
            if(fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        }catch(err){
            //ignore the error
        }
    }
});

['SIGINT' , 'SIGTERM', 'SIGHUP'].forEach(signal =>{
    process.on(signal, () =>{
         for (const tmpPath of tempFilesPathRegistry) {
            try {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            } catch (e) { /* //ignore the error */ }
        }
         process.exit(0);
    })
})

//---Parent Logger----
const main_logger = {
    conversionSuccess : (originalname, format, quality, originalSize, convertedSize)=>{
        if(process.env.NODE_ENV === 'production') return;
        const saved = ((1 - convertedSize / originalSize) * 100).toFixed(1);
        console.log(
        `\x1b[36m[CONVERT]\x1b[0m ${originalname} → \x1b[32m${format}\x1b[0m ` +
        `(quality: \x1b[32m${quality}\x1b[0m) | ` +
        `Size: \x1b[33m${(originalSize / 1024).toFixed(2)} KB\x1b[0m → ` +
        `\x1b[32m${(convertedSize / 1024).toFixed(2)} KB\x1b[0m ` +
        `(\x1b[32m${saved}%\x1b[0m saved)`
        );
    } ,

    // Cloud upload success logger including conversion summary (URL already logged by cloudLogger)
    convert_cloudUploadSuccess: (originalname, format, quality, originalSize, convertedSize, cloudProvider, publicUrl) => {
        if(process.env.NODE_ENV === 'production') return;
        const saved = (originalSize > 0 && convertedSize >= 0)
            ? ((1 - convertedSize / originalSize) * 100).toFixed(1)
            : 'n/a';
        console.log(
            `\x1b[36m[CONVERT]\x1b[0m ${originalname} → \x1b[32m${format}\x1b[0m ` +
            `(quality: \x1b[32m${quality}\x1b[0m) | ` +
            `Size: \x1b[33m${(originalSize / 1024).toFixed(2)} KB\x1b[0m → ` +
            `\x1b[32m${(convertedSize / 1024).toFixed(2)} KB\x1b[0m ` +
            `(\x1b[32m${saved}%\x1b[0m saved) | ` +
            `Uploaded to: \x1b[36m${cloudProvider || 'unknown'}\x1b[0m`
        );
    },

    // Cloud upload success for original (unconverted) files (URL already logged by cloudLogger)
    original_CloudUploadSuccess: (originalname, size, cloudProvider, publicUrl) => {
       if(process.env.NODE_ENV === 'production') return;
        console.log(
            `\x1b[36m[ORIGINAL]\x1b[0m ${originalname} ` +
            `Size: \x1b[33m${(size / 1024).toFixed(2)} KB\x1b[0m | ` +
            `Uploaded to: \x1b[36m${cloudProvider || 'unknown'}\x1b[0m`
        );
    },
    // Fallback cloud upload success (URL already logged by cloudLogger)
        fallbackCloudUploadSuccess: (originalname, size, cloudProvider, publicUrl) => {
            if(process.env.NODE_ENV === 'production') return;
                console.log(
                    `\x1b[33m[FALLBACK]\x1b[0m ${originalname} ` +
                    `Size: \x1b[33m${(size / 1024).toFixed(2)} KB\x1b[0m | ` +
                    `Uploaded to: \x1b[36m${cloudProvider || 'unknown'}\x1b[0m`
            );
        },
    conversionError :  (originalname, errorMessage)=>{
        console.error(
        `\x1b[31m[SKIPPED]\x1b[0m : File \x1b[33m"${originalname}"\x1b[0m failed during conversion: ${errorMessage}`
    );
    },
    diskWriteError: (originalname, errorMessage) => {
        console.error(
      `\x1b[31m[SKIPPED]\x1b[0m : File \x1b[33m"${originalname}"\x1b[0m failed during disk write: ${errorMessage}`
    );
    },
    backupFallback: (originalname, reason = '') => {
        const reasonText = reason ? ` (${reason})` : '';
        console.log(
        `\x1b[32m[BACKUP FALLBACK]\x1b[0m : Using backup for \x1b[33m"${originalname}"\x1b[0m${reasonText}`
        );
    },
    backupFallbackFailed :(errorMessage)=>{
        console.error(`\x1b[31m[BACKUP FALLBACK FAILED]\x1b[0m : ${errorMessage}`);
    },
    backupStreamError: (originalname, errorMessage) => {
        console.error(
        `\x1b[31m[BACKUP ERROR]\x1b[0m : Failed to backup file \x1b[33m"${originalname}"\x1b[0m: ${errorMessage}`
        );
    },
     cleanupWarning: (tmpPath, errorMessage) => {
    console.warn(`\x1b[33m[CLEANUP WARN]\x1b[0m Failed to delete temp file ${tmpPath}: ${errorMessage}`);
    },

    pathResolutionWarning: (inputPath, resolvedPath) => {
        const yellow = '\x1b[33m';
        const cyan = '\x1b[36m';
        const green = '\x1b[32m';
        const reset = '\x1b[0m';

        console.warn(
        `${yellow}upfly notice:${reset} outputDir ${cyan}'${inputPath}'${reset} looked like a root path.\n` +
        `→ Resolved under project root as: ${green}${resolvedPath}${reset}\n` +
        `If you really want to write outside the project, use an explicit absolute path:\n` +
        `  Windows: ${cyan}C:\\\\data\\\\uploads${reset}  or  ${cyan}D:/data/uploads${reset}\n` +
        `  Linux/Mac: ${cyan}/var/data/uploads${reset}`
        );
    }
}


//!----Parent fun-01----------->

/**
 * Main upload middleware with image conversion support
 * @param {UpflyOptions} options - Upload configuration options
 * @returns {Function} Express middleware function
 */
const upflyUpload = (options = {}) =>{
    const {
        fields = {},
        outputDir = './uploads',
        limit = 10 * 1024 * 1024,
        safeFile = false,     
    } = options;

    //validation checks------>
    if(typeof fields !== 'object' || fields === null || Array.isArray(fields)){
        throw new TypeError("`fields` option must be a plain object with field configurations.");
    }

    for(const [fieldname, config] of Object.entries(fields)){
        if (typeof config !== 'object' || config === null) {
            throw new TypeError(`Field config for '${fieldname}' must be an object.`);
        }

        if(config.cloudStorage){
            if(config.output !== 'memory'){    //fix1 : must also support outputDir to cloud Stream
                throw new Error(
                    `Field '${fieldname}' has cloudStorage enabled but output is set to '${config.output}'. ` +
                    `Cloud storage requires output: 'memory' (or omit output option).`
                );
            }
            //config.output = 'memory';    //should not force output : must support streaming  from outputDir to cloud
        }

        if(config.output && !['disk', 'memory'].includes(config.output)){
            throw new RangeError(`Field '${fieldname}' has invalid output value '${config.output}'. Allowed: 'disk', 'memory'.`);
        }
        if (config.outputDir !== undefined && typeof config.outputDir !== 'string') {
            throw new TypeError(`Field '${fieldname}' outputDir must be a string.`);
        }
         if (config.quality !== undefined) {
        if (typeof config.quality !== 'number' || config.quality < 1 || config.quality > 100) {
            throw new RangeError(`Field '${fieldname}' quality must be a number between 1 and 100.`);
        }
        }

        if (config.format !== undefined && typeof config.format !== 'string') {
            throw new TypeError(`Field '${fieldname}' format must be a string.`);
        }

        if (config.keepOriginal !== undefined && typeof config.keepOriginal !== 'boolean') {
            throw new TypeError(`Field '${fieldname}' keepOriginal must be a boolean.`);
        }
    }

    if(typeof outputDir !== 'string'){
        throw new TypeError("`outputDir` option must be a string.");
    }

     if (typeof safeFile !== 'boolean') {
        throw new TypeError("`safeFile` option must be a boolean.");
    }

    if (typeof limit !== 'number' || limit <= 0) {
        throw new TypeError("`limits.fileSize` must be a positive number (bytes).");
    }
    //---------------/>

    //--------------pre cloud-field validation---------------->
    const cloudFields = Object.entries(fields).filter(([_, config]) => config.cloudStorage); //to array
    if(cloudFields.length > 0){
        const cloudFieldsConfig = Object.fromEntries(cloudFields);  //back to obj

        validateAllCloudConfigs(cloudFieldsConfig).catch((err) =>{
            console.error(`\x1b[31m[UPFLY STARTUP ERROR]\x1b[0m ${err.message}`);
            console.error(`\x1b[33m[WARNING]\x1b[0m Cloud uploads will fail until configuration is fixed.`);
        });
    }

  // Create pattern matchers for wildcard fields
const fieldPatterns = Object.keys(fields).map(fieldKey => {
    if (fieldKey.includes('*')) {
        // Convert wildcard to regex: "image_*" becomes /^image_.*$/
        const regexPattern = fieldKey
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
            .replace(/\\\*/g, '.*');                 // Convert \* to .*
        return { pattern: new RegExp(`^${regexPattern}$`), key: fieldKey };
    }
    return { pattern: fieldKey, key: fieldKey }; // Exact match for non-wildcard
});

const upload = multer({
    storage : customStorageEngine(LARGE_FILE_THRESHOLD_BYTES, fields, outputDir, safeFile),
    limits : {fileSize : limit},
    fileFilter : (req, file, cb)=>{
        // Check if fieldname matches any pattern
        const isAllowed = fieldPatterns.some(({ pattern }) => {
            if (typeof pattern === 'string') {
                return pattern === file.fieldname; // Exact match
            }
            return pattern.test(file.fieldname); // Regex match for wildcards
        });
        
        if (!isAllowed) return cb(null, false);
        cb(null, true);
    }
}).any();

    return async(req, res, next) =>{
        upload(req, res, async(uploadErr)=>{
            if(uploadErr) return next(uploadErr);
            if(!req.files) return next();

            if(Array.isArray(req.files)){
                const grouped = {};

                for(const file of req.files){
                    if(!grouped[file.fieldname]){
                        grouped[file.fieldname] = []; 
                    }
                    grouped[file.fieldname].push(file)
                }

                req.files = grouped;
            }

            next();
        })
    }
}


function customStorageEngine(threshold, fields, outputDir, safeFile){

   
    return {
        async _handleFile(req, file, cb){
            try{
                let config = fields[file.fieldname];
                 if (!config) {
                    // Try wildcard patterns
                    for (const [fieldKey, fieldConfig] of Object.entries(fields)) {
                        if (fieldKey.includes('*')) {
                            const regexPattern = fieldKey
                                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                                .replace(/\\\*/g, '.*');
                            const regex = new RegExp(`^${regexPattern}$`);
                            
                            if (regex.test(file.fieldname)) {
                                config = fieldConfig;
                                break;
                            }
                        }
                    }
                }
                
                if (!config) {
                    return cb(new Error(`No configuration found for field: ${file.fieldname}`));
                }
                const precomputedName = generateFileName(file);
                file.originalname = precomputedName;

                const isCloudUpload = config.cloudStorage || false;
                const isImage = file.mimetype && file.mimetype.startsWith('image');
                const needsBackup = safeFile; // ← Fixed: All files get backup protection when safeFile=true 
                
                // Validate Sharp format support if conversion is needed
                const keepOriginal = config?.keepOriginal || false;
                if (isImage && !keepOriginal && !SHARP_SUPPORTED_FORMATS.has(file.mimetype)) {
                    return cb(null, {
                        ...file,
                        error: `Unsupported image format for conversion: ${file.mimetype}. Supported formats: JPEG, PNG, WebP, GIF, AVIF, TIFF, SVG, HEIF.`,
                        _skipped: true,
                        _processed: false
                    });
                }
                
                let mainStream = file.stream;
                let backupStream = null;
                
                if(needsBackup){
                    const teeMain = new PassThrough();
                    const teeBackup = new PassThrough();

                    file.stream.pipe(teeMain);
                    file.stream.pipe(teeBackup);

                    mainStream = teeMain;
                    backupStream = teeBackup;
                }

                const highwayController = createHighwayController(file, config, needsBackup, backupStream, outputDir);

                try{
                    await pipeline(mainStream, highwayController);
                    cb(null , highwayController.result);
                }catch(err){
                    if(highwayController.backupPath){
                        cleanupTempFile(highwayController.backupPath);
                    }

                    if (err.message && (
                            err.message.includes('Input file contains unsupported image format') ||
                            err.message.includes('Input buffer contains unsupported image format') ||
                            err.message.includes('unsupported image format') ||
                            err.message.includes('Input file is missing') ||
                            err.code === 'EINVAL'
                    )){
                        main_logger.conversionError(file.originalname, err.message);
                        cb(null , {
                            ...file,
                            error : err.message,
                            _skipped : true,
                            _processed : false
                        })
                    }
                    else{
                        cb(err);
                    }

                }
            
            }catch(err){
                cb(err);
            }
        
        },

        _removeFile(req, file, cb){
            cb(null)
        }
    }
}


/**
 * Creates a highway controller for file processing pipeline
 * @param {Object} file - Multer file object with originalname, mimetype, fieldname
 * @param {Object} config - Field configuration (format, quality, output, cloudStorage, etc.)
 * @param {boolean} needsBackup - Whether to create backup stream for fallback
 * @param {Stream} backupStream - PassThrough stream for backup (if needsBackup is true)
 * @param {string} outputDir - Output directory path for disk writes
 * @returns {Transform} Transform stream controller with processing result
 */
function createHighwayController(file, config, needsBackup = false, backupStream = null, outputDir){
    const output = config?.output || 'memory';
    const format = config?.format || 'webp';
    const quality = config?.quality || 80;
    const keepOriginal = config?.keepOriginal || false;
    const isImage = file.mimetype && file.mimetype.startsWith('image');
    const filename = file.originalname;
    const isCloudUpload = config?.cloudStorage || false; // ← Derive from config instead of parameter

    const shouldConvert = isImage && !keepOriginal;

    let converter = null;
    let diskstream = null;
    let memoryBuffer = [];
    let cloudUploadStream = null;
    let normalizedOutputDir , outputPath;
    let totalSize = 0;

    //pending states
    let pendingCloudUpload = null;
    let pendingPipeline = null;

    //process completion promise
    let processingCompletePromise = null;
    let resolveProcessingPromise = null;

    let originalFileSize = 0;
    let convertedFileSize = 0;   //used for memory output only as fs.stat not available

    const controller = new Transform({

      
        transform(chunk, enc , cb){
            try{
                originalFileSize += chunk.length;
                if(isCloudUpload){
                    if(shouldConvert){
                        converter.write(chunk);
                    }else{
                        cloudUploadStream.write(chunk)
                    }
                }else if(output === 'disk'){
                    if(shouldConvert){
                        converter.write(chunk);
                    }else{
                        diskstream.write(chunk);
                    }
                }else{
                    if(shouldConvert){
                        converter.write(chunk);
                    }else{
                        memoryBuffer.push(chunk);
                        totalSize += chunk.length;
                    }
                }
                cb()
            }catch(err){
                cb(err);
            }
        },

        async flush(cb){
            try{
                // if(pendingCloudUpload){
                //     await pendingCloudUpload
                // }
                // if(pendingPipeline) {
                //     await pendingPipeline;
                // }

                if(isCloudUpload){
                    if(shouldConvert){
                        if(converter){
                            converter.end();
                        }
                        if(processingCompletePromise){
                            await processingCompletePromise;
                        }
                        cb()
                    }else{
                        if(cloudUploadStream){
                            cloudUploadStream.end();
                        }
                        if(processingCompletePromise){
                            await processingCompletePromise;
                        }
                        cb();
                    }
                }else if(output === 'disk'){
                    if(shouldConvert){
                        if(converter){
                            converter.end()
                        }
                        if(processingCompletePromise){
                            await processingCompletePromise;
                        }
                        cb()
                    }else{
                        if(diskstream){
                            diskstream.end();
                        }
                        if(processingCompletePromise){
                            await processingCompletePromise;
                        }
                        cb();
                    }
                }else{
                    if(shouldConvert){
                        if(converter){
                            converter.end();
                        }
                        if(processingCompletePromise){
                            await processingCompletePromise;
                        }
                        cb();
                    }else{
                        controller.result ={
                            ...file,
                            buffer : Buffer.concat(memoryBuffer, totalSize),
                            size : totalSize
                        }
                        cb();
                    }
                }
            }catch(err){
                cb(err);
            }
            
        }
    });

  
//-----------------------------backup stream setup
    const backupState = {
        backupBuffer: [],
        backupPath: null,
        backupTotalSize: 0,
        useMemoryBackup: true,
        backupWriteStream: null
    };

    if (needsBackup && backupStream) {
        createBackup(backupStream, backupState, file); 
    }

    Object.defineProperty(controller, 'backupPath', {
    get: () => backupState.backupPath,
    enumerable: false
    });   

//----------------------/>

//!-------------------Cloud Upload start

    if(isCloudUpload){
        const cloudProvider = config.cloudProvider;
        const cloudConfig = config.cloudConfig;

        if(shouldConvert){
            converter = sharp().toFormat(format, {quality});
            cloudUploadStream = new PassThrough();

            processingCompletePromise = new Promise((resolve)=>{
                resolveProcessingPromise = resolve;
            })

            let cloudConvertedSize = 0;
            const sizeTracker = new Transform({
                transform(chunk, enc, cb) {
                    cloudConvertedSize += chunk.length;
                    cb(null, chunk);
                }
            });

            pendingPipeline = pipeline(
                converter, 
                sizeTracker,
                cloudUploadStream
            ).catch(async(pipelineErr)=>{
                main_logger.conversionError(filename, pipelineErr.message);

                if(needsBackup && (backupState.backupBuffer.length > 0 || backupState.backupPath)){

                    const backupMetadata = {
                        originalname : file.originalname,
                        fieldname : file.fieldname,
                        mimetype : file.mimetype,
                        size : originalFileSize,
                        filename : filename
                    }

                    const backupData = {
                        buffer : backupState.backupBuffer.length > 0 ? Buffer.concat(backupState.backupBuffer, backupState.backupTotalSize) : null,
                        path : backupState.backupPath
                    }

                    try{
                        const cloudResult = await uploadToCloud(
                            null,
                            backupMetadata,
                            cloudProvider,
                            cloudConfig,
                            backupData
                        )
                       // main_logger.fallbackCloudUploadSuccess(filename, originalFileSize, cloudProvider, cloudResult.cloudUrl)
                        backupState.backupBuffer = [];
                        backupState.backupTotalSize = 0;
                        if(backupState.backupPath){
                            cleanupTempFile(backupState.backupPath);
                        }

                        //change-01: Restructured error metadata with better prop names
                        controller.result = {
                            ...file,
                            ...cloudResult,
                            buffer : undefined,
                            _metadata: {
                                isBackupFallback: true,
                                isSkipped: false,
                                isProcessed: true,
                                errors: {
                                    conversion: pipelineErr.message
                                }
                            }
                        }

                        if(processingCompletePromise) resolveProcessingPromise();

                    }catch(cloudErr){
                       // main_logger.backupFallbackFailed(cloudErr.message);

                        //change-02: Restructured error metadata
                        controller.result = {
                            ...file,
                            _metadata: {
                                isBackupFallback: false,
                                isSkipped: true,
                                isProcessed: false,
                                errors: {
                                    conversion: pipelineErr.message,
                                    cloudUpload: cloudErr.message,
                                    message: `Conversion and cloud upload using fallback failed: ${pipelineErr.message}`
                                }
                            }
                        }
                        if(processingCompletePromise) resolveProcessingPromise();
                    }
                }
                else{
                    //change-03: Restructured error metadata
                    controller.result = {
                        ...file,
                        _metadata: {
                            isBackupFallback: false,
                            isSkipped: true,
                            isProcessed: false,
                            errors: {
                                conversion: pipelineErr.message,
                                message: pipelineErr.message
                            }
                        }
                    }

                    if(processingCompletePromise) resolveProcessingPromise();
                }
            });

            const metadata = {
                originalname : file.originalname,
                fieldname : file.fieldname,
                mimetype : `image/${format.toLowerCase()}`,
                size : originalFileSize,
                originalFileSize : originalFileSize,
                filename : generateConvertedFileName(filename, format)
            }

            const backupData = needsBackup ? {
                buffer : backupState.backupBuffer.length > 0 ? Buffer.concat(backupState.backupBuffer, backupState.backupTotalSize) : null,
                path : backupState.backupPath
            } : null;

            // ✅ FIX: Wait for first data before starting upload to avoid timeout
            let uploadStarted = false;
            cloudUploadStream.once('data', (firstChunk) => {
                if (!uploadStarted) {
                    uploadStarted = true;
                    // Re-emit the first chunk so it's not lost
                    cloudUploadStream.unshift(firstChunk);
                    
                    pendingCloudUpload = uploadToCloud(
                        cloudUploadStream,
                        metadata,
                        cloudProvider,
                        cloudConfig,
                        backupData
                    ).then((cloudResult)=>{
                if(needsBackup){
                    backupState.backupBuffer = [];
                    backupState.backupTotalSize = 0;
                    if(backupState.backupPath) {
                        cleanupTempFile(backupState.backupPath);
                        backupState.backupPath = null;
                    }
                }

                main_logger.convert_cloudUploadSuccess(file.originalname,format,  quality,originalFileSize, cloudConvertedSize, cloudResult.cloudProvider || cloudProvider, cloudResult.cloudUrl);

                controller.result = {
                    ...file,
                    ...cloudResult,
                    buffer : undefined,
                    mimetype: `image/${format.toLowerCase()}`,
                    originalSize: originalFileSize,
                    convertedSize: cloudConvertedSize
                }

                if(processingCompletePromise) resolveProcessingPromise()
            }).catch((cloudErr)=>{
                main_logger.conversionError(filename, `Cloud upload failed: ${cloudErr.message}`);

                //change-04: Restructured error metadata
                controller.result = {
                    ...file,
                    _metadata: {
                        isBackupFallback: false,
                        isSkipped: true,
                        isProcessed: false,
                        errors: {
                            cloudUpload: cloudErr.message,
                            message: `Cloud upload failed: ${cloudErr.message}`
                        }
                    }
                };
                if (processingCompletePromise) resolveProcessingPromise();
                    });
                }
            });
        }
        //--------------------processing original file---------------------------/>
        else{   

            cloudUploadStream = new PassThrough();
            
            processingCompletePromise = new Promise((resolve)=>{
                resolveProcessingPromise = resolve;
            })

            const metadata = {
                originalname : file.originalname,
                fieldname : file.fieldname,
                mimetype : file.mimetype,
                size : originalFileSize,
                originalFileSize : originalFileSize,
                filename : filename
            }

            const backupData = needsBackup ? {
                buffer : backupState.backupBuffer.length > 0 ? Buffer.concat(backupState.backupBuffer, backupState.backupTotalSize) : null,
                path : backupState.backupPath
            } : null;

            // ✅ FIX: Wait for data to be ready without consuming it
            let uploadStarted = false;
            
            cloudUploadStream.once('readable', () => {
                if (!uploadStarted) {
                    uploadStarted = true;

                    pendingCloudUpload = uploadToCloud(
                        cloudUploadStream,
                        metadata,
                        cloudProvider,
                        cloudConfig,
                        backupData
                    ).then((cloudResult)=>{
                if(needsBackup){
                    backupState.backupBuffer = [];
                    backupState.backupTotalSize = 0;
                    if(backupState.backupPath){
                        cleanupTempFile(backupState.backupPath);
                        backupState.backupPath = null
                    }
                }

                controller.result = {
                    ...file,
                    ...cloudResult,
                    buffer : undefined,
                    size : originalFileSize
                }

                if(processingCompletePromise) resolveProcessingPromise();
            }).catch((cloudErr)=>{
                //.log("total size beror error", originalFileSize, backupState.backupTotalSize)
                //change-05: Restructured error metadata
                controller.result = {
                    ...file,
                    _metadata: {
                        isBackupFallback: false,
                        isSkipped: true,
                        isProcessed: false,
                        errors: {
                            cloudUpload: cloudErr.message,
                            message: `Cloud upload failed: ${cloudErr.message}`
                        }
                    }
                };
                if (processingCompletePromise) resolveProcessingPromise();
                    });
                }
            });
        }
    }

//!--------------------disk upload start

    else if(output === 'disk'){
        
        const targetDir = config?.outputDir || outputDir;
         normalizedOutputDir = ensureServerRootDir(targetDir);
        outputPath = path.join(normalizedOutputDir, filename);

        if(shouldConvert){
            converter = sharp().toFormat(format, {quality});
            diskstream = fs.createWriteStream(outputPath);

            processingCompletePromise = new Promise((resolve)=>{
                resolveProcessingPromise = resolve;
            })

            pendingPipeline = pipeline(
                converter,
                diskstream
            ).catch(async(pipelineErr)=>{
                main_logger.conversionError(filename, pipelineErr.message);

                if(needsBackup && (backupState.backupBuffer.length > 0 || backupState.backupPath)){
                    try{
                        const result = await handleDiskBackupFallback(
                            backupState.backupPath, 
                            backupState.backupBuffer, 
                            outputPath,
                            backupState.backupTotalSize
                        );
                        main_logger.backupFallback(filename, 'conversion/disk error');

                        //change-06: Restructured error metadata
                        controller.result = {
                            ...file,
                            path: result.path,
                            buffer: undefined,
                            size: backupState.backupTotalSize,
                            originalSize: originalFileSize,
                            _metadata: {
                                isBackupFallback: true,
                                isSkipped: false,
                                isProcessed: true,
                                errors: {
                                    pipeline: pipelineErr.message
                                }
                            }
                        }
                        if(processingCompletePromise) resolveProcessingPromise();

                    }catch(fallbackErr){
                        main_logger.backupFallbackFailed(fallbackErr.message);
                        
                        //change-07: Restructured error metadata
                        controller.result = {
                            ...file,
                            _metadata: {
                                isBackupFallback: false,
                                isSkipped: true,
                                isProcessed: false,
                                errors: {
                                    pipeline: pipelineErr.message,
                                    fallback: fallbackErr.message,
                                    message: pipelineErr.message
                                }
                            }
                        };
                        if (processingCompletePromise) resolveProcessingPromise();
                    }
                }
                else{
                    //change-08: Restructured error metadata
                    controller.result = {
                        ...file,
                        _metadata: {
                            isBackupFallback: false,
                            isSkipped: true,
                            isProcessed: false,
                            errors: {
                                pipeline: pipelineErr.message,
                                message: pipelineErr.message
                            }
                        }
                    }

                    if(processingCompletePromise) resolveProcessingPromise();
                }
            });

            // console.log("pipleine :", pendingPipeline)
            diskstream.on('finish', async()=>{
                if(needsBackup){
                    backupState.backupBuffer = [];
                    if(backupState.backupPath){
                        cleanupTempFile(backupState.backupPath);
                        backupState.backupPath = null;
                    }
                }

                if(shouldConvert){
                    const convertedFileName = generateConvertedFileName(filename, format);
                    const revisedOutputPath = path.join(normalizedOutputDir,convertedFileName);

                    try{
                        await fsPromise.rename(outputPath, revisedOutputPath);

                        if(originalFileSize > 0){
                            const stats = await fsPromise.stat(revisedOutputPath);
                            const convertedFileSize = stats.size;
                            main_logger.conversionSuccess(filename, format, quality, originalFileSize, convertedFileSize);

                            controller.result = {
                                ...file,
                                buffer : undefined,
                                path : revisedOutputPath,
                                filename : convertedFileName,
                                mimetype : `image/${format.toLowerCase()}`,
                                originalSize : originalFileSize,
                                convertedSize : convertedFileSize
                            }
                            
                        }
                    }catch(err){
                        console.warn(`[WARN] Could not rename converted file: ${err.message}`);

                        if(originalFileSize > 0){
                            const stats = await fsPromise.stat(outputPath);
                            const convertedFileSize = stats.size;

                            main_logger.conversionSuccess(filename, format, quality, originalFileSize, convertedFileSize);

                            controller.result = {
                                ...file,
                                buffer : undefined,
                                path : path.basename(outputPath),
                                mimetype : `image/${format.toLowerCase()}`,
                                originalSize : originalFileSize,
                                convertedSize : convertedFileSize
                            }
                           
                        }
                    }
                }
                else{
                     controller.result = {
                        ...file,
                        buffer: undefined,
                        path: outputPath,
                        filename: path.basename(outputPath),
                        size: originalFileSize  
                    };
                }
            if(processingCompletePromise) resolveProcessingPromise();
            });
        }
        //-------------saving original to disk-------------------------------------/>
        else{
            diskstream = fs.createWriteStream(outputPath);

            processingCompletePromise = new Promise((resolve)=>{
                resolveProcessingPromise = resolve;
            })

            diskstream.on('error', (e) => {
              main_logger.diskWriteError(filename, e.message);
              
              //change-09: Restructured error metadata
              controller.result = {
                ...file,
                _metadata: {
                    isBackupFallback: false,
                    isSkipped: true,
                    isProcessed: false,
                    errors: {
                        diskWrite: e.message,
                        message: e.message
                    }
                }
              };
              diskstream.destroy();
              if (processingCompletePromise) resolveProcessingPromise();
            });

            diskstream.on('finish', () => {
                controller.result = {
                    ...file,
                    buffer: undefined,
                    path: outputPath,
                    filename: path.basename(outputPath),
                    size: originalFileSize
                };
                if (processingCompletePromise) resolveProcessingPromise();
            });
        }
    }

//!---------------------Memory output start
    else{

        if(shouldConvert){
            converter = sharp().toFormat(format, {quality});

            processingCompletePromise = new Promise((resolve)=>{
                resolveProcessingPromise = resolve;
            })

             converter.on('error', async(err)=>{
                main_logger.conversionError(filename, err.message);

                if(needsBackup && (backupState.backupBuffer.length > 0 || backupState.backupPath)){
                    try{
                        const backup_buf = await handleMemoryBackupFallback(backupState.backupPath, backupState.backupBuffer, backupState.backupTotalSize);

                        main_logger.backupFallback(filename, 'conversion error')
                        
                        //change-10: Restructured error metadata
                        controller.result = {
                            ...file,
                            buffer : backup_buf,
                            size : backupState.backupTotalSize,
                            originalSize : originalFileSize,
                            _metadata: {
                                isBackupFallback: true,
                                isSkipped: false,
                                isProcessed: true,
                                errors: {
                                    conversion: err.message
                                }
                            }
                        }

                        if(processingCompletePromise) resolveProcessingPromise();
                    }catch(err){
                        main_logger.backupFallbackFailed(err.message);

                        //change-11: Restructured error metadata
                        controller.result = {
                            ...file,
                            _metadata: {
                                isBackupFallback: false,
                                isSkipped: true,
                                isProcessed: false,
                                errors: {
                                    conversion: err.message,
                                    message: err.message
                                }
                            }
                        };

                        if(processingCompletePromise) resolveProcessingPromise();
                    }
                }
                else{
                    //change-12: Restructured error metadata
                    controller.result = {
                        ...file,
                        _metadata: {
                            isBackupFallback: false,
                            isSkipped: true,
                            isProcessed: false,
                            errors: {
                                conversion: err.message,
                                message: err.message
                            }
                        }
                    }
                    if(processingCompletePromise) resolveProcessingPromise();
                }
                converter.destroy();
            });

            converter.on('data', (chunk)=>{
                memoryBuffer.push(chunk);
                convertedFileSize += chunk.length;
            });

           
            converter.on('end', ()=>{
                if(needsBackup){
                    backupState.backupBuffer = [];
                    if(backupState.backupPath){
                        cleanupTempFile(backupState.backupPath);
                        backupState.backupPath = null;
                    }
                }

                if(originalFileSize > 0){
                    main_logger.conversionSuccess(filename, format, quality, originalFileSize, convertedFileSize);
                }

                controller.result = {
                    ...file,
                    buffer : Buffer.concat(memoryBuffer, convertedFileSize),
                    mimetype : `image/${format.toLowerCase()}`,
                    size : convertedFileSize,
                    originalSize : originalFileSize,
                };

                if(processingCompletePromise) resolveProcessingPromise();
            });
        }
    }

    return controller
}


async function handleMemoryBackupFallback(backupPath, backupBuffer, size){
    let finalBuffer = null;

    if(backupPath){     // Disk backup (>7MB)
        finalBuffer = await fsPromise.readFile(backupPath);
        cleanupTempFile(backupPath);
    }else{
        finalBuffer = Buffer.concat(backupBuffer, size);
    }

    return finalBuffer;
}

async function handleDiskBackupFallback(backupPath, backupBuffer, outputPath, size){
    if(backupPath){
        await pipeline(
            fs.createReadStream(backupPath),
            fs.createWriteStream(outputPath)
        ).catch((pipelineErr)=>{
            throw new Error(pipelineErr.message);
        });

        cleanupTempFile(backupPath)
    }else{
        await fsPromise.writeFile(outputPath, Buffer.concat(backupBuffer, size));
    }
    return {
        path : outputPath,
        size : size
    }
}

function createBackup(backupStream, state, file) {   //note : here backupstream is already an readable stream : tee stream
  backupStream.on('data', (chunk) => {
    state.backupTotalSize += chunk.length;

    if (state.useMemoryBackup && state.backupTotalSize > LARGE_FILE_THRESHOLD_BYTES) {
      state.useMemoryBackup = false;

      const tempDir = path.join(os.tmpdir(), 'upfly-backupDir');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const unique = `${Date.now()}-${Math.random().toString(16).slice(2,10)}`;
      state.backupPath = path.join(tempDir, `backup-${unique}`);
      tempFilesPathRegistry.add(state.backupPath);

      state.backupWriteStream = fs.createWriteStream(state.backupPath);

      if (state.backupBuffer.length > 0) {
        for (const buffered of state.backupBuffer) {
          state.backupWriteStream.write(buffered);
        }
        state.backupBuffer = []; // free memory
      }
      state.backupWriteStream.write(chunk);
      return;
    }

    if (state.useMemoryBackup) {
      state.backupBuffer.push(chunk);
    } else if (state.backupWriteStream) {
      state.backupWriteStream.write(chunk);
    }
  });

  backupStream.on('end', () => {
    if (state.backupWriteStream) {
      state.backupWriteStream.end();
    }
  });

  backupStream.on('error', (err) => {
    main_logger.backupStreamError(file.originalname, err.message);
    if (state.backupWriteStream) state.backupWriteStream.destroy();
    if (state.backupPath) cleanupTempFile(state.backupPath);
    if(state.backupBuffer) state.backupBuffer = [];
  });
}


//! ========================================
//! CONVERSION-ONLY MIDDLEWARE (Enhanced)
//! ========================================

/**
 * @typedef {Object} ConvertOptions
 * @property {Object.<string, FieldConfig>} fields - Field configurations mapped by HTML form field names
 * @property {string} [outputDir='./uploads'] - Output directory for disk storage (relative to project root)
 * @property {boolean} [safeFile=false] - Enable backup fallback system for failed conversions
 */

/**
 * Conversion-only middleware for already uploaded files (works with req.file/req.files)
 * @param {ConvertOptions} options - Conversion configuration options
 * @returns {Function} Express middleware function
 */
const upflyConvert = (options = {}) => {
  const { 
    fields = {},
    outputDir = './uploads',
    safeFile = false 
  } = options;

  // Validate fields configuration
  if(typeof fields !== 'object' || fields === null || Array.isArray(fields) ){
    throw new TypeError("`fields` option must be a plain object with field configurations.");
  }

  if(typeof outputDir !== 'string'){
    throw new TypeError("`outputDir` option must be a string.");
  }

  if (typeof safeFile !== 'boolean') {
    throw new TypeError("`safeFile` option must be a boolean.");
  }

  for (const [fieldname, config] of Object.entries(fields)) {
    if (typeof config !== 'object' || config === null) {
      throw new TypeError(`Field config for '${fieldname}' must be an object.`);
    }

    if (config.output && !['disk', 'memory'].includes(config.output)) {
      throw new RangeError(`Field '${fieldname}' has invalid output value '${config.output}'. Allowed: 'disk', 'memory'.`);
    }
      if (config.outputDir !== undefined && typeof config.outputDir !== 'string') {
      throw new TypeError(`Field '${fieldname}' outputDir must be a string.`);
    }

    if (config.quality !== undefined) {
      if (typeof config.quality !== 'number' || config.quality < 1 || config.quality > 100) {
        throw new RangeError(`Field '${fieldname}' quality must be a number between 1 and 100.`);
      }
    }

    if (config.format !== undefined && typeof config.format !== 'string') {
      throw new TypeError(`Field '${fieldname}' format must be a string.`);
    }

    if (config.keepOriginal !== undefined && typeof config.keepOriginal !== 'boolean') {
      throw new TypeError(`Field '${fieldname}' keepOriginal must be a boolean.`);
    }
  }

  return async (req, res, next) => {
    try {
      // Handle single file (req.file)
      if (req.file && req.file.buffer) {
        const config = fields[req.file.fieldname] || {};
        const isImage = req.file.mimetype && req.file.mimetype.startsWith('image');
        
        if (isImage && !config.keepOriginal) {
          const output = config.output || 'memory';
          const format = config.format || 'webp';
          const quality = config.quality || 80;
        const targetDir = config.outputDir || outputDir;

          try {
            if (output === 'disk') {
              req.file = await convertBufferToDisk(req.file, format, quality, targetDir, safeFile);
            } else {
              req.file = await convertBufferToMemory(req.file, format, quality, safeFile);
            }
          } catch (err) {
            main_logger.conversionError(req.file.originalname, err.message);
          }
        }
      }

      // Handle multiple files (req.files)
      if (req.files && typeof req.files === 'object') {
        const filesMap = Array.isArray(req.files) 
          ? groupFilesByField(req.files)
          : req.files;

        for (const fieldname in filesMap) {
          if (!filesMap[fieldname] || filesMap[fieldname].length === 0) continue;

          const config = fields[fieldname] || {};
          const output = config.output || 'memory';
          const format = config.format || 'webp';
          const quality = config.quality || 80;
          const targetDir = config.outputDir || outputDir;

          filesMap[fieldname] = await Promise.all(
            filesMap[fieldname].map(async (file) => {
              if (!file.buffer) return file;

              const isImage = file.mimetype && file.mimetype.startsWith('image');
              
              if (!isImage || config.keepOriginal) {
                return file;
              }

              try {
                if (output === 'disk') {
                  return await convertBufferToDisk(file, format, quality, targetDir, safeFile);
                } else {
                  return await convertBufferToMemory(file, format, quality, safeFile);
                }
              } catch (err) {
                main_logger.conversionError(file.originalname, err.message);
                return file;
              }
            })
          );
        }

        if (!Array.isArray(req.files)) {
          req.files = filesMap;
        }
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};

//! ========================================
//! CONVERSION HELPERS FOR upflyConvert
//! ========================================

async function convertBufferToMemory(file, format, quality, safeFile) {
  const originalSize = file.buffer.length;
  let backupBuffer = safeFile ? file.buffer : null;
  
  return new Promise((resolve, reject) => {
    const bufferStream = Readable.from(file.buffer);
    const converter = sharp().toFormat(format, { quality });
    
    const memoryBuffer = [];
    let totalSize = 0;
    let hasError = false;

    converter.on('error', (err) => {
      if (hasError) return;
      hasError = true;
      
      main_logger.conversionError(file.originalname, err.message);
      
      // Fallback to backup if available
      if (safeFile && backupBuffer) {
        main_logger.backupFallback(file.originalname, 'conversion error');
        resolve({
          ...file,
          buffer: backupBuffer,
          size: backupBuffer.length,
          convertedSize: backupBuffer.length, // ← Add for consistency
          originalSize: originalSize, // ← Add for consistency
          _metadata: { // ← Use same error structure as upflyUpload
            isBackupFallback: true,
            isSkipped: false,
            isProcessed: true,
            errors: {
              conversion: err.message
            }
          }
        });
      } else {
        // Return original file on error
        resolve(file);
      }
    });

    converter.on('data', (chunk) => {
      memoryBuffer.push(chunk);
      totalSize += chunk.length;
    });

    converter.on('end', () => {
      if (hasError) return;

      const convertedBuffer = Buffer.concat(memoryBuffer, totalSize);
      
      // Log success
      main_logger.conversionSuccess(file.originalname, format, quality, originalSize, totalSize);

      resolve({
        ...file,
        buffer: convertedBuffer,
        size: totalSize,
        convertedSize: totalSize, 
        originalSize: originalSize, 
        mimetype: `image/${format.toLowerCase()}`
      });
    });

    // Pipe buffer stream to converter
    bufferStream.pipe(converter);

    bufferStream.on('error', (err) => {
      if (hasError) return;
      hasError = true;
      reject(err);
    });
  });
}

// Convert buffer to disk with backup support
async function convertBufferToDisk(file, format, quality, outputDir, safeFile) {
  const originalSize = file.buffer.length;
  let backupBuffer = safeFile ? file.buffer : null;
  const normalizedOutputDir = ensureServerRootDir(outputDir);
  
  // Generate filenames
  const originalFileName = generateFileName(file);
  const convertedFileName = generateConvertedFileName(originalFileName, format);
  const outputPath = path.join(normalizedOutputDir, convertedFileName);
  
  return new Promise((resolve, reject) => {
    const bufferStream = Readable.from(file.buffer);
    const converter = sharp().toFormat(format, { quality });
    const diskStream = fs.createWriteStream(outputPath);
    
    let hasError = false;

    converter.on('error', async (err) => {
      if (hasError) return;
      hasError = true;
      
      main_logger.conversionError(file.originalname, err.message);
      diskStream.destroy();
      
      // Fallback to backup if available
      if (safeFile && backupBuffer) {
        main_logger.backupFallback(file.originalname, 'conversion error');
        const backupFileName = generateFileName(file);
        const backupOutputPath = path.join(normalizedOutputDir, backupFileName);
        
        try {
          fs.writeFileSync(backupOutputPath, backupBuffer);
          resolve({
            ...file,
            path: backupOutputPath,
            filename: backupFileName,
            buffer: undefined,
            size: backupBuffer.length,
            convertedSize: backupBuffer.length, // ← Add for consistency
            originalSize: originalSize, // ← Add for consistency
            _metadata: { // ← Use same error structure as upflyUpload
              isBackupFallback: true,
              isSkipped: false,
              isProcessed: true,
              errors: {
                conversion: err.message
              }
            }
          });
        } catch (fallbackErr) {
          main_logger.backupFallbackFailed(fallbackErr.message);
          resolve(file);
        }
      } else {
        resolve(file);
      }
    });

    diskStream.on('error', async (err) => {
      if (hasError) return;
      hasError = true;
      
      main_logger.diskWriteError(file.originalname, err.message);
      converter.destroy();
      
      // Fallback to backup if available
      if (safeFile && backupBuffer) {
        main_logger.backupFallback(file.originalname, 'disk write error');
        const backupFileName = generateFileName(file);
        const backupOutputPath = path.join(normalizedOutputDir, backupFileName);
        
        try {
          fs.writeFileSync(backupOutputPath, backupBuffer);
          resolve({
            ...file,
            path: backupOutputPath,
            filename: backupFileName,
            buffer: undefined,
            size: backupBuffer.length,
            convertedSize: backupBuffer.length, // ← Add for consistency
            originalSize: originalSize, // ← Add for consistency
            _metadata: { // ← Use same error structure as upflyUpload
              isBackupFallback: true,
              isSkipped: false,
              isProcessed: true,
              errors: {
                diskWrite: err.message
              }
            }
          });
        } catch (fallbackErr) {
          main_logger.backupFallbackFailed(fallbackErr.message);
          // Return original file in memory
          resolve(file);
        }
      } else {
        // Return original file on error
        resolve(file);
      }
    });

    diskStream.on('finish', () => {
      if (hasError) return;
      
      // Get file stats for logging
      fs.stat(outputPath, (err, stats) => {
        if (!err) {
          main_logger.conversionSuccess(file.originalname, format, quality, originalSize, stats.size);
        }
        
        resolve({
          ...file,
          path: outputPath,
          filename: convertedFileName,
          buffer: undefined,
          size: stats ? stats.size : undefined,
          convertedSize: stats ? stats.size : undefined, // ← Add for consistency with upflyUpload
          originalSize: originalSize, // ← Add for consistency with upflyUpload
          mimetype: `image/${format.toLowerCase()}`
        });
      });
    });

    // Pipeline: buffer → converter → disk
    bufferStream.pipe(converter).pipe(diskStream);

    bufferStream.on('error', (err) => {
      if (hasError) return;
      hasError = true;
      reject(err);
    });
  });
}


//! ========================================
//! HELPER FUNCTIONS
//! ========================================
function groupFilesByField(filesArray) {
  const grouped = {};
  for (const file of filesArray) {
    if (!grouped[file.fieldname]) {
      grouped[file.fieldname] = [];
    }
    grouped[file.fieldname].push(file);
  }
  return grouped;
}


function cleanupTempFile(path){
    if(!path) return;

    try{
        if(fs.existsSync(path)){
            fs.unlinkSync(path);
            tempFilesPathRegistry.delete(path)
        }
    }catch(err){
        main_logger.cleanupWarning(path, err.message)
    }
}

// Ensure server root directory
const ensureServerRootDir = (targetPath) =>{
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new TypeError('`outputDir` must be a non-empty string path.');
  }

  const input = targetPath.trim();
  const isWindowsDriveAbs = /^[a-zA-Z]:[\\/]/.test(input);
  const looksRootedBySlash = /^[\\/]/.test(input);

  let resolved;
  if (isWindowsDriveAbs) {
    resolved = input;
    
  } else if (looksRootedBySlash) {
    const stripped = input.replace(/^[/\\]+/, '');
    resolved = path.resolve(process.cwd(), stripped);

    if (process.env.NODE_ENV !== 'production' && !ensureServerRootDir._warned) {
      main_logger.pathResolutionWarning(input, resolved);
      ensureServerRootDir._warned = true;
    }
  } else {
    resolved = path.resolve(process.cwd(), input);
  }

  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }

  return resolved;
}


// Slugify filename
const slugify = (originalBase) =>{
    return originalBase
      .toString()
      .trim()
      .toLowerCase() 
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
}


// Generate unique filename
const generateFileName = (file) =>{
  const originalname = file?.originalname;
  const fieldname = file?.fieldname;
  const parsed = path.parse(originalname || 'file');
  const originalBase = parsed.name;
  const originalExt = (parsed.ext || '').replace(/^\./, '').toLowerCase();
  const slugifiedBase = slugify(originalBase);

  let parts = [];
  if (
    file.mimetype &&
    file.mimetype.startsWith('image') &&
    typeof fieldname === 'string' &&
    fieldname.trim()
  ) {
    parts.push(fieldname.trim());
  }
  if (slugifiedBase) parts.push(slugifiedBase);
  const uniqueSuffix = `${Math.random().toString(16).slice(2,6)}`;
  parts.push(uniqueSuffix);

  const finalName = parts.join('-');
  return `${finalName}.${originalExt}`;
}


// Generate converted filename
const generateConvertedFileName = (originalFileName, newFormat) => {
  const parsed = path.parse(originalFileName);
  const baseName = parsed.name;
  return `${baseName}.${newFormat.toLowerCase()}`;
}

module.exports = {
  upflyUpload,
  upflyConvert
};