/**
 * Plan-to-features resolution.
 *
 * Features are defined in the canonical product catalog
 * (convex/config/productCatalog.ts). This module re-exports the type
 * and lookup function for backward compatibility.
 */
import { getEntitlementFeatures, PRODUCT_CATALOG, } from "../config/productCatalog";
/** Free tier defaults — used as fallback for unknown plan keys. */
export const FREE_FEATURES = PRODUCT_CATALOG.free.features;
/**
 * Returns the feature set for a given plan key.
 * Throws on unrecognized keys so misconfigured products fail loudly
 * instead of silently downgrading paid users to free tier.
 */
export function getFeaturesForPlan(planKey) {
    return getEntitlementFeatures(planKey);
}
