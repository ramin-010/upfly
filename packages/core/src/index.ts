export { cssAdapter, findCssReferences } from './adapters/css.js';
export { htmlAdapter } from './adapters/html.js';
export { javascriptAdapter } from './adapters/javascript.js';
export { jsonAdapter } from './adapters/json.js';
export { markdownAdapter } from './adapters/markdown.js';
export {
  isExternalUrl,
  splitPathSuffix,
  templateExpressionReason,
} from './adapters/reference-path.js';
export {
  DEFAULT_IGNORED_DIRECTORIES,
  IGNORE_FILE_NAME,
  discover,
} from './discover.js';
export type { DiscoverOptions } from './discover.js';
export { applyEdits, validateEdits } from './edits.js';
export { UpflyError } from './errors.js';
export { isLinked, linkedPaths } from './reference.js';
export { buildGraph, unreferencedAssets } from './graph.js';
export type { AssetNode, BuildGraphInput, Graph } from './graph.js';
export { resolveReferences } from './resolve.js';
export type { ResolveOptions } from './resolve.js';
export { scanSources } from './scan.js';
export type { ReadFilePort, ScanOptions, ScanResult } from './scan.js';
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
  // Reachable through `DiscoveryResult` and `ResolveOptions`, so it is API whether
  // or not it is named here. It was not, which meant a consumer could hold one and
  // not be able to write down its type.
  ExcludedRoot,
  RawReference,
  Reference,
  ReferenceKind,
  Resolution,
  SkipReason,
  SkippedEntry,
  SourceFile,
  UnscannedExtension,
  UnscannedFile,
  UnscannedReason,
} from './types.js';
