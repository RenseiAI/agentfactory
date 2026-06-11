/**
 * @deprecated — re-export shim.
 *
 * The Postgres backend moved to `src/postgres/index.ts` when follow-up work landed
 * landed the real implementation. This file remains so existing imports
 * (`./postgres-impl.js`) keep resolving. New code should import directly
 * from the package entry point or `./postgres/index.js`.
 */

export {
  PostgresArchitecturalIntelligence,
  adapterFromPostgresJs,
  isJsonbParam,
} from './postgres/index.js'
export type {
  PostgresArchConfig,
  PostgresDbAdapter,
  JsonbParam,
  DbRow,
  PostgresJsSqlShape,
} from './postgres/index.js'
