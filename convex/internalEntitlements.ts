/**
 * Internal mutation for upserting Pro entitlements.
 * Used by syncEntitlement action after Clerk API verification.
 */

import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { getFeaturesForPlan } from "./lib/entitlements";

export const upsertProEntitlement = internalMutation({
  args: {
    userId: v.string(),
    validUntil: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("entitlements")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();

    const features = getFeaturesForPlan("pro_monthly");

    if (existing) {
      // Only upgrade — never downgrade an existing entitlement
      if (existing.validUntil < args.validUntil || existing.planKey === "free") {
        await ctx.db.patch(existing._id, {
          planKey: "pro_monthly",
          features,
          validUntil: args.validUntil,
          updatedAt: args.updatedAt,
        });
      }
    } else {
      await ctx.db.insert("entitlements", {
        userId: args.userId,
        planKey: "pro_monthly",
        features,
        validUntil: args.validUntil,
        updatedAt: args.updatedAt,
      });
    }
  },
});
