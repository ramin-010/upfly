import { RequestHandler } from "express";

//! ========================================
//! CLOUD PROVIDER TYPES
//! ========================================

export type CloudProvider = 'cloudinary' | 's3' | 'aws' | 'gcs' | 'google';
export type ImageFormat = 'webp' | 'jpeg' | 'jpg' | 'png' | 'avif' | 'tiff' | 'gif' | 'heif';
export type OutputDestination = 'disk' | 'memory';
export type AWSRegion = 'us-east-1' | 'us-east-2' | 'us-west-1' | 'us-west-2' | 'eu-west-1' | 'eu-west-2' | 'eu-central-1' | 'ap-south-1' | 'ap-southeast-1' | 'ap-southeast-2' | 'ap-northeast-1' | string;
export type S3ACL = 'private' | 'public-read' | 'public-read-write' | 'authenticated-read' | 'aws-exec-read' | 'bucket-owner-read' | 'bucket-owner-full-control';
export type S3StorageClass = 'STANDARD' | 'REDUCED_REDUNDANCY' | 'STANDARD_IA' | 'ONEZONE_IA' | 'INTELLIGENT_TIERING' | 'GLACIER' | 'DEEP_ARCHIVE';
export type GCSStorageClass = 'STANDARD' | 'NEARLINE' | 'COLDLINE' | 'ARCHIVE';
export type CloudinaryResourceType = 'image' | 'video' | 'raw' | 'auto';

//! ========================================
//! CLOUD CONFIGURATION INTERFACES
//! ========================================

/**
 * Cloudinary cloud storage configuration
 * @see https://cloudinary.com/documentation/node_integration
 */
export interface CloudinaryConfig {
  /** Your Cloudinary cloud name (required) */
  cloud_name: string;
  /** Your Cloudinary API key (required) */
  api_key: string;
  /** Your Cloudinary API secret (required) */
  api_secret: string;
  /** Optional folder path for organizing uploads (e.g., 'avatars', 'products') */
  folder?: string;
  /** Use HTTPS URLs (default: true) */
  secure?: boolean;
  /** Resource type: 'image', 'video', 'raw', 'auto' (default: 'auto') */
  resource_type?: CloudinaryResourceType;
  /** Cloudinary transformation parameters */
  transformation?: Record<string, any>;
  /** Custom public ID (auto-generated if not provided) */
  public_id?: string;
  /** Overwrite existing files with same public_id (default: false) */
  overwrite?: boolean;
  /** Array of tags to assign to the upload */
  tags?: string[];
  /** Additional Cloudinary upload options */
  uploadOptions?: Record<string, any>;
}

/**
 * AWS S3 cloud storage configuration
 * @see https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html
 */
export interface S3Config {
  /** AWS region (e.g., 'us-east-1', 'eu-west-1') - required */
  region: AWSRegion;
  /** S3 bucket name (required) */
  bucket: string;
  /** AWS access key ID (required) */
  accessKeyId: string;
  /** AWS secret access key (required) */
  secretAccessKey: string;
  /** Optional key prefix/folder (e.g., 'uploads/', 'images/') */
  keyPrefix?: string;
  /** Access control: 'private', 'public-read', etc. (default: 'public-read') */
  acl?: S3ACL;
  /** Custom metadata object */
  metadata?: Record<string, any>;
  /** Storage class: 'STANDARD', 'GLACIER', etc. (default: 'STANDARD') */
  storageClass?: S3StorageClass;
  /** Server-side encryption: 'AES256', 'aws:kms' */
  serverSideEncryption?: string;
  /** Custom domain for URLs (e.g., 'cdn.example.com') */
  customDomain?: string;
  /** Additional AWS S3 client options */
  clientOptions?: Record<string, any>;
  /** Additional S3 upload parameters */
  uploadParams?: Record<string, any>;
}

/**
 * Google Cloud Storage configuration
 * @see https://cloud.google.com/storage/docs/reference/libraries
 */
export interface GCSConfig {
  /** GCS bucket name (required) */
  bucket: string;
  /** Path to service account key file (.json) */
  keyFilename?: string;
  /** Service account credentials object (alternative to keyFilename) */
  credentials?: Record<string, any>;
  /** Google Cloud project ID (auto-detected if using keyFilename) */
  projectId?: string;
  /** Optional object name prefix/folder (e.g., 'uploads/', 'images/') */
  prefix?: string;
  /** Make uploaded files publicly accessible (default: true) */
  public?: boolean;
  /** Custom metadata object */
  metadata?: Record<string, any>;
  /** Storage class: 'STANDARD', 'NEARLINE', 'COLDLINE', 'ARCHIVE' (default: 'STANDARD') */
  storageClass?: GCSStorageClass;
  /** Custom domain for URLs (e.g., 'storage.example.com') */
  customDomain?: string;
  /** Use resumable uploads for large files (default: true for files >5MB) */
  resumable?: boolean;
  /** Additional GCS upload options */
  uploadOptions?: Record<string, any>;
}

//! ========================================
//! FIELD CONFIGURATION TYPES
//! ========================================

/**
 * Base configuration for file field processing
 */
export interface BaseFieldConfig {
  /** Where to store processed files: 'disk' or 'memory' (default: 'memory') */
  output?: OutputDestination;
  /** Field-specific output directory (only for output='disk') */
  outputDir?: string;
  /** Target image format for conversion (default: 'webp'). Only for images when keepOriginal is false. */
  format?: ImageFormat;
  /** Compression quality 1-100 (default: 80). Higher = better quality, larger size. */
  quality?: number;
  /** Skip conversion, keep original format and quality (default: false) */
  keepOriginal?: boolean;
  /** Enable cloud storage upload (default: false) */
  cloudStorage?: boolean;
}

export interface LocalFieldConfig extends BaseFieldConfig {
  cloudStorage?: false;
}

export interface CloudinaryFieldConfig extends BaseFieldConfig {
  cloudStorage: true;
  cloudProvider: 'cloudinary';
  cloudConfig: CloudinaryConfig;
}

export interface S3FieldConfig extends BaseFieldConfig {
  cloudStorage: true;
  cloudProvider: 's3' | 'aws';
  cloudConfig: S3Config;
}

export interface GCSFieldConfig extends BaseFieldConfig {
  cloudStorage: true;
  cloudProvider: 'gcs' | 'google';
  cloudConfig: GCSConfig;
}

export type FieldConfig = LocalFieldConfig | CloudinaryFieldConfig | S3FieldConfig | GCSFieldConfig;

//! ========================================
//! MAIN OPTIONS INTERFACES
//! ========================================

/**
 * Main options for upflyUpload middleware
 */
export interface UpflyOptions {
  /** Field configurations mapped by HTML form field names */
  fields: Record<string, FieldConfig>;
  /** Global output directory for disk storage (default: './uploads'). Field-specific outputDir takes precedence when specified. */
  outputDir?: string;
  /** Maximum file size in bytes (default: 10485760 = 10MB) */
  limit?: number;
  /** Enable backup fallback system for failed conversions (default: false) */
  safeFile?: boolean;
}

/**
 * Options for upflyConvert middleware (conversion-only)
 */
export interface ConvertOptions {
  /** Field configurations mapped by HTML form field names */
  fields: Record<string, FieldConfig>;
  /** Global output directory for disk storage (default: './uploads'). Field-specific outputDir takes precedence when specified. */
  outputDir?: string;
  /** Enable backup fallback system for failed conversions (default: false) */
  safeFile?: boolean;
}

//! ========================================
//! FILE RESULT INTERFACES
//! ========================================

/**
 * Error metadata attached to files when processing fails or uses fallback
 */
export interface FileErrorMetadata {
  /** True if original file was used as fallback due to conversion failure */
  isBackupFallback: boolean;
  /** True if processing completely failed (file not available) */
  isSkipped: boolean;
  /** True if file was successfully processed (even if via fallback) */
  isProcessed: boolean;
  /** Detailed error information */
  errors: {
    /** Sharp image conversion error message */
    conversion?: string;
    /** Cloud upload error message */
    cloudUpload?: string;
    /** Disk write error message */
    diskWrite?: string;
    /** Pipeline processing error message */
    pipeline?: string;
    /** Backup fallback error message */
    fallback?: string;
    /** General error message */
    message?: string;
  };
}

/**
 * Cloud upload result metadata
 */
export interface CloudResult {
  /** Cloud provider name ('cloudinary', 's3', 'gcs') */
  cloudProvider: string;
  /** Public URL of the uploaded file */
  cloudUrl: string;
  /** Cloud provider's unique identifier for the file */
  cloudPublicId: string;
  /** File size in bytes (for converted images) */
  cloudSize?: number;
  /** File format/extension */
  cloudFormat?: string;
  /** Image width in pixels (if available) */
  cloudWidth?: number;
  /** Image height in pixels (if available) */
  cloudHeight?: number;
  /** Upload timestamp */
  cloudCreatedAt?: string;
  /** Resource type (e.g., 'image', 'video') */
  cloudResourceType?: string;
  /** Bucket/container name (S3/GCS) */
  cloudBucket?: string;
  /** Cloud region (S3) */
  cloudRegion?: string;
  /** Entity tag for cache validation (S3) */
  cloudETag?: string;
  /** MIME type of the uploaded file */
  cloudContentType?: string;
  /** Raw response from cloud provider */
  _cloudRaw?: any;
}

/**
 * Upfly file object (extends Multer file with additional properties)
 */
export interface UpflyFile {
  /** HTML form field name */
  fieldname: string;
  /** Original filename from user's device */
  originalname: string;
  /** File encoding type */
  encoding: string;
  /** MIME type of the file */
  mimetype: string;
  /** Final file size in bytes (after conversion if applicable) */
  size?: number;
  /** Original file size before conversion */
  originalSize?: number;
  /** Converted file size (for tracking compression savings) */
  convertedSize?: number;
  /** File buffer (when output: 'memory') */
  buffer?: Buffer;
  /** File path (when output: 'disk') */
  path?: string;
  /** Generated filename */
  filename?: string;
  /** Error message if processing failed */
  error?: string;
  /** @deprecated Use _metadata.isSkipped instead */
  _skipped?: boolean;
  /** @deprecated Use _metadata.isProcessed instead */
  _processed?: boolean;
  /** Error and fallback metadata */
  _metadata?: FileErrorMetadata;
  // Cloud storage properties (when cloudStorage is enabled)
  /** Cloud provider name */
  cloudProvider?: string;
  /** Public URL of uploaded file */
  cloudUrl?: string;
  /** Cloud provider's file identifier */
  cloudPublicId?: string;
  /** Cloud file size */
  cloudSize?: number;
  /** Cloud file format */
  cloudFormat?: string;
  /** Image width (if available) */
  cloudWidth?: number;
  /** Image height (if available) */
  cloudHeight?: number;
  /** Upload timestamp */
  cloudCreatedAt?: string;
  /** Resource type */
  cloudResourceType?: string;
  /** Bucket name (S3/GCS) */
  cloudBucket?: string;
  /** Region (S3) */
  cloudRegion?: string;
  /** ETag (S3) */
  cloudETag?: string;
  /** Content type */
  cloudContentType?: string;
  /** Raw cloud response */
  _cloudRaw?: any;
}

//! ========================================
//! EXPRESS REQUEST EXTENSIONS
//! ========================================

export interface UpflyRequest extends Express.Request {
  file?: UpflyFile;
  files?: Record<string, UpflyFile[]> | UpflyFile[];
}

//! ========================================
//! MAIN FUNCTIONS
//! ========================================

/**
 * upflyUpload — Complete upload and conversion middleware
 * 
 * **Features:**
 * - Multi-format image conversion (WebP, JPEG, PNG, AVIF, TIFF, GIF, HEIF)
 * - Cloud storage support (Cloudinary, AWS S3, Google Cloud Storage)
 * - Memory or disk output options
 * - Automatic backup fallback system (safeFile option)
 * - Stream-based, non-blocking I/O for large files (>7MB)
 * - Safe file handling and automatic cleanup
 * - Format validation (Sharp-supported formats only)
 * 
 * **Supported Input Formats (when keepOriginal: false):**
 * JPEG, PNG, WebP, GIF, AVIF, TIFF, SVG, HEIF/HEIC
 * 
 * **Output Formats:**
 * WebP, JPEG, PNG, AVIF, TIFF, GIF, HEIF
 * 
 * @param options Upload configuration options
 * @returns Express middleware function
 * 
 * @example
 * ```typescript
 * import { upflyUpload } from 'upfly';
 * 
 * app.post('/upload', 
 *   upflyUpload({
 *     fields: {
 *       avatar: { 
 *         format: 'webp',
 *         quality: 85,
 *         cloudStorage: true,
 *         cloudProvider: 'cloudinary',
 *         cloudConfig: { cloud_name: 'demo', api_key: 'key', api_secret: 'secret' }
 *       },
 *       documents: {
 *         output: 'disk',
 *         outputDir: './uploads/documents', // Field-specific directory
 *         keepOriginal: true
 *       }
 *     },
 *     outputDir: './uploads', // Global fallback directory
 *     safeFile: true
 *   }),
 *   (req, res) => {
 *     res.json({ url: req.files.avatar[0].cloudUrl });
 *   }
 * );
 * ```
 */
export declare function upflyUpload(options?: UpflyOptions): RequestHandler;

/**
 * upflyConvert — Conversion-only middleware for pre-uploaded files
 * 
 * Use this when you already have files in req.file/req.files from your own Multer setup.
 * Applies per-field image conversion without handling the upload itself.
 * 
 * **Requirements:**
 * - Files must be in memory (req.file.buffer or req.files[].buffer)
 * - Works with both single (req.file) and multiple (req.files) files
 * 
 * @param options Conversion configuration options
 * @returns Express middleware function
 * 
 * @example
 * ```typescript
 * import { upflyConvert } from 'upfly';
 * import multer from 'multer';
 * 
 * const upload = multer({ storage: multer.memoryStorage() });
 * 
 * app.post('/convert',
 *   upload.fields([{ name: 'avatar', maxCount: 1 }, { name: 'docs', maxCount: 5 }]),
 *   upflyConvert({
 *     fields: {
 *       avatar: { 
 *         format: 'webp', 
 *         quality: 80, 
 *         output: 'disk',
 *         outputDir: './uploads/avatars' // Field-specific directory
 *       },
 *       docs: { 
 *         keepOriginal: true,
 *         output: 'disk',
 *         outputDir: './uploads/documents' // Different field directory
 *       }
 *     },
 *     outputDir: './uploads' // Global fallback
 *   }),
 *   (req, res) => {
 *     res.json({ files: req.files });
 *   }
 * );
 * ```
 */
export declare function upflyConvert(options?: ConvertOptions): RequestHandler;

//! ========================================
//! CLOUD ADAPTER EXPORTS (Advanced Usage)
//! ========================================

export interface CloudAdapter {
  validateConnection(): Promise<boolean>;
  upload(stream: NodeJS.ReadableStream, metadata: any): Promise<CloudResult>;
  delete(publicId: string): Promise<void>;
}

export declare class CloudinaryAdapter implements CloudAdapter {
  constructor(config: CloudinaryConfig);
  validateConnection(): Promise<boolean>;
  upload(stream: NodeJS.ReadableStream, metadata: any): Promise<CloudResult>;
  delete(publicId: string): Promise<void>;
}

export declare class S3Adapter implements CloudAdapter {
  constructor(config: S3Config);
  validateConnection(): Promise<boolean>;
  upload(stream: NodeJS.ReadableStream, metadata: any): Promise<CloudResult>;
  delete(publicId: string): Promise<void>;
}

export declare class GCSAdapter implements CloudAdapter {
  constructor(config: GCSConfig);
  validateConnection(): Promise<boolean>;
  upload(stream: NodeJS.ReadableStream, metadata: any): Promise<CloudResult>;
  delete(publicId: string): Promise<void>;
}

export declare function createCloudAdapter(provider: CloudProvider, config: CloudinaryConfig | S3Config | GCSConfig): CloudAdapter;
export declare function uploadToCloud(stream: NodeJS.ReadableStream, metadata: any, cloudProvider: CloudProvider, cloudConfig: any, backup?: any): Promise<CloudResult>;
export declare function validateAllCloudConfigs(fields: Record<string, FieldConfig>): Promise<void>;