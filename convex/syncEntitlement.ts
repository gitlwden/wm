/**
 * Sync Clerk user plan to Convex entitlement.
 *
 * Called by the frontend when a user signs in. Checks the Clerk Backend API
 * for the user's plan and creates/updates the Convex entitlement record.
 * This covers test accounts and manually-granted Pro roles that bypass
 * the Dodo checkout → webhook → Convex pipeline.
 */

import { action } from "./_generated/server";
import { internal } from "./_generated/api";

export const syncFromClerk = action({
  args: {},
  handler: async (ctx): Promise<{ synced: boolean; reason: string; planKey?: string; message?: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity?.subject) return { synced: false, reason: "unauthenticated" };

    const userId = identity.subject;

    // Check if entitlement already exists via internal query
    const existing: { planKey: string; validUntil: number } = await ctx.runQuery(
      internal.entitlements.getEntitlementsByUserId,
      { userId },
    );
    if (existing.planKey !== "free" && existing.validUntil > Date.now()) {
      return { synced: false, reason: "already_entitled" };
    }

    const clerkSecretKey = process.env.CLERK_SECRET_KEY;
    if (!clerkSecretKey) return { synced: false, reason: "no_clerk_key" };

    try {
      const resp = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
        headers: { Authorization: `Bearer ${clerkSecretKey}` },
      });
      if (!resp.ok) return { synced: false, reason: "clerk_api_error" };

      const user = (await resp.json()) as { public_metadata?: Record<string, unknown> };
      const plan = user.public_metadata?.plan;

      if (plan !== "pro") {
        return { synced: false, reason: "not_pro" };
      }

      const now = Date.now();
      await ctx.runMutation(internal.internalEntitlements.upsertProEntitlement, {
        userId,
        validUntil: now + 365 * 24 * 60 * 60 * 1000,
        updatedAt: now,
      });

      return { synced: true, reason: "ok", planKey: "pro_monthly" };
    } catch (err) {
      return { synced: false, reason: "error", message: (err as Error).message };
    }
  },
});
