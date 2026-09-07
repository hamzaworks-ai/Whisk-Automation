(function () {
    "use strict";

    // ============================================================
    // UTILITY FUNCTIONS
    // ============================================================

    function passthrough(value) {
        return value;
    }

    // ============================================================
    // CONTENT SCRIPT CONFIGURATION
    // ============================================================

    const contentScriptConfig = {
        matches: ["https://flow.google.com/*"],
        runAt: "document_start",
        world: "ISOLATED",

        main() {
            // Inject the Flow interceptor script
            const script = document.createElement("script");
            script.src = chrome.runtime.getURL("flowInterceptor.js");
            script.onload = () => script.remove();
            (document.head || document.documentElement).appendChild(script);

            // Fetch and send configuration to the page
            function fetchConfig(retryCount = 0) {
                chrome.runtime.sendMessage({ action: "flowGetWatchConfig" })
                    .then(response => {
                        if (response?.watch) {
                            window.postMessage({
                                type: "CFA_CONFIG",
                                watch: response.watch,
                                skip: response.skip || [],
                                labels: response.labels || []
                            }, "*");
                        } else if (retryCount < 5) {
                            setTimeout(() => fetchConfig(retryCount + 1), 3000);
                        }
                    })
                    .catch(() => {
                        if (retryCount < 5) {
                            setTimeout(() => fetchConfig(retryCount + 1), 3000);
                        }
                    });
            }
            fetchConfig();

            // Listen for intercept events from the page
            window.addEventListener("message", (event) => {
                if (event.source === window && event.data?.type === "CFA_INTERCEPT") {
                    chrome.runtime.sendMessage({
                        type: "API_EVENT",
                        eventType: event.data.eventType,
                        status: event.data.status,
                        timestamp: event.data.timestamp
                    }).catch(() => { });
                }
            });

            // Handle auth state changes
            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                if (message.action === "authStateChanged") {
                    sendResponse({ success: true });
                }
                return false;
            });
        }
    };

    // ============================================================
    // LOGGING UTILITIES
    // ============================================================

    function logMessage(consoleMethod, ...args) {
        // Simple passthrough logger
    }

    const logger = {
        debug: (...args) => logMessage(console.debug, ...args),
        log: (...args) => logMessage(console.log, ...args),
        warn: (...args) => logMessage(console.warn, ...args),
        error: (...args) => logMessage(console.error, ...args)
    };

    // ============================================================
    // BROWSER API DETECTION
    // ============================================================

    const browserAPI = globalThis.browser?.runtime?.id
        ? globalThis.browser
        : globalThis.chrome;

    // ============================================================
    // CUSTOM EVENT: LOCATION CHANGE
    // ============================================================

    function createEventName(name) {
        return `${browserAPI?.runtime?.id}:flow:${name}`;
    }

    class LocationChangeEvent extends Event {
        static EVENT_NAME = createEventName("wxt:locationchange");

        constructor(newUrl, oldUrl) {
            super(LocationChangeEvent.EVENT_NAME, {});
            this.newUrl = newUrl;
            this.oldUrl = oldUrl;
        }
    }

    // ============================================================
    // NAVIGATION MONITOR
    // ============================================================

    const supportsNavigationAPI = typeof globalThis.navigation?.addEventListener === "function";

    function createLocationWatcher(abortSignal) {
        let isRunning = false;
        let currentUrl = null;

        return {
            run() {
                if (isRunning) return;
                isRunning = true;
                currentUrl = new URL(location.href);

                if (supportsNavigationAPI) {
                    // Use modern Navigation API
                    globalThis.navigation.addEventListener("navigate", (event) => {
                        const newUrl = new URL(event.destination.url);
                        if (newUrl.href !== currentUrl.href) {
                            window.dispatchEvent(new LocationChangeEvent(newUrl, currentUrl));
                            currentUrl = newUrl;
                        }
                    }, { signal: abortSignal });
                } else {
                    // Fallback: poll for URL changes
                    abortSignal.addEventListener("abort", () => {
                        clearInterval(pollingInterval);
                    });

                    const pollingInterval = setInterval(() => {
                        const newUrl = new URL(location.href);
                        if (newUrl.href !== currentUrl.href) {
                            window.dispatchEvent(new LocationChangeEvent(newUrl, currentUrl));
                            currentUrl = newUrl;
                        }
                    }, 1000);
                }
            }
        };
    }

    // ============================================================
    // CONTEXT CHECKER - Manages script lifecycle
    // ============================================================

    const SCRIPT_STARTED_MESSAGE_TYPE = createEventName("wxt:content-script-started");

    class ContentScriptContext {
        constructor(scriptName, options) {
            this.contentScriptName = scriptName;
            this.options = options;
            this.id = Math.random().toString(36).slice(2);
            this.abortController = new AbortController();
            this.locationWatcher = createLocationWatcher(this);

            this.stopOldScripts();
            this.listenForNewerScripts();
        }

        get signal() {
            return this.abortController.signal;
        }

        abort(reason) {
            this.abortController.abort(reason);
        }

        get isInvalid() {
            if (browserAPI.runtime?.id == null) {
                this.notifyInvalidated();
            }
            return this.signal.aborted;
        }

        get isValid() {
            return !this.isInvalid;
        }

        onInvalidated(callback) {
            this.signal.addEventListener("abort", callback);
            return () => this.signal.removeEventListener("abort", callback);
        }

        // Block indefinitely (used for content scripts that should never finish)
        block() {
            return new Promise(() => { });
        }

        // Wrapped setInterval that auto-clears on invalidation
        setInterval(callback, interval) {
            const timerId = setInterval(() => {
                if (this.isValid) callback();
            }, interval);
            this.onInvalidated(() => clearInterval(timerId));
            return timerId;
        }

        // Wrapped setTimeout that auto-clears on invalidation
        setTimeout(callback, delay) {
            const timerId = setTimeout(() => {
                if (this.isValid) callback();
            }, delay);
            this.onInvalidated(() => clearTimeout(timerId));
            return timerId;
        }

        // Wrapped requestAnimationFrame
        requestAnimationFrame(callback) {
            const frameId = requestAnimationFrame((...args) => {
                if (this.isValid) callback(...args);
            });
            this.onInvalidated(() => cancelAnimationFrame(frameId));
            return frameId;
        }

        // Wrapped requestIdleCallback
        requestIdleCallback(callback, options) {
            const idleId = requestIdleCallback((...args) => {
                if (!this.signal.aborted) callback(...args);
            }, options);
            this.onInvalidated(() => cancelIdleCallback(idleId));
            return idleId;
        }

        // Wrapped addEventListener that auto-removes on invalidation
        addEventListener(target, eventName, listener, options) {
            if (eventName === "wxt:locationchange" && this.isValid) {
                this.locationWatcher.run();
            }

            const actualEventName = eventName.startsWith("wxt:")
                ? createEventName(eventName)
                : eventName;

            target.addEventListener?.(actualEventName, listener, {
                ...options,
                signal: this.signal
            });
        }

        notifyInvalidated() {
            this.abort("Content script context invalidated");
            logger.debug(`Content script "${this.contentScriptName}" context invalidated`);
        }

        // Prevent multiple instances of the same script from running
        stopOldScripts() {
            document.dispatchEvent(new CustomEvent(SCRIPT_STARTED_MESSAGE_TYPE, {
                detail: {
                    contentScriptName: this.contentScriptName,
                    messageId: this.id
                }
            }));

            if (!this.options?.noScriptStartedPostMessage) {
                window.postMessage({
                    type: SCRIPT_STARTED_MESSAGE_TYPE,
                    contentScriptName: this.contentScriptName,
                    messageId: this.id
                }, "*");
            }
        }

        verifyScriptStartedEvent(event) {
            const isSameScript = event.detail?.contentScriptName === this.contentScriptName;
            const isDifferentInstance = event.detail?.messageId !== this.id;
            return isSameScript && isDifferentInstance;
        }

        listenForNewerScripts() {
            const handler = (event) => {
                if (!(event instanceof CustomEvent)) return;
                if (!this.verifyScriptStartedEvent(event)) return;
                this.notifyInvalidated();
            };

            document.addEventListener(SCRIPT_STARTED_MESSAGE_TYPE, handler);
            this.onInvalidated(() => {
                document.removeEventListener(SCRIPT_STARTED_MESSAGE_TYPE, handler);
            });
        }
    }

    // ============================================================
    // ERROR LOGGING
    // ============================================================

    function noop() { }

    function errorLogger(consoleMethod, ...args) {
        // Simple passthrough
    }

    const errorLoggerInstance = {
        debug: (...args) => errorLogger(console.debug, ...args),
        log: (...args) => errorLogger(console.log, ...args),
        warn: (...args) => errorLogger(console.warn, ...args),
        error: (...args) => errorLogger(console.error, ...args)
    };

    // ============================================================
    // BOOTSTRAP
    // ============================================================

    (async () => {
        try {
            const { main, ...config } = contentScriptConfig;
            await main(new ContentScriptContext("flow", config));
        } catch (error) {
            errorLoggerInstance.error('The content script "flow" crashed on startup!', error);
            throw error;
        }
    })();
})();