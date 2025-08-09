import { RequestHandler } from "express";
import { PathLike } from "fs";

export interface FieldConfig {
  format?: "webp" | "jpeg" | "png" | "avif";
  quality?: number;
  output?: "memory" | "disk";
}

export interface UploadAndWebifyOptions {
  fields: Record<string, FieldConfig>;
  outputDir?: PathLike;
  limit?: number;
}

export interface WebifyOptions {
  fields: Record<string, FieldConfig>;
}

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

export interface WebifiedRequest extends Express.Request {
  file?: WebifiedFile;
  files?: Record<string, WebifiedFile[]> | WebifiedFile[];
}


// Upfly primary API names (aliases)
export declare function upflyUpload(
  options?: UploadAndWebifyOptions
): RequestHandler;

export declare function upflyConvert(
  options?: WebifyOptions
): RequestHandler;
