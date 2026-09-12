export { audit } from './audit.js';
export type {
  AuditOptions,
  AuditResult,
  AuditThresholds,
  BrokenFinding,
  DeadFinding,
  Finding,
  FormatOpportunityFinding,
  OversizeDimension,
  OversizedFinding,
  PossiblyDeadFinding,
  ServingRootUnknownFinding,
} from './audit.js';
export { citeReferences, lineOf } from './citation.js';
export type { Citation, CitationOptions, CitationResult, UnreadableSource } from './citation.js';
export { cssAdapter, findCssReferences } from './adapters/css.js';
export { htmlAdapter } from './adapters/html.js';
export { findJavaScriptReferences, javascriptAdapter } from './adapters/javascript.js';
export { jsonAdapter } from './adapters/json.js';
export { astroAdapter } from './adapters/astro.js';
export { defaultAdapters } from './adapters/default-adapters.js';
export { defineAdapter, rewriteByEdits } from './adapters/define.js';
export type { AdapterDefinition } from './adapters/define.js';
export { markdownAdapter, maskInactiveRegions } from './adapters/markdown.js';
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
export { applyEdits, invertEdits, validateEdits } from './edits.js';
export {
  MANIFEST_PATH,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_VOLATILE_FIELDS,
  parseManifest,
  serialiseManifest,
  withoutVolatileFields,
} from './manifest.js';
export type {
  CreateOperation,
  Declined,
  DeleteOperation,
  EditOperation,
  Manifest,
  ManifestState,
  ManifestVolatileField,
  MoveOperation,
  Operation,
} from './manifest.js';
export { patternTargets, planOptimization } from './plan.js';
export { alwaysMeasureFor, newRunId, optimize } from './optimize.js';
export type { OptimizeInput, OptimizeResult } from './optimize.js';
export type {
  OptimizationPlan,
  PlanInput,
  PlanRefusal,
  PlannedConversion,
  PlannedRewrite,
  PublicPolicy,
  RootLinkPolicy,
} from './plan.js';
export { commit, inspect, prepare, readManifest, revert } from './transaction.js';
export type {
  FileStore,
  OperationState,
  OperationStatus,
  PlannedEdit,
  PlannedOperation,
  RunContext,
} from './transaction.js';
export { createNodeFileStore } from './file-store-node.js';
export { UpflyError } from './errors.js';
export { isLinked, linkedPaths } from './reference.js';
export { buildGraph, unreferencedAssets } from './graph.js';
export type { AssetNode, BuildGraphInput, Graph } from './graph.js';
export { createSharpProbe } from './probe-sharp.js';
export { DEFAULT_ENCODE_QUALITY, probeAssets } from './probe.js';
export type {
  AssetProbe,
  EncodeFormat,
  EncodedSize,
  ImageMetadata,
  ImageProbe,
  ProbeOptions,
  ProbeDiagnostic,
  ProbeSkip,
  ProbeSkipCode,
} from './probe.js';
export { renderReport } from './report-human.js';
export { REPORT_SCHEMA_VERSION, buildReport } from './report.js';
export type {
  Caveat,
  CoverageReport,
  ReferenceReport,
  Report,
  ReportInput,
  ReportSummary,
  SkipStage,
  SkippedItem,
  ReferenceEntry,
} from './report.js';
export { expandAlias, loadAliases } from './aliases.js';
export type { AliasMap, AliasRule, AliasSkip, LoadAliasesOptions } from './aliases.js';
export { CONVENTIONAL_SERVING_ROOTS, resolveReferences } from './resolve.js';
export { CONVENTIONAL_SERVING_ROOT_NAMES, detectServingRoots } from './serving-roots.js';
export {
  MINIMUM_ROOT_RELATIVE,
  RESOLUTION_FLOOR,
  type ResolutionHealth,
  resolutionHealth,
} from './resolution-health.js';
export type { ResolveOptions, ServingRoots } from './resolve.js';
export { scanSources } from './scan.js';
export type { ReadFilePort, ScanOptions, ScanResult } from './scan.js';
export { conventionLinkFor, detectConventionRoots } from './conventions.js';
export type { ConventionLink, ConventionRoot } from './conventions.js';
export { sweepForMentions } from './sweep.js';
export type { Mention, MentionSource, SweepOptions, SweepResult, SweepSkip } from './sweep.js';
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
