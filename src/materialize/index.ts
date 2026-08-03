/**
 * Public surface for controlled asset materialization.
 *
 * Downloading real bytes happens ONLY through these two functions, each behind an
 * explicit `network` + `media-upload` grant, SSRF checks, hard byte/type/time caps,
 * and required reusable-rights metadata that fails closed. The schemas define the
 * trust boundary. The shared byte internals stay private to this directory.
 */

export {
  APPROVED_MEDIA_MIME,
  MATERIALIZED_ASSET_FORMAT,
  materializedAssetSchema,
  parseMaterializedAsset,
  parseRights,
  rightsMetadataSchema,
  type MaterializedAssetValue,
  type ParseResult,
  type RightsMetadataValue,
} from "./schemas.js";
export { materializeWebAsset, type MaterializeWebInput } from "./web.js";
export { materializeDriveFile, type MaterializeDriveInput } from "./drive.js";
