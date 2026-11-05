/**
 * Live settings layer.
 *
 * The row config in the profile patch is the deployment default; the Settings page owns a
 * `privacy-gate` namespace that layers user values on top of it. Everything here is pure so the
 * mapping can be tested without a host: `index.js` wires the namespace to the settings service and
 * calls `applyLiveSettings` when a value commits.
 */

/** Settings namespace the GUI binds to; kebab-case, like the row id. */
export const SETTINGS_NAMESPACE = 'privacy-gate'

/**
 * Project a resolved config onto the live schema shown in the Settings page.
 * @param {object} resolved
 */
export function liveFromConfig(resolved) {
  return {
    scope: resolved.scope,
    allowPaths: [...resolved.allowPaths],
    extractCli: resolved.extractCli,
    detectors: [...resolved.detectors],
    personWords: [...resolved.personWords],
    blockNonTextResults: resolved.blockNonTextResults,
    auditEnabled: resolved.audit.enabled,
    auditPath: resolved.audit.path,
    egressAllowProviders: [...resolved.egressAllowProviders],
    egressAllowModels: [...resolved.egressAllowModels],
    allowAgentDisable: resolved.allowAgentDisable,
    ocrEngine: resolved.ocrEngine,
    visionProvider: resolved.visionProvider,
    visionModel: resolved.visionModel,
  }
}

/**
 * Merge a live value over the row layer, producing a row-shaped object for `resolveConfig`.
 * Keys the live schema does not own (`sessionsPath`, `artifactDir`, timings, budgets) are left
 * to the row layer.
 * @param {object} rowConfig
 * @param {object} live
 */
export function buildLiveRowConfig(rowConfig, live) {
  return {
    ...rowConfig,
    scope: live.scope,
    allowPaths: live.allowPaths,
    extractCli: live.extractCli,
    detectors: live.detectors,
    personWords: live.personWords,
    blockNonTextResults: live.blockNonTextResults,
    audit: { enabled: live.auditEnabled, path: live.auditPath },
    egressAllowProviders: live.egressAllowProviders,
    egressAllowModels: live.egressAllowModels,
    allowAgentDisable: live.allowAgentDisable,
    ocrEngine: live.ocrEngine,
    visionProvider: live.visionProvider,
    visionModel: live.visionModel,
  }
}
