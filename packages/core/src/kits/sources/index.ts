/**
 * Kit Registry Sources — barrel re-export
 *
 * Exports the Tessl and agentskills.io registry source adapters plus the
 * federated kit source loader.
 *
 * Architecture reference: donmai-architecture/005-kit-manifest-spec.md
 * §Registry sources
 */

export type {
  TesslApiTile,
  TesslApiSkill,
  TesslApiDoc,
  TesslApiMcpServer,
  TesslApiListResponse,
  TesslKitSourceOptions,
  KitSourceResult,
  FetchFn,
} from './tessl.js'

export {
  TESSL_API_BASE,
  tesslTileToKitManifest,
  TesslKitSource,
} from './tessl.js'

export type {
  AgentSkillsApiSkill,
  AgentSkillsApiListResponse,
  AgentSkillsKitSourceOptions,
} from './agentskills.js'

// KitSourceResult is the same shape in both modules; only export once
// (it's already exported via tessl.js above)

export {
  AGENTSKILLS_API_BASE,
  agentSkillToKitManifest,
  AgentSkillsKitSource,
} from './agentskills.js'

export type {
  FederatedKitSourceConfig,
  FederationOrder,
} from './federation.js'

export {
  DEFAULT_FEDERATION_ORDER,
  FederatedKitLoader,
} from './federation.js'
