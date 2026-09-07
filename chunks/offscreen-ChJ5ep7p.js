
// NOTE: The original file imported these from a shared module
// ("./firebase-e0Hl5ZZG.js"). Names below are inferred from usage.
// If you have the source, replace with the real exports, e.g.:
//   import { doc, getDoc, runTransaction } from "firebase/firestore";
import {
    E as DEFAULT_PLAN_ID,     // subscription key, e.g. "pro"
    d as doc,                 // firestore/doc
    a as db,                  // Firestore instance
    g as getDoc,              // firestore/getDoc
    r as runTransaction,      // firestore/runTransaction
    D as FREE_DAILY_QUOTA,    // daily quota for free users
    F as TRIAL_QUOTA          // total quota for trial users
} from "./firebase-e0Hl5ZZG.js";

import "./_virtual_wxt-plugins-CDnz5Vh6.js";

// ============================================================
// 1. UTC date helpers (cached, with remote time API fallback)
// ============================================================

let cachedDateString = null;
let cachedAtTimestamp = 0;

const DATE_CACHE_TTL_MS = 300 * 1000; // 5 minutes

/** Today's date as "YYYY-MM-DD" using the browser's clock (UTC). */
function getLocalUTCDate() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const day = String(now.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

/** fetch() that aborts after `timeoutMs` (default 3 seconds). */
async function fetchWithTimeout(url, timeoutMs = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, { signal: controller.signal });
        return response;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Returns today's date ("YYYY-MM-DD") in UTC.
 * 1. Returns cached value if less than 5 min old.
 * 2. Tries timeapi.io (protects against users faking their system clock).
 * 3. Falls back to the browser's UTC clock.
 */
async function getCurrentUTCDate() {
    const now = Date.now();

    if (cachedDateString && now - cachedAtTimestamp < DATE_CACHE_TTL_MS) {
        return cachedDateString;
    }

    try {
        const response = await fetchWithTimeout(
            "https://timeapi.io/api/time/current/zone?timeZone=UTC"
        );
        if (response.ok) {
            const data = await response.json();
            const date = data.dateTime?.slice(0, 10); // "YYYY-MM-DD..."
            if (date) {
                cachedDateString = date;
                cachedAtTimestamp = now;
                return date;
            }
        }
    } catch {
        // ignore — fall back to local clock
    }

    const fallbackDate = getLocalUTCDate();
    cachedDateString = fallbackDate;
    cachedAtTimestamp = now;
    return fallbackDate;
}

// ============================================================
// 2. Quota consumption (atomic Firestore transaction)
// ============================================================

/**
 * Atomically consumes `newlyProcessed` quota units for a user.
 *
 * Handles every subscription status:
 *   - active / active_canceling (not expired) → pro, unlimited
 *   - active_canceling (endDate passed)       → downgrade to free tier
 *   - trial expired                           → downgrade to free tier
 *   - trial active                            → consume trial quota
 *   - free_tier                               → daily quota (resets each UTC day)
 *   - expired                                 → downgrade to free tier
 *
 * Returns a plain object describing quota state, or null on failure.
 */
async function consumeQuota(userId, newlyProcessed, planId = DEFAULT_PLAN_ID) {
    if (!userId || newlyProcessed <= 0) return null;

    try {
        return await runTransaction(db, async (transaction) => {
            const userRef = doc(db, "users", userId);
            const userSnap = await transaction.get(userRef);

            if (!userSnap.exists()) return null;

            const subscription = userSnap.data()?.subscriptions?.[planId];
            if (!subscription) return null;

            // ------------------------------------------------------
            // CASE 1: "active_canceling" whose end date has passed
            // ------------------------------------------------------
            if (
                subscription.status === "active_canceling" &&
                subscription.endDate &&
                new Date() > subscription.endDate.toDate()
            ) {
                const today = await getCurrentUTCDate();

                transaction.update(userRef, {
                    [`subscriptions.${planId}.status`]: "free_tier",
                    [`subscriptions.${planId}.dailyQuota`]: FREE_DAILY_QUOTA,
                    [`subscriptions.${planId}.dailyUsed`]: 0,
                    [`subscriptions.${planId}.lastResetDate`]: today,
                });

                return {
                    status: "free_tier",
                    plan: "free_tier",
                    dailyQuota: FREE_DAILY_QUOTA,
                    dailyUsed: 0,
                    dailyRemaining: FREE_DAILY_QUOTA,
                    lastResetDate: today,
                    _xq7: false, // isPro
                };
            }

            // ------------------------------------------------------
            // CASE 2: Active paid subscription (or canceling but
            //         still within the paid period) → pro
            // ------------------------------------------------------
            if (subscription.status === "active" || subscription.status === "active_canceling") {
                return {
                    ...subscription,
                    _xq7: true, // isPro
                };
            }

            // ------------------------------------------------------
            // CASE 3: Trial
            // ------------------------------------------------------
            if (subscription.status === "trial") {
                // 3a. Trial has expired → downgrade to free tier
                const trialExpired = subscription.trialEnd
                    ? new Date() > new Date(subscription.trialEnd.toDate())
                    : false;

                if (trialExpired) {
                    const today = await getCurrentUTCDate();

                    transaction.update(userRef, {
                        [`subscriptions.${planId}.status`]: "free_tier",
                        [`subscriptions.${planId}.dailyQuota`]: FREE_DAILY_QUOTA,
                        [`subscriptions.${planId}.dailyUsed`]: newlyProcessed,
                        [`subscriptions.${planId}.lastResetDate`]: today,
                    });

                    return {
                        status: "free_tier",
                        plan: "free_tier",
                        dailyQuota: FREE_DAILY_QUOTA,
                        dailyUsed: newlyProcessed,
                        dailyRemaining: Math.max(0, FREE_DAILY_QUOTA - newlyProcessed),
                        lastResetDate: today,
                        _xq7: false,
                    };
                }

                // 3b. Trial still running → consume from the trial pool
                const used = subscription.used || 0;
                const quota = subscription.quota || TRIAL_QUOTA;
                const newUsed = used + newlyProcessed;
                const newRemaining = Math.max(0, quota - newUsed);
                const newStatus = newRemaining <= 0 ? "free_tier" : "trial";

                const updates = {
                    [`subscriptions.${planId}.used`]: newUsed,
                    [`subscriptions.${planId}.remaining`]: newRemaining,
                    [`subscriptions.${planId}.status`]: newStatus,
                };

                // Trial exhausted → also initialize free-tier fields
                if (newStatus === "free_tier") {
                    const today = await getCurrentUTCDate();
                    updates[`subscriptions.${planId}.dailyQuota`] = FREE_DAILY_QUOTA;
                    updates[`subscriptions.${planId}.dailyUsed`] = 0;
                    updates[`subscriptions.${planId}.lastResetDate`] = today;

                    transaction.update(userRef, updates);

                    return {
                        status: "free_tier",
                        plan: "free_tier",
                        dailyQuota: FREE_DAILY_QUOTA,
                        dailyUsed: 0,
                        dailyRemaining: FREE_DAILY_QUOTA,
                        lastResetDate: today,
                        _xq7: false,
                    };
                }

                transaction.update(userRef, updates);

                return {
                    status: "trial",
                    plan: "trial",
                    quota: quota,
                    used: newUsed,
                    remaining: newRemaining,
                    trialEnd: subscription.trialEnd ? subscription.trialEnd.toDate() : null,
                    _xq7: false,
                };
            }

            // ------------------------------------------------------
            // CASE 4: Free tier → daily quota, resets each UTC day
            // ------------------------------------------------------
            if (subscription.status === "free_tier") {
                const today = await getCurrentUTCDate();
                const lastResetDate = subscription.lastResetDate || today;
                const dailyQuota = subscription.dailyQuota || FREE_DAILY_QUOTA;

                // If the last reset was on a previous day, start from 0
                const usedToday =
                    (lastResetDate !== today ? 0 : subscription.dailyUsed || 0) + newlyProcessed;
                const dailyRemaining = Math.max(0, dailyQuota - usedToday);

                transaction.update(userRef, {
                    [`subscriptions.${planId}.dailyUsed`]: usedToday,
                    [`subscriptions.${planId}.lastResetDate`]: today,
                });

                return {
                    status: "free_tier",
                    plan: "free_tier",
                    dailyQuota: dailyQuota,
                    dailyUsed: usedToday,
                    dailyRemaining: dailyRemaining,
                    lastResetDate: today,
                    _xq7: false,
                };
            }

            // ------------------------------------------------------
            // CASE 5: Expired subscription → downgrade to free tier
            // ------------------------------------------------------
            if (subscription.status === "expired") {
                const today = await getCurrentUTCDate();
                const dailyUsed = newlyProcessed;
                const dailyRemaining = Math.max(0, FREE_DAILY_QUOTA - newlyProcessed);

                transaction.update(userRef, {
                    [`subscriptions.${planId}.status`]: "free_tier",
                    [`subscriptions.${planId}.dailyQuota`]: FREE_DAILY_QUOTA,
                    [`subscriptions.${planId}.dailyUsed`]: dailyUsed,
                    [`subscriptions.${planId}.lastResetDate`]: today,
                });

                return {
                    status: "free_tier",
                    plan: "free_tier",
                    dailyQuota: FREE_DAILY_QUOTA,
                    dailyUsed: dailyUsed,
                    dailyRemaining: dailyRemaining,
                    lastResetDate: today,
                    _xq7: false,
                };
            }

            // Unknown status
            return null;
        });
    } catch {
        return null;
    }
}

// ============================================================
// 3. Pro-status check (single read, no quota consumed)
// ============================================================

/**
 * Returns true if the user currently has a paid subscription:
 *   - "active"           → true
 *   - "active_canceling" → true until endDate has passed
 *   - anything else      → false
 */
async function isProSubscriber(userId, planId = DEFAULT_PLAN_ID) {
    if (!userId) return false;

    try {
        const userRef = doc(db, "users", userId);
        const userSnap = await getDoc(userRef);

        if (!userSnap.exists()) return false;

        const subscription = userSnap.data()?.subscriptions?.[planId];

        if (subscription?.status === "active") return true;

        if (subscription?.status === "active_canceling") {
            // Still pro until the end date actually passes
            return !(subscription.endDate && new Date() > subscription.endDate.toDate());
        }

        return false;
    } catch {
        return false;
    }
}

// ============================================================
// 4. Message listener (talks to the rest of the extension)
// ============================================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // ----------------------------------------------------------
    // "updateQuota" — consume quota for the items just processed
    // ----------------------------------------------------------
    if (message.action === "updateQuota") {
        const { userId, newlyProcessed } = message;

        isProSubscriber(userId)
            .then((isPro) => {
                // Paid users don't consume quota at all
                if (isPro) {
                    sendResponse({
                        success: true,
                        _xq7: true, // isPro
                        quotaData: { _xk1: true, _xq7: true, status: "active" },
                    });
                    return;
                }

                // Free / trial users → consume quota in Firestore
                return consumeQuota(userId, newlyProcessed).then((quotaData) => {
                    sendResponse({
                        success: true,
                        quotaData: quotaData,
                        _xq7: false,
                    });

                    // Cache the latest quota state locally so other parts of
                    // the extension can read it without hitting Firestore
                    if (quotaData) {
                        const isFreeTier = quotaData.status === "free_tier";

                        const quotaStatus = {
                            _xk1: isFreeTier
                                ? quotaData.dailyRemaining > 0
                                : quotaData.status !== "expired" && (quotaData.remaining || 0) > 0,
                            _xq7: false,
                            remaining: isFreeTier ? quotaData.dailyRemaining : quotaData.remaining,
                            status: quotaData.status,
                            lastUpdated: Date.now(),
                        };

                        if (isFreeTier) {
                            quotaStatus.dailyQuota = quotaData.dailyQuota;
                            quotaStatus.dailyUsed = quotaData.dailyUsed;
                            quotaStatus.dailyRemaining = quotaData.dailyRemaining;
                            quotaStatus.lastResetDate = quotaData.lastResetDate;
                        }

                        chrome.storage.local.set({ quotaStatus });
                    }
                });
            })
            .catch((error) => {
                sendResponse({ success: false, error: error.message });
            });

        return true; // keep the message channel open for the async response
    }

    // ----------------------------------------------------------
    // "setUserId" — acknowledged, userId handled elsewhere
    // ----------------------------------------------------------
    if (message.action === "setUserId") {
        // note: message.userId is read but not used in this file
        sendResponse({ success: true });
        return true;
    }
});