// Base plugin — the SDK base class 3rd parties and 1st-party plugins extend.
export { BasePlugin } from './base-plugin';
export type { BasePluginConfig } from './base-plugin';

// Baseline risk — abstract base for rarely-changing, cell-quantized historical
// sources (percentile-scored summaries). A second authoring base alongside
// BasePlugin; concrete implementations live in the consuming repo.
export {
  BaselineRiskPlugin,
  scoreCells,
  percentileToRisk,
} from './baseline';
export type {
  BaselineRiskPluginConfig,
  CellStat,
  CellSeverity,
  ScoredCell,
  BaselineSummaryMetadata,
  RiskSurfaceCell,
} from './baseline';
