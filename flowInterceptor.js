/**
 * flowInterceptor — WXT unlisted script (deminified from the production bundle)
 *
 * What it does: patches window.fetch to watch configured API endpoints and
 * report each matching response to the page via a "CFA_INTERCEPT" postMessage.
 * Configuration arrives via "CFA_CONFIG" messages from elsewhere in the app.
 *
 * Conversion notes:
 * - The logger is intentionally silenced in this build: every method calls an
 *   empty function and prints nothing. Do NOT wire it to the console — that
 *   would change behavior (side effects).
 * - The first try/catch in the startup sequence has an EMPTY try block in the
 *   original bundle (the WXT plugin hooks were stripped). Preserved as-is.
 * - `unusedFunction` is declared but never called in the original; kept for
 *   fidelity rather than removed.
 * - All message types, flags, property names, and the "UNKNOWN" fallback are
 *   external contracts and are preserved verbatim.
 */

(function () {
    "use strict";

    // ============================================================
    // SCRIPT DEFINITION NORMALIZATION
    // ============================================================

    /**
     * Normalizes a script definition: accepts either a bare function (the main
     * entry point) or an object that already has the expected shape.
     * (Inferred: matches WXT's `defineUnlistedScript` helper.)
     */
    function normalizeScriptDefinition(definition) {
        return definition == null || typeof definition === "function"
            ? { main: definition }
            : definition;
    }

    // ============================================================
    // THE FETCH INTERCEPTOR SCRIPT
    // ============================================================

    const scriptDefinition = normalizeScriptDefinition(() => {
        // Guard against double installation (script injected more than once).
        if (window.__cfa_interceptor) return;
        window.__cfa_interceptor = true;

        const originalFetch = window.fetch;

        // Configurable state, replaced wholesale via "CFA_CONFIG" messages:
        let watchPatterns = [];   // URL substrings that should be intercepted
        let skipPatterns = [];    // URL substrings that must never be intercepted
        let labelRules = [];      // [{ sub, method?, label }] used to classify events

        // ============================================================
        // CONFIGURATION LISTENER
        // ============================================================

        window.addEventListener("message", (event) => {
            if (event.source === window && event.data?.type === "CFA_CONFIG") {
                // Each list is REPLACED (not merged) when a valid array is provided.
                if (Array.isArray(event.data.watch)) {
                    watchPatterns = event.data.watch;
                }
                if (Array.isArray(event.data.skip)) {
                    skipPatterns = event.data.skip;
                }
                if (Array.isArray(event.data.labels)) {
                    labelRules = event.data.labels;
                }
            }
        });

        // ============================================================
        // LABEL MATCHING
        // ============================================================

        /**
         * Returns the label of the FIRST rule whose `sub` is contained in the URL
         * and whose optional `method` matches (exact, case-sensitive comparison
         * against the already-uppercased method). Falls back to "UNKNOWN".
         */
        function matchLabelRule(url, method) {
            for (const rule of labelRules) {
                if (url.includes(rule.sub) && (!rule.method || rule.method === method)) {
                    return rule.label;
                }
            }
            return "UNKNOWN";
        }

        // ============================================================
        // FETCH INTERCEPTOR
        // ============================================================

        window.fetch = async function (...args) {
            const input = args[0];
            const url = typeof input === "string" ? input : input?.url || "";

            // Skipped URLs pass straight through, untouched.
            if (skipPatterns.some((pattern) => url.includes(pattern))) {
                return originalFetch.apply(this, args);
            }

            // URLs not on the watch list pass straight through, untouched.
            if (!watchPatterns.some((pattern) => url.includes(pattern))) {
                return originalFetch.apply(this, args);
            }

            const method = (args[1]?.method || "GET").toUpperCase();
            const response = await originalFetch.apply(this, args);

            // Fire-and-forget: read a CLONE of the response and report it to the
            // page. The original response object is returned to the caller
            // immediately; any error while reading the clone is swallowed.
            response
                .clone()
                .text()
                .then((responseText) => {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(responseText);
                    } catch {
                        // Not JSON — report the raw text
                        parsed = responseText;
                    }

                    window.postMessage(
                        {
                            type: "CFA_INTERCEPT",
                            eventType: matchLabelRule(url, method),
                            status: response.status,
                            data: parsed,
                            timestamp: Date.now(),
                        },
                        "*"
                    );
                })
                .catch(() => { });

            return response;
        };
    });

    // ============================================================
    // DECLARED BUT UNUSED (kept for fidelity)
    // ============================================================

    // Declared but never referenced in the original bundle (kept for fidelity).
    function unusedFunction() { }

    // ============================================================
    // SILENCED LOGGER
    // ============================================================

    // Logger that is fully silenced in this build: every method discards its
    // arguments without printing anything.
    function noopLog() { }

    const logger = {
        debug: (...args) => noopLog(console.debug, ...args),
        log: (...args) => noopLog(console.log, ...args),
        warn: (...args) => noopLog(console.warn, ...args),
        error: (...args) => noopLog(console.error, ...args),
    };

    // ============================================================
    // STARTUP (WXT unlisted-script wrapper)
    // ============================================================

    return (() => {
        // The original try block is EMPTY in the bundle (plugin hooks were
        // stripped at build time); only the error path remains. Preserved as-is.
        try {
            // Plugin hooks were stripped at build time
        } catch (error) {
            logger.error('Failed to initialize plugins for "flowInterceptor"', error);
            throw error;
        }

        let result;
        try {
            result = scriptDefinition.main();

            if (result instanceof Promise) {
                result = result.catch((error) => {
                    logger.error('The unlisted script "flowInterceptor" crashed on startup!', error);
                    throw error;
                });
            }
        } catch (error) {
            logger.error('The unlisted script "flowInterceptor" crashed on startup!', error);
            throw error;
        }

        return result;
    })();
})();