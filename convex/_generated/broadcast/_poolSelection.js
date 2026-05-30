/**
 * Per-page eligibility filter for `pickWaveAction`.
 *
 * Pure (no side effects, no Convex APIs) so it's unit-testable without
 * mocking Resend / scheduler / Convex action runtime. Wired into
 * pickWaveAction's existing pagination loop, BEFORE `reservoir.offer()`.
 *
 * Filter-before-reservoir is load-bearing: filtering after sampling
 * silently underfills (sample 1000, exclude 200, send 800 even though
 * thousands of eligible English contacts exist elsewhere in the pool).
 *
 * For each registration row, applies ordered filters:
 *   1. empty / missing email                             → skip
 *   2. suppressed (bounce / complaint history)           → skip
 *   3. paid customer                                     → skip (don't email "buy PRO!" to a PRO)
 *   4. already-stamped with a previous wave              → skip
 *   ─── pageEligibleCount counts everything that survives the above ───
 *   5. excludeNonEnglish AND row's locale is non-English → skip (locale-excluded)
 *   ─── eligible[] is what survives ALL of the above ───
 */
import { inferLocaleFromEmail } from "./_localeHeuristic";
export function filterPageForEligibility(args) {
    const eligible = [];
    let pageEligibleCount = 0;
    const pageExcludedByLocale = {};
    let pageExcludedTotal = 0;
    for (const row of args.page) {
        const email = row.normalizedEmail;
        if (!email || email.length === 0)
            continue;
        if (args.suppressedSet.has(email))
            continue;
        if (args.paidSet.has(email))
            continue;
        if (row.proLaunchWave)
            continue;
        pageEligibleCount++;
        if (!args.excludeNonEnglish) {
            eligible.push(email);
            continue;
        }
        // users-table data is authoritative when present (the user actively
        // signed in post-launch and ensureRecord captured their browser locale).
        // Otherwise fall back to email-TLD heuristic for legacy registrations.
        const userInfo = args.usersByEmail.get(email);
        const localePrimary = (userInfo?.localePrimary ?? null) || inferLocaleFromEmail(email);
        if (localePrimary && localePrimary !== "en") {
            pageExcludedByLocale[localePrimary] =
                (pageExcludedByLocale[localePrimary] ?? 0) + 1;
            pageExcludedTotal++;
            continue;
        }
        eligible.push(email);
    }
    return { eligible, pageEligibleCount, pageExcludedByLocale, pageExcludedTotal };
}
