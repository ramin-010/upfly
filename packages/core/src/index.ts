export { cssAdapter } from './adapters/css.js';
export { isExternalUrl, splitPathSuffix } from './adapters/reference-path.js';
export {
  DEFAULT_IGNORED_DIRECTORIES,
  IGNORE_FILE_NAME,
  discover,
} from './discover.js';
export type { DiscoverOptions } from './discover.js';
export { applyEdits, validateEdits } from './edits.js';
export { UpflyError } from './errors.js';
export type { UpflyErrorCode } from './errors.js';
export {
  IMAGE_EXTENSIONS,
  compareStrings,
  extensionOf,
  isImageExtension,
  relativePath,
  toPosix,
} from './paths.js';
export type {
  Adapter,
  Asset,
  Confidence,
  DiscoveryResult,
  Edit,
  RawReference,
  Reference,
  ReferenceKind,
  Resolution,
  SkipReason,
  SkippedEntry,
  SourceFile,
} from './types.js';
