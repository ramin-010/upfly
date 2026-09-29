export { audit } from './audit/audit.js';
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
  SuppressedBroken,
} from './audit/audit.js';
export { citeReferences, lineOf } from './scan/citation.js';
export type {
  Citation,
  CitationOptions,
  CitationResult,
  UnreadableSource,
} from './scan/citation.js';
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
  spell,
  spellingsOf,
  splitPathSuffix,
  templateExpressionReason,
} from './adapters/reference-path.js';
export type { PathSpelling } from './adapters/reference-path.js';
export {
  DEFAULT_IGNORED_DIRECTORIES,
  IGNORE_FILE_NAME,
  discover,
} from './discover/discover.js';
export type { DiscoverOptions } from './discover/discover.js';
export { applyEdits, invertEdits, validateEdits } from './write/edits.js';
export {
  MANIFEST_PATH,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_VOLATILE_FIELDS,
  UPFLY_DIRECTORY,
  parseManifest,
  pathsTouched,
  serialiseManifest,
  withoutVolatileFields,
} from './write/manifest.js';
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
} from './write/manifest.js';
export { SHAPES, SHAPE_IDS, UNTESTED_SHAPE_IDS, shapeById } from './adapters/shapes.js';
export type { ShapeDeclaration, ShapeEmission } from './adapters/shapes.js';
export { findDuplicates, hashCandidates } from './audit/duplicates.js';
export type { DuplicateSet } from './audit/duplicates.js';
export {
  isUnderPublicDir,
  patternTargets,
  planOptimization,
  whyReferenceStays,
} from './plan/plan.js';
export { moveOperationsFor, planRelocation, planRepoint } from './plan/relocate.js';
export type {
  Move,
  RefusalCode,
  RefusedMove,
  RelocateInput,
  RelocationPlan,
  Repoint,
  RepointInput,
  RepointOutcome,
  RepointPlan,
  RewriteContext,
} from './plan/relocate.js';

// A move's regression count and the limit of that count, as one value, so the count
// never reaches a user without its limit.
export { checkMoveRegression } from './plan/move-check.js';
export type { MoveCheckInput, MoveCoverageLimit, MoveRegressionReport } from './plan/move-check.js';

// The independent check on a move: it searches text for the old path and never reads a
// graph, so it cannot share the graph's blind spots.
export { findSurvivingPaths, spellingsFor } from './plan/old-path-search.js';
export type {
  OldPathSearchInput,
  OldPathSearchResult,
  Survivor,
  Unsearchable,
} from './plan/old-path-search.js';
export { alwaysMeasureFor, newRunId, optimize, writeRewrites } from './write/optimize.js';
export type {
  OptimizeInput,
  OptimizeProgress,
  OptimizeResult,
  WriteRewritesInput,
} from './write/optimize.js';
export { optimizeProject } from './optimize-project.js';
export { dedupeProject } from './dedupe-project.js';
export type {
  DedupeCopy,
  DedupePlan,
  DedupeProjectInput,
  DedupeProjectResult,
  DedupeSet,
  KeptBecause,
  StayingReference,
} from './dedupe-project.js';
export type {
  OnlyImages,
  OptimizeProjectInput,
  OptimizeProjectResult,
} from './optimize-project.js';
export type {
  LinkedReference,
  OptimizationPlan,
  PlanInput,
  PlanRefusal,
  PlannedConversion,
  PlannedRewrite,
  PublicPolicy,
  RootLinkPolicy,
} from './plan/plan.js';
export { commit, inspect, prepare, readManifest, revert } from './write/transaction.js';
export type {
  FileStore,
  LockPorts,
  OperationState,
  OperationStatus,
  PlannedEdit,
  PlannedOperation,
  RunContext,
} from './write/transaction.js';
// `LOCK_PATH` so a host can say which file to delete if it ever has to, and
// `processIsAlive` so a caller supplying its own liveness check can fall back to the real
// one rather than reimplementing it slightly differently.
export { LOCK_PATH, processIsAlive, readLockHolder } from './write/lock.js';
export type { LockHandle, LockHolder, ProcessLiveness } from './write/lock.js';
export { createNodeFileStore } from './write/file-store-node.js';
export { UpflyError } from './errors.js';
export { isLinked, linkedPaths } from './resolve/reference.js';
export { buildGraph, unreferencedAssets } from './graph/graph.js';
export type { AssetNode, BuildGraphInput, Graph } from './graph/graph.js';
export { createSharpProbe } from './probe/probe-sharp.js';
export { DEFAULT_ENCODE_QUALITY, probeAssets } from './probe/probe.js';
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
} from './probe/probe.js';
export { formatBytes } from './format.js';
export { renderReport } from './report/report-human.js';
export { REPORT_SCHEMA_VERSION, buildReport } from './report/report.js';
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
} from './report/report.js';
export { expandAlias, loadAliases } from './resolve/aliases.js';
export type {
  AliasMap,
  AliasRule,
  AliasSkip,
  ExpandOptions,
  LoadAliasesOptions,
} from './resolve/aliases.js';
export { CONVENTIONAL_SERVING_ROOTS, resolveReferences } from './resolve/resolve.js';
export {
  type InferServingRootsInput,
  type InferredServingRoots,
  MIN_ROOT_REFERENCES,
  MIN_ROOT_RESOLUTION_RATE,
  type RootCandidateScore,
  inferServingRoots,
} from './resolve/infer-serving-roots.js';
export {
  CONVENTIONAL_SERVING_ROOT_NAMES,
  PROJECT_MARKERS,
  detectServingRoots,
} from './resolve/serving-roots.js';
export type { WalkedTree } from './resolve/serving-roots.js';
export {
  decideServingRoots,
  isRootRelative,
  looksLikeAsset,
} from './resolve/serving-root-decision.js';
export type {
  ServingRootDecision,
  ServingRootDecisionInput,
} from './resolve/serving-root-decision.js';
export { runPipeline, servingRootsFor } from './pipeline.js';
export type { PipelineInput, PipelineOutput, PipelineProgress } from './pipeline.js';
export {
  MINIMUM_ROOT_RELATIVE,
  RESOLUTION_FLOOR,
  type ResolutionHealth,
  resolutionHealth,
} from './audit/resolution-health.js';
export type { ResolveOptions, ServingRoots } from './resolve/resolve.js';
export { scanSources } from './scan/scan.js';
export type {
  ReadFilePort,
  ScanDiagnostic,
  ScanOptions,
  ScanResult,
  ScannedText,
} from './scan/scan.js';
export { conventionLinkFor, detectConventionRoots } from './audit/conventions.js';
export type { ConventionLink, ConventionRoot } from './audit/conventions.js';
export { sweepForMentions } from './audit/sweep.js';
export type {
  Mention,
  MentionSource,
  SweepOptions,
  SweepResult,
  SweepSkip,
} from './audit/sweep.js';
export type { UpflyErrorCode } from './errors.js';
export {
  IMAGE_EXTENSIONS,
  compareStrings,
  extensionOf,
  imageFilenameCandidates,
  isImageExtension,
  relativePath,
  toPosix,
} from './paths.js';
export type {
  Adapter,
  Asset,
  BundlerContext,
  BundlerGlob,
  Confidence,
  DiscoveryResult,
  Edit,
  // Reachable through `DiscoveryResult` and `ResolveOptions`, so it is API whether or
  // not it is named here. Naming it lets a consumer write down its type.
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
