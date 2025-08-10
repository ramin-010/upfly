import { RequestHandler } from "express";

/**
 * Single-field conversion configuration.
 *
 * Defaults when omitted:
 * - format: 'webp'
 * - quality: 80
 * - output: 'memory' (for upflyUpload)
 */
export interface FieldConfig {
  format?: "webp" | "jpeg" | "png" | "avif";
  quality?: number;
  output?: "memory" | "disk";
}

/**
 * Options for the primary upload+convert middleware.
 *
 * Behavior:
 * - Unknown file fields are silently ignored (not buffered)
 * - Non-image files are passed through (memory) or saved as-is (disk)
 * - On conversion failure, originals are passed through/saved unchanged
 * - When any field uses output: 'disk', files are written under a safe, normalized `outputDir`
 */
export interface UploadAndWebifyOptions {
  /**
   * Per-field conversion config. Values can be empty objects to use defaults
   * (format: 'webp', quality: 80, output: 'memory').
   */
  fields: Record<string, FieldConfig>;
  /**
   * Base directory used when any field has `output: 'disk'`.
   * Paths like '/uploads' resolve safely under your project root.
   * Default: './uploads'
   */
  outputDir?: string;
  /**
   * File size limit (bytes) for in-memory uploads. Default: 5 * 1024 * 1024 (5 MB)
   */
  limit?: number;
}

/**
 * Options for conversion-only middleware (you provide your own upload setup).
 */
export interface WebifyOptions {
  fields: Record<string, FieldConfig>;
}

/**
 * The file object shape returned by Upfly.
 * - When output: 'memory', `buffer` is present (converted image)
 * - When output: 'disk', `path` and `filename` are present
 */
export interface WebifiedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size?: number;
  buffer?: Buffer;
  path?: string;
  filename?: string;
}

/**
 * Express.Request extended with Upfly file properties.
 */
export interface WebifiedRequest extends Express.Request {
  file?: WebifiedFile;
  files?: Record<string, WebifiedFile[]> | WebifiedFile[];
}


// Upfly primary API names (aliases)
/**
 * upflyUpload — Upload and convert images in one step.
 *
 * - Accepts and converts images to the specified format/quality per field
 * - Stores results in memory or saves to disk
 * - Unknown fields are ignored without errors
 * - Safe path handling for `outputDir` (project-root relative by default)
 */
export declare function upflyUpload(
  options?: UploadAndWebifyOptions
): RequestHandler;

/**
 * upflyConvert — Conversion-only middleware.
 *
 * Use when you already manage your own upload (e.g., single/array/fields).
 * Applies per-field conversion in-place and returns converted buffers.
 */
export declare function upflyConvert(
  options?: WebifyOptions
): RequestHandler;
