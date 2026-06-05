/**
 * Dev-only mutation to set a user's entitlement for testing.
 * Run: npx convex run devSetEntitlement:setProEntitlement '{"userId":"user_3EfuXeQAtkXeLgDswnrxunbCQlJ"}'
 */
import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { getFeaturesForPlan } from "./lib/entitlements";
export const setProEntitlement = mutation({
    args: {
        userId: v.string(),
        planKey: v.optional(v.string()),
    },
    handler: async (ctx, args) => {
        const planKey = args.planKey ?? "pro_monthly";
        const features = getFeaturesForPlan(planKey);
        const now = Date.now();
        const oneYear = 365 * 24 * 60 * 60 * 1000;
        const existing = await ctx.db
            .query("entitlements")
            .withIndex("by_userId", (q) => q.eq("userId", args.userId))
            .first();
        if (existing) {
            await ctx.db.patch(existing._id, {
                planKey,
                features,
                validUntil: now + oneYear,
                updatedAt: now,
            });
            return { action: "updated", id: existing._id };
        }
        const id = await ctx.db.insert("entitlements", {
            userId: args.userId,
            planKey,
            features,
            validUntil: now + oneYear,
            updatedAt: now,
        });
        return { action: "inserted", id };
    },
});
