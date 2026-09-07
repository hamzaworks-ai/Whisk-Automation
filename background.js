// ============================================================
// WHISK AUTOMATOR - BACKGROUND SCRIPT
// Chrome Extension Background Service Worker
// ============================================================

import { i as initializeWXTPlugins } from "./chunks/_virtual_wxt-plugins-CDnz5Vh6.js";

// ============================================================
// SCRIPT DEFINITION NORMALIZATION
// ============================================================

function normalizeScriptDefinition(definition) {
  return definition == null || typeof definition === "function"
    ? { main: definition }
    : definition;
}

// ============================================================
// FLOW API CONFIGURATION
// ============================================================

let cachedApiConfig = null;

function isValidApiConfig(config) {
  if (!config || typeof config !== "object") return false;

  // Required RPC endpoints
  const requiredRpcEndpoints = [
    "generate",
    "upload",
    "upscale",
    "mediaDetail",
    "listProjects",
    "createProject",
    "credits"
  ];

  if (!config.rpc || requiredRpcEndpoints.some(key => typeof config.rpc[key] !== "string" || !config.rpc[key])) {
    return false;
  }

  // Required WIZ keys
  const requiredWizKeys = ["at", "fsid", "bl", "base"];
  if (!config.wizKeys || requiredWizKeys.some(key => typeof config.wizKeys[key] !== "string" || !config.wizKeys[key])) {
    return false;
  }

  // Required fields
  if (typeof config.rpcPath !== "string" || !config.rpcPath) return false;
  if (typeof config.origin !== "string" || !config.origin) return false;
  if (typeof config.toolEnum !== "number") return false;
  if (!config.aspect || typeof config.aspect !== "object") return false;
  if (typeof config.recaptchaSiteKey !== "string" || !config.recaptchaSiteKey) return false;

  return true;
}

function setApiConfig(config) {
  cachedApiConfig = isValidApiConfig(config) ? config : null;
  return !!cachedApiConfig;
}

function hasApiConfig() {
  return !!cachedApiConfig;
}

function getRequiredConfig() {
  if (!cachedApiConfig) {
    const error = new Error("Preparing secure connection — try again in a few seconds.");
    error.code = "no_api_config";
    throw error;
  }
  return cachedApiConfig;
}

// ============================================================
// API CONFIGURATION GETTERS
// ============================================================

function getRpcConfig() {
  return getRequiredConfig().rpc;
}

function getToolEnum() {
  return getRequiredConfig().toolEnum;
}

function getUpscaleResolution() {
  return getRequiredConfig().upscale2k ?? 1;
}

function getRecaptchaSiteKey() {
  return getRequiredConfig().recaptchaSiteKey;
}

function getWizKeys() {
  return getRequiredConfig().wizKeys;
}

function getRpcPath() {
  return getRequiredConfig().rpcPath;
}

function getAspectRatio(aspectKey) {
  const aspectMap = getRequiredConfig().aspect;
  return aspectMap[aspectKey] ?? aspectMap.IMAGE_ASPECT_RATIO_LANDSCAPE;
}

// ============================================================
// REQUEST BUILDER HELPERS
// ============================================================

function buildPromptParts(prompt, refs = null) {
  if (Array.isArray(refs) && refs.some(ref => ref && ref.mediaId)) {
    return [
      refs.map(ref =>
        ref && ref.mediaId
          ? [null, [[ref.mediaId, ref.name || ""]]]
          : [String(ref?.text ?? "")]
      )
    ];
  }
  return [[[prompt]]];
}

function buildCreateProjectPayload(projectName) {
  return ["projects/*", [null, [projectName]], [null, getToolEnum()]];
}

function getListProjectsPayload() {
  return ["projects/*", 21, null, null, null, null, [1]];
}

// ============================================================
// DATA EXTRACTION HELPERS
// ============================================================

function deepFind(value, predicate, depth = 0) {
  if (depth > 12 || value == null) return null;
  if (predicate(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = deepFind(item, predicate, depth + 1);
      if (result != null) return result;
    }
  }
  return null;
}

function isValidUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function extractMediaFromResponse(data) {
  const rawId = data?.[0]?.[0];
  const mediaId = isValidUuid(rawId?.[0]) ? rawId[0] : deepFind(data, isValidUuid);
  const cdnUrl = deepFind(data, value => typeof value === "string" && value.startsWith("https://flow-content.google/"));
  const dimensions = deepFind(data, value => Array.isArray(value) && value.length === 2 && value.every(v => typeof v === "number" && v > 64));

  return mediaId ? {
    mediaId,
    cdnUrl: cdnUrl || null,
    width: dimensions?.[0] ?? null,
    height: dimensions?.[1] ?? null
  } : null;
}

function extractMediaIdFromResponse(data) {
  const mediaId = isValidUuid(data?.[0]?.[0]) ? data[0][0] : deepFind(data, isValidUuid);
  return mediaId ? { mediaId } : null;
}

function extractUpscaledImage(data) {
  const mediaId = isValidUuid(data?.[0]?.[0]) ? data[0][0] : null;
  const base64 = typeof data?.[1] === "string" && data[1].length > 1000 ? data[1] : null;
  return base64 ? { mediaId, base64 } : null;
}

function extractProjectId(data) {
  const projectId = isValidUuid(data?.[0]) ? data[0] : deepFind(data, isValidUuid);
  return projectId ? { projectId, title: data?.[1]?.[0] ?? null } : null;
}

function extractProjectsList(data) {
  const projectsData = Array.isArray(data?.[0]) ? data[0] : Array.isArray(data) ? data : [];
  const projects = [];

  for (const item of projectsData) {
    const id = item?.[0];
    if (!isValidUuid(id)) continue;

    const rest = item?.[1] || [];
    const creationTime = Array.isArray(rest?.[2]) ? rest[2][0] : null;

    projects.push({
      projectId: id,
      title: typeof rest?.[0] === "string" ? rest[0] : "Untitled project",
      thumbUrl: typeof rest?.[3] === "string" ? rest[3] : null,
      creationTime: typeof creationTime === "number" ? creationTime : null
    });
  }

  return projects;
}

// ============================================================
// AUTH STATE MANAGEMENT
// ============================================================

let isAuthenticated = false;
let subscriptionStatus = null;
let userId = null;
let isBatchRunning = false;
let forceStop = false;
let hardStop = false;
let abortController = null;
let isUsing2kUpscale = false;
let lastRecoveryAttempt = null;

const connectionState = {
  status: "disconnected",
  flowTabId: null,
  hasProject: false,
  projectId: null,
  lastCheck: 0
};

// ============================================================
// CONSTANTS
// ============================================================

const FLOW_BASE_URL = "https://flow.google.com";
const FLOW_URL_PATTERNS = ["https://flow.google.com/*"];

const MAX_RETRY_ATTEMPTS = 2;
const RETRY_DELAYS = [60, 120];
const RATE_LIMIT_DELAYS = [60, 120];
const MAX_CONSECUTIVE_FAILURES = 8;
const DOWNLOAD_DELAY_MIN = 300;
const DOWNLOAD_DELAY_MAX = 5000;

// ============================================================
// SIGNAL / ABORT HANDLING
// ============================================================

class HardStopError extends Error {
  constructor() {
    super("__HARD_STOP__");
    this.name = "HardStopError";
  }
}

function withAbortSignal(promise) {
  if (!abortController) return promise;
  const signal = abortController.signal;
  if (signal.aborted) return Promise.reject(new HardStopError());

  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new HardStopError()), { once: true });
    })
  ]);
}

// ============================================================
// FLOW API REQUEST
// ============================================================

async function callFlowApi(tabId, rpcId, payload, { timeoutMs = 120000 } = {}) {
  const result = (await withAbortSignal(
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (siteKey, toolEnum, rpcId, payload, timeoutMs, wizKeys, rpcPath) => {
        // Get WIZ_global_data
        const wizData = window.WIZ_global_data || {};
        const keys = {
          at: wizData[wizKeys.at],
          fsid: wizData[wizKeys.fsid],
          bl: wizData[wizKeys.bl],
          base: wizData[wizKeys.base]
        };

        // Validate WIZ data
        if (!keys.at || !keys.bl || !keys.base) {
          return { error: "Flow page not ready (no page config)", protocol: true };
        }

        // JSON parsing helpers
        function parseRpcResponse(text, startPos) {
          let braceCount = 0;
          let isInString = false;
          let isEscaped = false;

          for (let i = startPos; i < text.length; i++) {
            const char = text[i];

            if (isInString) {
              if (isEscaped) {
                isEscaped = false;
                continue;
              }
              if (char === "\\") {
                isEscaped = true;
                continue;
              }
              if (char === '"') {
                isInString = false;
              }
              continue;
            }

            if (char === '"') {
              isInString = true;
            } else if (char === "[") {
              braceCount++;
            } else if (char === "]") {
              braceCount--;
              if (braceCount === 0) {
                try {
                  return [JSON.parse(text.slice(startPos, i + 1)), i + 1];
                } catch {
                  return [null, i + 1];
                }
              }
            }
          }

          return [null, text.length];
        }

        function extractRpcResponses(text) {
          const cleaned = String(text).replace(/^\)\]\}'\s*/, "");
          const responses = [];
          let pos = 0;

          while (pos < cleaned.length) {
            const start = cleaned.indexOf("[", pos);
            if (start < 0) break;

            const [parsed, nextPos] = parseRpcResponse(cleaned, start);
            pos = nextPos;

            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (Array.isArray(item) && item[0] === "wrb.fr") {
                  responses.push(item);
                }
              }
            }
          }

          return responses;
        }

        // Generate a UUID for the request
        function generateUuid() {
          return crypto.randomUUID().toUpperCase();
        }

        // Get current project ID from URL
        function getProjectIdFromUrl() {
          const match = location.pathname.match(/project\/([a-f0-9-]+)/);
          return match ? match[1] : null;
        }

        // Handle reCAPTCHA if needed
        let recaptchaToken = null;
        if (payload.needsCaptcha) {
          try {
            localStorage.removeItem("_grecaptcha");
          } catch { }

          const grecaptcha = window.grecaptcha && window.grecaptcha.enterprise;
          if (!grecaptcha) {
            return { error: "reCAPTCHA unavailable", needsRecovery: true };
          }

          try {
            recaptchaToken = await grecaptcha.execute(siteKey, {
              action: payload.captchaAction || "IMAGE_GENERATION"
            });
          } catch { }

          if (!recaptchaToken) {
            return { error: "reCAPTCHA unavailable", needsRecovery: true };
          }

          recaptchaToken = [null, null, null, null, null,
            payload.withProject === false ? null : getProjectIdFromUrl(),
            null, null, null, null,
            [recaptchaToken, 1]
          ];
        }

        // Build the RPC request
        let rpcPayload;
        const projectId = getProjectIdFromUrl();

        switch (payload.kind) {
          case "generate":
            rpcPayload = [
              null,
              [[
                null,
                null,
                payload.references && payload.references.length
                  ? payload.references.map(ref => [ref, null, null, null, 1])
                  : null,
                payload.seed,
                payload.aspect,
                payload.model,
                null,
                recaptchaToken,
                payload.promptParts,
                null,
                null,
                null,
                generateUuid(),
                generateUuid()
              ]],
              payload.count,
              recaptchaToken,
              [generateUuid()]
            ];
            break;

          case "upload":
            rpcPayload = [
              recaptchaToken,
              payload.base64,
              payload.mimeType,
              1,
              null,
              null,
              null,
              null,
              payload.fileName,
              null,
              generateUuid(),
              generateUuid()
            ];
            break;

          case "upscale":
            rpcPayload = [payload.mediaId, payload.resolution, recaptchaToken];
            break;

          default:
            rpcPayload = payload.payload;
        }

        // Build the request URL
        const baseUrl = keys.base + rpcPath + "?rpcids=" + encodeURIComponent(rpcId) +
          "&source-path=" + encodeURIComponent(location.pathname) +
          "&bl=" + encodeURIComponent(keys.bl) +
          "&f.sid=" + encodeURIComponent(keys.fsid || "") +
          "&hl=en&_reqid=" + Math.floor(Math.random() * 900000) +
          "&rt=c";

        // Build the request body
        const formData = new URLSearchParams({
          "f.req": JSON.stringify([[[rpcId, JSON.stringify(rpcPayload), null, "generic"]]]),
          "at": keys.at
        });

        // Make the request
        const abortController = new AbortController();
        const timeout = setTimeout(() => abortController.abort(), timeoutMs);

        let response, responseText;
        try {
          response = await fetch(baseUrl, {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
              "x-same-domain": "1"
            },
            body: formData,
            signal: abortController.signal
          });
          responseText = await response.text();
        } catch (error) {
          clearTimeout(timeout);
          if (error && error.name === "AbortError") {
            return { error: "Request timed out", isTimeout: true };
          }
          return { error: error && error.message ? error.message : String(error) };
        }

        clearTimeout(timeout);

        if (!response.ok) {
          return { error: "HTTP " + response.status, status: response.status };
        }

        // Check if user is signed in
        if (/^\s*<!doctype html/i.test(responseText)) {
          return { error: "NOT_SIGNED_IN", status: response.status };
        }

        // Parse the response
        const responses = extractRpcResponses(responseText);
        const matchedResponse = responses.find(item => item[1] === rpcId);

        if (!matchedResponse) {
          return { error: "Unreadable RPC envelope", protocol: true };
        }

        // Check for RPC rejection
        if (matchedResponse[2] == null) {
          const errorCode = Array.isArray(matchedResponse[5]) ? matchedResponse[5][0] : matchedResponse[5];
          return {
            error: "RPC rejected (code " + errorCode + ")",
            code: errorCode,
            protocol: errorCode === 3
          };
        }

        try {
          return {
            data: JSON.parse(matchedResponse[2]),
            projectId: projectId
          };
        } catch (error) {
          return { error: "Bad RPC payload: " + error.message, protocol: true };
        }
      },
      args: [
        getRecaptchaSiteKey(),
        getToolEnum(),
        rpcId,
        payload,
        timeoutMs,
        getWizKeys(),
        getRpcPath()
      ]
    })
  );
  
  const result = response && response[0] ? response[0].result : null;

  if (!result) {
    const error = new Error("Flow tab lost — close the Flow tab, reopen it, and try again");
    error.needsRecovery = true;
    throw error;
  }

  if (result.error) {
    if (result.error === "NOT_SIGNED_IN") {
      const signInError = new Error("__FLOW_NOT_SIGNED_IN__");
      signInError.name = "FlowSignInError";
      throw signInError;
    }

    const error = new Error(result.error);
    error.needsRecovery = !!result.needsRecovery;
    error.isProtocolError = !!result.protocol;
    error.rpcCode = result.code ?? null;
    throw error;
  }

  return result;
}

// ============================================================
// ERROR HANDLING HELPERS
// ============================================================

function getErrorMessage(error) {
  if (error?.isProtocolError) {
    return "Google changed the Flow API format — this extension needs an update. Please check for a new version.";
  }
  return error?.message || "Flow request failed";
}

// ============================================================
// URL HELPERS
// ============================================================

function getFlowBaseUrl() {
  return `${FLOW_BASE_URL}/`;
}

function getProjectUrl(projectId) {
  return `${FLOW_BASE_URL}/project/${projectId}`;
}

function isFlowUrl(url) {
  return /^https:\/\/flow\.google\.com\//.test(url);
}

// ============================================================
// TAB MANAGEMENT
// ============================================================

async function findFlowTabs() {
  const allTabs = [];
  for (const pattern of FLOW_URL_PATTERNS) {
    const tabs = await chrome.tabs.query({ url: pattern }).catch(() => []);
    allTabs.push(...tabs);
  }

  // Deduplicate by tab ID
  const uniqueTabs = [...new Map(allTabs.map(tab => [tab.id, tab])).values()];
  return uniqueTabs.filter(tab => isFlowUrl(tab.url || ""));
}

async function getMostRecentFlowTab() {
  const tabs = await findFlowTabs();
  if (!tabs.length) return null;

  // Sort by last accessed (most recent first), prefer complete tabs
  tabs.sort((a, b) => {
    if (a.status === "complete" && b.status !== "complete") return -1;
    if (b.status === "complete" && a.status !== "complete") return 1;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });

  return tabs[0];
}

// ============================================================
// CONNECTION MANAGEMENT
// ============================================================

let activeFlowTabId = null;

function broadcastConnectionState() {
  chrome.runtime.sendMessage({
    type: "CONNECTION_STATE",
    state: connectionState
  }).catch(() => { });
}

async function refreshConnectionState() {
  const tabs = await findFlowTabs();
  if (!tabs.length) {
    activeFlowTabId = null;
    connectionState.status = "disconnected";
    connectionState.flowTabId = null;
    connectionState.hasProject = false;
    connectionState.projectId = null;
    connectionState.lastCheck = Date.now();
    broadcastConnectionState();
    return connectionState;
  }

  // Use most recent complete tab
  const sortedTabs = tabs.sort((a, b) => {
    if (a.status === "complete" && b.status !== "complete") return -1;
    if (b.status === "complete" && a.status !== "complete") return 1;
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });

  const tab = sortedTabs[0];
  activeFlowTabId = tab.id;

  if (tab.status !== "complete") {
    connectionState.status = "connecting";
    connectionState.flowTabId = tab.id;
    connectionState.hasProject = false;
    connectionState.projectId = null;
    connectionState.lastCheck = Date.now();
    broadcastConnectionState();
    return connectionState;
  }

  await updateTabState(tab.id);
  return connectionState;
}

async function updateTabState(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !isFlowUrl(tab.url || "")) {
    activeFlowTabId = null;
    connectionState.status = "disconnected";
    connectionState.flowTabId = null;
    connectionState.hasProject = false;
    connectionState.projectId = null;
    connectionState.lastCheck = Date.now();
    broadcastConnectionState();
    return;
  }

  if (tab.status !== "complete") {
    connectionState.status = "connecting";
    connectionState.flowTabId = tabId;
    connectionState.hasProject = false;
    connectionState.projectId = null;
    connectionState.lastCheck = Date.now();
    broadcastConnectionState();
    return;
  }

  const pageState = await getFlowPageState(tabId);
  if (!pageState.ok) {
    connectionState.status = "connecting";
    connectionState.flowTabId = tabId;
    connectionState.hasProject = false;
    connectionState.projectId = null;
    connectionState.lastCheck = Date.now();
    broadcastConnectionState();
    return;
  }

  const hasProject = !!pageState.hasProject;
  const hasRecaptcha = !!pageState.hasRecaptcha;

  connectionState.status = hasProject && (!!pageState.hasPageConfig || hasRecaptcha)
    ? "connected"
    : "connecting";
  connectionState.flowTabId = tabId;
  connectionState.hasProject = hasProject;
  connectionState.projectId = pageState.projectId || null;
  connectionState.lastCheck = Date.now();

  broadcastConnectionState();
}

async function getCurrentProjectId(tabId) {
  const response = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const match = window.location.href.match(/project\/([a-f0-9-]+)/);
      return match ? match[1] : null;
    }
  }).catch(() => null);
  
  const result = response && response[0] ? response[0].result : null;
  return result || null;
}

async function getFlowPageState(tabId) {
  if (!tabId) return { ok: false, error: "No tabId" };

  const result = (await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (hasRecaptchaKey, wizAtKey) => {
      const projectMatch = window.location.href.match(/project\/([a-f0-9-]+)/);
      const hasRecaptcha = typeof grecaptcha !== "undefined" && !!grecaptcha?.enterprise;

      // Try to inject reCAPTCHA if missing
      if (!hasRecaptcha && hasRecaptchaKey && !window.__whiskRecaptchaNudge) {
        window.__whiskRecaptchaNudge = true;
        try {
          const siteKey = hasRecaptchaKey;
          if (!document.querySelector('script[src*="recaptcha/enterprise"]')) {
            const script = document.createElement("script");
            script.src = "https://www.google.com/recaptcha/enterprise.js?render=" + siteKey;
            script.async = true;
            (document.head || document.documentElement).appendChild(script);
          }
        } catch { }
      }

      return {
        url: window.location.href,
        hasProject: !!projectMatch,
        projectId: projectMatch ? projectMatch[1] : null,
        hasRecaptcha: hasRecaptcha,
        hasPageConfig: !!(wizAtKey && window.WIZ_global_data && window.WIZ_global_data[wizAtKey])
      };
    },
    args: [hasApiConfig() ? getRecaptchaSiteKey() : "", hasApiConfig() ? getWizKeys().at : ""]
  }).catch(() => null))?.[0]?.result;

  return result ? { ok: true, ...result } : { ok: false, error: "Could not read page — is the Flow tab fully loaded?" };
}

// ============================================================
// TAB EVENT LISTENERS
// ============================================================

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = tab.url || "";
  const isFlow = isFlowUrl(url);

  if (changeInfo.url || changeInfo.status) {
    if (isFlow) {
      if (changeInfo.status === "loading") {
        activeFlowTabId = tabId;
        connectionState.status = "connecting";
        connectionState.flowTabId = tabId;
        connectionState.hasProject = false;
        connectionState.projectId = null;
        broadcastConnectionState();
      } else if (changeInfo.status === "complete") {
        activeFlowTabId = tabId;
        setTimeout(() => updateTabState(tabId), 2000);
      }
    } else if (tabId === activeFlowTabId) {
      activeFlowTabId = null;
      connectionState.status = "disconnected";
      connectionState.flowTabId = null;
      connectionState.hasProject = false;
      connectionState.projectId = null;
      broadcastConnectionState();
    }
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(tab => {
    if (isFlowUrl(tab.url || "")) {
      if (activeFlowTabId === tabId && connectionState.status === "connected") return;
      activeFlowTabId = tabId;
      updateTabState(tabId);
    } else if (activeFlowTabId && activeFlowTabId !== tabId) {
      // Check if the old flow tab still exists
      chrome.tabs.get(activeFlowTabId).catch(() => {
        activeFlowTabId = null;
        connectionState.status = "disconnected";
        connectionState.flowTabId = null;
        connectionState.hasProject = false;
        connectionState.projectId = null;
        broadcastConnectionState();
      });
    }
  }).catch(() => { });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeFlowTabId) {
    activeFlowTabId = null;
    connectionState.status = "disconnected";
    connectionState.flowTabId = null;
    connectionState.hasProject = false;
    connectionState.projectId = null;
    broadcastConnectionState();
  }
});

chrome.tabs.onReplaced.addListener((newTabId, oldTabId) => {
  if (oldTabId === activeFlowTabId) {
    activeFlowTabId = newTabId;
    setTimeout(() => updateTabState(newTabId), 2000);
  }
});

// ============================================================
// SIDE PANEL SETUP
// ============================================================

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => { });
  if (!isFlowUrl(tab.url || "")) {
    chrome.tabs.update(tab.id, { url: getFlowBaseUrl() });
  }
});

// ============================================================
// DOWNLOAD HANDLING
// ============================================================

const downloadFilenameMap = new Map();

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const filename = downloadFilenameMap.get(downloadItem.id);
  if (filename) {
    suggest({ filename, conflictAction: "uniquify" });
  }
});

chrome.downloads.onChanged.addListener((downloadDelta) => {
  if (downloadDelta.state && (downloadDelta.state.current === "complete" || downloadDelta.state.current === "interrupted")) {
    downloadFilenameMap.delete(downloadDelta.id);
  }
});

// ============================================================
// OFFCREEN DOCUMENT MANAGEMENT
// ============================================================

let offscreenPromise = null;

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen.html")]
  });

  if (contexts.length > 0) return;

  if (offscreenPromise) {
    await offscreenPromise;
    return;
  }

  offscreenPromise = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "Handle Firebase Firestore operations for quota tracking when sidepanel is closed"
  });

  await offscreenPromise;
  offscreenPromise = null;
}

async function sendMessageToOffscreen(message) {
  await ensureOffscreenDocument();
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(response);
      }
    });
  });
}

// ============================================================
// AUTH STATE PERSISTENCE
// ============================================================

function saveAuthState() {
  chrome.storage.local.set({
    authState: {
      isLoggedIn: isAuthenticated,
      subscriptionStatus: subscriptionStatus,
      userId: userId,
      lastUpdated: Date.now()
    }
  });
}

// Load auth state on startup
chrome.storage.local.get(["authState"], (result) => {
  if (result.authState) {
    isAuthenticated = result.authState.isLoggedIn || false;
    subscriptionStatus = result.authState.subscriptionStatus || null;
    userId = result.authState.userId || null;
    setTimeout(() => broadcastAuthState(), 1000);
  }
});

function broadcastAuthState() {
  const message = {
    action: "authStateChanged",
    isLoggedIn: isAuthenticated,
    subscriptionStatus: subscriptionStatus,
    userId: userId,
    timestamp: Date.now()
  };

  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(tab => {
      if (tab.url && isFlowUrl(tab.url)) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => { });
      }
    });
  });
}

// Broadcast auth state on tab activation
chrome.tabs.onActivated.addListener(({ tabId }) => {
  setTimeout(() => {
    chrome.tabs.get(tabId).then(tab => {
      if (tab && tab.url && isFlowUrl(tab.url)) {
        chrome.tabs.sendMessage(tabId, {
          action: "authStateChanged",
          isLoggedIn: isAuthenticated,
          subscriptionStatus: subscriptionStatus,
          userId: userId,
          timestamp: Date.now()
        }).catch(() => { });
      }
    }).catch(() => { });
  }, 500);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) {
    setTimeout(() => {
      chrome.tabs.query({ active: true, windowId: windowId }, (tabs) => {
        if (tabs[0] && tabs[0].url && isFlowUrl(tabs[0].url)) {
          chrome.tabs.sendMessage(tabs[0].id, {
            action: "authStateChanged",
            isLoggedIn: isAuthenticated,
            subscriptionStatus: subscriptionStatus,
            userId: userId,
            timestamp: Date.now()
          }).catch(() => { });
        }
      });
    }, 500);
  }
});

// ============================================================
// INSTALLATION HANDLING
// ============================================================

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.set({
    autoDownload: true,
    delayBetweenPrompts: 5,
    authRequired: true,
    quotaStatus: {
      isCheckingQuota: false,
      _xk1: true,
      lastChecked: Date.now()
    }
  });

  if (details.reason === "install") {
    chrome.tabs.create({
      url: "https://autoplaylabs.com/projects/whisk-automator-bulk-ai-image-generation/"
    });
  }
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => { });

// ============================================================
// QUOTA STATUS MANAGEMENT
// ============================================================

async function refreshQuotaStatus() {
  try {
    const status = await sendMessageToOffscreen({ action: "getQuotaStatus" });
    if (status) {
      chrome.runtime.sendMessage({
        action: "quotaUpdated",
        quotaData: status
      }).catch(() => { });
    }
  } catch {
    // Ignore errors
  }
}

// ============================================================
// UPLOAD IMAGE
// ============================================================

async function uploadImage(tabId, base64Data, fileName, mimeType) {
  let result;
  try {
    result = await callFlowApi(tabId, getRpcConfig().upload, {
      kind: "upload",
      needsCaptcha: true,
      captchaAction: "IMAGE_GENERATION",
      base64: base64Data,
      mimeType: mimeType,
      fileName: fileName
    });
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }

  const mediaInfo = extractMediaIdFromResponse(result.data);
  if (!mediaInfo?.mediaId) {
    throw new Error("Upload failed — no media id in Flow's response");
  }

  return mediaInfo.mediaId;
}

// ============================================================
// REFERENCE EXTRACTION
// ============================================================

function extractReferences(whiskSlots = {}, parts = null) {
  const refs = [];

  const addRef = (id) => {
    if (id && !refs.includes(id) && refs.length < 10) {
      refs.push(id);
    }
  };

  // Extract from parts (tagged references)
  if (Array.isArray(parts)) {
    for (const part of parts) {
      const media = part?.reference?.media;
      if (media?.mediaId) {
        addRef(media.mediaId);
      }
    }
  }

  // Extract from whiskSlots
  for (const subject of whiskSlots.subjects || []) {
    addRef(subject?.mediaId);
  }
  addRef(whiskSlots.scene?.mediaId);
  addRef(whiskSlots.style?.mediaId);

  return refs;
}

// ============================================================
// GENERATE IMAGE
// ============================================================

async function generateImage(tabId, prompt, settings, whiskSlots = {}, parts = null) {
  const references = extractReferences(whiskSlots, parts);
  const hasParts = Array.isArray(parts) && parts.some(p => p?.reference?.media?.mediaId);
  const promptParts = hasParts
    ? parts.map(part => {
      const media = part?.reference?.media;
      return media?.mediaId
        ? { mediaId: media.mediaId, name: media.handle || "" }
        : { text: part?.text ?? "" };
    })
    : buildPromptParts(prompt, null);

  const aspectRatio = getAspectRatio(settings.aspectRatio);
  const model = settings.model || "NARWHAL";
  const seed = settings.seedMode === "fixed" && settings.seedValue != null
    ? settings.seedValue
    : generateRandomSeed();

  let result;
  try {
    result = await callFlowApi(tabId, getRpcConfig().generate, {
      kind: "generate",
      needsCaptcha: true,
      captchaAction: "IMAGE_GENERATION",
      seed: seed,
      aspect: aspectRatio,
      model: model,
      count: 1,
      promptParts: promptParts,
      references: references
    });
  } catch (error) {
    if (error?.name === "HardStopError" || hardStop) throw error;
    if (error?.needsRecovery) {
      if (!await recoverRecaptcha(tabId)) {
        throw new FatalError(getErrorMessage(error));
      }
      return generateImage(activeFlowTabId || tabId, prompt, settings, whiskSlots, parts);
    }
    throw new Error(getErrorMessage(error));
  }

  const mediaInfo = extractMediaFromResponse(result.data);
  if (!mediaInfo?.mediaId) {
    throw new Error("Flow returned no image — the response format may have changed.");
  }

  return {
    mediaId: mediaInfo.mediaId,
    fifeUrl: mediaInfo.cdnUrl
  };
}

// ============================================================
// GENERATE MULTIPLE IMAGES
// ============================================================

async function generateImages(tabId, prompt, settings, promptIndex, whiskSlots = {}, parts = null) {
  const imageCount = settings.imageCount || 1;
  updateProgress("PROMPT_INIT", { promptIndex, count: imageCount, mediaType: "image" });

  const tasks = Array.from({ length: imageCount }, (_, slot) => {
    const baseDelay = 250 * (promptIndex * imageCount + slot);
    return async () => {
      if (baseDelay > 0 && await sleep(baseDelay)) {
        // Check if cancelled
        if (forceStop || hardStop) return null;
      }

      for (let attempt = 0; attempt <= 1; attempt++) {
        if (attempt > 0 && await sleep(2000)) {
          // Check if cancelled
          if (forceStop || hardStop) return null;
        }

        try {
          const result = await generateImage(activeFlowTabId || tabId, prompt, settings, whiskSlots, parts);
          if (result) {
            notifyPreviewReady(promptIndex, slot, result.mediaId, result.fifeUrl);
            return result.mediaId;
          }
        } catch (error) {
          if (hardStop) return null;
          if (error.name === "QuotaError" || error.name === "RateLimitError" ||
            error.name === "FatalError" || error.message.includes("400") || attempt === 1) {
            throw error;
          }
        }
      }
      return null;
    };
  });

  const results = await runConcurrentTasks(tasks, 4);

  // Notify failures
  results.forEach((result, slot) => {
    if (!result) {
      notifyPreviewReady(promptIndex, slot, null, null, true);
    }
  });

  const successfulResults = results.filter(Boolean);
  if (!successfulResults.length && !hardStop) {
    throw new Error("All image requests failed — check your Flow tab and try again");
  }

  return successfulResults;
}

// ============================================================
// DOWNLOAD IMAGE
// ============================================================

async function downloadImage(tabId, mediaId, filename, quality = "standard") {
  // Wait for tab to be ready
  let isReady = false;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        isReady = true;
        break;
      }
    } catch {
      break;
    }
    await sleep(1000);
  }

  if (!isReady) {
    throw new Error("Flow tab not ready for download — it may have been closed or navigated away");
  }

  // Try 2K upscale if enabled
  if (quality === "2k" && !isUsing2kUpscale) {
    try {
      const upscaledBase64 = await upscaleImage(tabId, mediaId);
      if (upscaledBase64) {
        const blobUrl = await createBlobUrlFromBase64(upscaledBase64);
        if (blobUrl) {
          await downloadToFile(blobUrl, filename);
          chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (url) => URL.revokeObjectURL(url),
            args: [blobUrl]
          }).catch(() => { });
          return;
        }
      }
    } catch {
      // Fall through to standard download
    }
  }

  // Standard download
  await downloadMedia(tabId, mediaId, filename);
}

async function upscaleImage(tabId, mediaId) {
  let result;
  try {
    result = await callFlowApi(tabId, getRpcConfig().upscale, {
      kind: "upscale",
      needsCaptcha: true,
      captchaAction: "IMAGE_GENERATION",
      mediaId: mediaId,
      resolution: getUpscaleResolution(),
      withProject: false
    }, { timeoutMs: 180000 });
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }

  const upscaledData = extractUpscaledImage(result.data);
  if (!upscaledData?.base64) {
    throw new Error("Upscale failed — no image in Flow's response");
  }

  return upscaledData.base64;
}

async function createBlobUrlFromBase64(base64Data) {
  const result = await chrome.scripting.executeScript({
    target: { tabId: activeFlowTabId },
    world: "MAIN",
    func: (data) => {
      try {
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: "image/png" });
        return URL.createObjectURL(blob);
      } catch {
        return null;
      }
    },
    args: [base64Data]
  }).catch(() => null);

  return result?.[0]?.result || null;
}

async function downloadMedia(tabId, mediaId, filename) {
  let result;
  try {
    result = await callFlowApi(tabId, getRpcConfig().mediaDetail, {
      kind: "raw",
      payload: [mediaId]
    });
  } catch (error) {
    throw new Error("Download failed: " + getErrorMessage(error));
  }

  // Find CDN URL in response
  const cdnUrl = deepFind(result.data, (value) => {
    return typeof value === "string" && value.startsWith("https://flow-content.google/");
  });

  if (!cdnUrl) {
    throw new Error("Download failed: Flow returned no media URL");
  }

  // Fetch and download the image
  const scriptResult = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (url) => {
      try {
        const response = await fetch(url, { credentials: "omit" });
        if (!response.ok) return { error: "HTTP " + response.status };

        const blob = await response.blob();
        if (!blob.size) return { error: "Empty image" };

        let imageBlob = blob;
        try {
          const bitmap = await createImageBitmap(blob);
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d").drawImage(bitmap, 0, 0);
          bitmap.close?.();

          const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
          if (pngBlob?.size) {
            imageBlob = pngBlob;
          }
        } catch { }

        return {
          blobUrl: URL.createObjectURL(imageBlob),
          size: imageBlob.size
        };
      } catch (error) {
        return { error: error.message };
      }
    },
    args: [cdnUrl]
  }).catch(() => null);

  const downloadResult = scriptResult?.[0]?.result;
  if (!downloadResult?.blobUrl) {
    throw new Error("Download failed: " + (downloadResult?.error || "unknown"));
  }

  await downloadToFile(downloadResult.blobUrl, filename);

  chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (url) => URL.revokeObjectURL(url),
    args: [downloadResult.blobUrl]
  }).catch(() => { });
}

async function downloadToFile(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: false,
      conflictAction: "uniquify"
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      downloadFilenameMap.set(downloadId, filename);
      resolve(downloadId);
    });
  });
}

// ============================================================
// RECAPTCHA RECOVERY
// ============================================================

async function waitForRecaptcha(tabId, timeoutMs = 12000) {
  const startTime = Date.now() + timeoutMs;
  while (Date.now() < startTime) {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (siteKey) => {
        try {
          localStorage.removeItem("_grecaptcha");
        } catch { }
        const grecaptcha = window.grecaptcha?.enterprise;
        if (grecaptcha) {
          try {
            const token = await grecaptcha.execute(siteKey, { action: "IMAGE_GENERATION" });
            return token || null;
          } catch {
            return null;
          }
        }
        return null;
      },
      args: [getRecaptchaSiteKey()]
    }).catch(() => null);

    if (result?.[0]?.result) return true;
    await sleep(1000);
  }
  return false;
}

async function reloadFlowTab(tabId, { maxAttempts = 3, loadTimeoutMs = 25000 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await chrome.tabs.reload(tabId);
    } catch {
      const error = new Error("Flow tab was closed — cannot continue batch");
      error.name = "FatalError";
      throw error;
    }

    // Wait for tab to complete loading
    const loaded = await new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(false);
        }
      }, loadTimeoutMs);

      const listener = (id, changeInfo) => {
        if (id !== tabId || changeInfo.status !== "complete") return;
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(true);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });

    if (!loaded) {
      if (attempt < maxAttempts) {
        await sleep(1500);
        continue;
      }
      const error = new Error("Flow tab failed to load after " + maxAttempts + " attempts — stopping batch");
      error.name = "FatalError";
      throw error;
    }

    await sleep(800);

    if (await waitForRecaptcha(tabId)) {
      return true;
    }

    if (attempt < maxAttempts) {
      await sleep(1500);
    } else {
      const error = new Error("Flow page reloaded but reCAPTCHA still unavailable after " + maxAttempts + " attempts — stopping batch");
      error.name = "FatalError";
      throw error;
    }
  }

  return false;
}

async function recoverRecaptcha(tabId) {
  const { index, total } = batchProgress;

  if (lastRecoveryAttempt) return lastRecoveryAttempt;

  let resolveRecovery;
  lastRecoveryAttempt = new Promise(resolve => { resolveRecovery = resolve; });

  const reportError = (message) => {
    notifyBatchProgress(index, total, "warn", message);
    notifyShowFixUnusual();
    resolveRecovery(false);
    return false;
  };

  const reportSuccess = (message) => {
    notifyBatchProgress(index, total, "running", message);
    resolveRecovery(true);
    return true;
  };

  try {
    // Try reloading first
    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      notifyBatchProgress(index, total, "waiting", `reCAPTCHA stale — reloading Flow page (${attempt}/${MAX_RETRY_ATTEMPTS})…`);
      try {
        await reloadFlowTab(tabId);
        return reportSuccess("✅ reCAPTCHA recovered via page reload");
      } catch (error) {
        console.warn("[recovery] reload level failed:", error?.message || error);
      }
    }

    // Try creating a new project
    if (!hardStop) {
      notifyBatchProgress(index, total, "waiting", "Reload didn't help — creating a fresh project…");
      try {
        const newProjectId = await createNewProject();
        if (!newProjectId) throw new Error("no projectId");

        const projectUrl = getProjectUrl(newProjectId);
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: (url) => { window.location.href = url; },
          args: [projectUrl]
        });

        await waitForTabLoad(tabId);
        lastRecoveryAttempt = null;

        if (await waitForRecaptcha(tabId)) {
          connectionState.status = "connected";
          connectionState.flowTabId = tabId;
          connectionState.hasProject = true;
          connectionState.projectId = newProjectId;
          connectionState.lastCheck = Date.now();
          broadcastConnectionState();
          return reportSuccess("✅ reCAPTCHA recovered via new project");
        }
      } catch (error) {
        console.warn("[recovery] new-project level failed:", error?.message || error);
      }
    }

    // Try closing and reopening the tab
    if (!hardStop) {
      notifyBatchProgress(index, total, "waiting", "Still stuck — closing the Flow tab and opening a fresh one…");
      const newTabId = await reopenTabWithNewProject(tabId);
      if (newTabId) {
        return reportSuccess("✅ reCAPTCHA recovered via fresh tab");
      }
    }

    return reportError("Could not recover reCAPTCHA — close the Flow tab, reopen it, and try again.");
  } catch (error) {
    console.warn("[recovery] unexpected error:", error?.message || error);
    return reportError("reCAPTCHA recovery failed — close the Flow tab, reopen it, and try again.");
  } finally {
    await sleep(1500);
    lastRecoveryAttempt = null;
  }
}

// ============================================================
// BATCH PROCESSING
// ============================================================

const BATCH_MODEL_FALLBACK_ORDER = ["GEM_PIX_2", "NARWHAL", "HARBOR_SEAL"];

function getFallbackModel(currentModel) {
  const index = BATCH_MODEL_FALLBACK_ORDER.indexOf(currentModel);
  return index >= 0 && index < BATCH_MODEL_FALLBACK_ORDER.length - 1
    ? BATCH_MODEL_FALLBACK_ORDER[index + 1]
    : null;
}

async function processBatch(options) {
  let tabId = options.tabId;
  const prompts = options.prompts || [];
  const settings = options.settings || {};
  const refreshFrequency = options.settings?.refreshFrequency ?? 5;
  const promptIndices = options.promptIndices || prompts.map((_, idx) => idx);
  const totalAbsolute = options.totalAbsolute || promptIndices[promptIndices.length - 1] + 1 || prompts.length;

  forceStop = false;
  hardStop = false;
  abortController = new AbortController();
  isUsing2kUpscale = false;
  lastRecoveryAttempt = null;
  resetRetryCounters();

  batchProgress = {
    index: promptIndices[0] || 0,
    total: totalAbsolute
  };

  const effectiveSettings = { ...settings };
  const downloadQuality = options.imageDownloadQuality || "standard"
    ? options.imageDownloadQuality || "standard"
    : "standard";

  let completedCount = 0;
  let failedCount = 0;
  let consecutiveFailures = 0;
  let isAborted = false;

  const MAX_FAILURES = 8;
  const rateLimitDelays = [...RATE_LIMIT_DELAYS];
  const retryDelays = [...RETRY_DELAYS];

  for (let i = 0; i < prompts.length && !isAborted; i++) {
    const promptIndex = promptIndices[i];
    batchProgress.index = promptIndex;

    if (forceStop || hardStop) {
      notifyBatchProgress(promptIndex, totalAbsolute, "stopped", hardStop ? "Force stopped." : "Stopped.");
      break;
    }

    const prompt = prompts[i];
    const promptText = typeof prompt === "string" ? prompt : prompt.text;
    const whiskSlots = typeof prompt === "object" && prompt.whiskSlots
      ? prompt.whiskSlots
      : { subjects: [], scene: null, style: null };
    const parts = typeof prompt === "object" && Array.isArray(prompt.parts)
      ? prompt.parts
      : null;

    notifyPromptInit(promptIndex, settings.imageCount || 1);
    notifyBatchProgress(promptIndex, totalAbsolute, "running", `[${i + 1}/${prompts.length}] "${promptText.substring(0, 50)}…"`);

    let attempts = 0;
    let success = false;

    while (!success && !forceStop && !hardStop) {
      tabId = activeFlowTabId || tabId;

      try {
        const mediaIds = await generateImages(tabId, promptText, settings, promptIndex, whiskSlots, parts);
        tabId = activeFlowTabId || tabId;

        notifyBatchProgress(promptIndex, totalAbsolute, "downloading", `[${i + 1}/${prompts.length}] ${mediaIds.length} image(s) — downloading…`);

        // Download images
        const downloadedFiles = [];
        if (settings.autoDownload !== false) {
          const delayRemaining = DOWNLOAD_DELAY_MAX - (Date.now() - lastDownloadTime);
          if (lastDownloadTime > 0 && delayRemaining > 0) {
            await sleep(delayRemaining);
          }
          lastDownloadTime = Date.now();

          for (let slot = 0; slot < mediaIds.length; slot++) {
            if (slot > 0) await sleep(DOWNLOAD_DELAY_MIN);

            const filename = buildFilename(settings, promptIndex, slot, promptText);
            await downloadImage(tabId, mediaIds[slot], filename, downloadQuality);
            downloadedFiles.push(filename);

            if (isUsing2kUpscale && !is2kWarningShown) {
              is2kWarningShown = true;
              notifyBatchProgress(promptIndex, totalAbsolute, "warn", "2K upscale limit reached — switching to standard quality");
            }
          }
        }

        completedCount++;
        success = true;
        consecutiveFailures = 0;
        resetRetryCounters();

        // Update quota
        if (userId) {
          sendMessageToOffscreen({
            action: "updateQuota",
            userId: userId,
            newlyProcessed: 1
          }).then(response => {
            if (response?.success) {
              chrome.runtime.sendMessage({
                action: "quotaUpdated",
                quotaData: response.quotaData
              }).catch(() => { });
            }
          }).catch(() => { });
        }

        notifyPromptResult(promptIndex, promptText, "done", mediaIds, downloadedFiles);
        notifyBatchProgress(promptIndex, totalAbsolute, "done", `[${i + 1}/${prompts.length}] Done — ${mediaIds.length} image(s) saved`);

        // Refresh tab if needed
        if (tabId && refreshFrequency > 0 && completedCount % refreshFrequency === 0 && i < prompts.length - 1 && !forceStop && !hardStop) {
          lastRecoveryAttempt = null;
          notifyBatchProgress(promptIndices[i + 1], totalAbsolute, "waiting", "Refreshing Flow tab…");
          await reloadFlowTab(tabId);
        }

        // Delay between prompts
        if (i < prompts.length - 1 && !forceStop && !hardStop) {
          const minDelay = (settings.delayMin ?? 3) * 1000;
          const maxDelay = (settings.delayMax ?? 8) * 1000;
          const delay = minDelay + Math.random() * (maxDelay - minDelay);

          if (delay > 0) {
            const nextIndex = promptIndices[i + 1];
            let remainingSeconds = Math.ceil(delay / 1000);

            notifyBatchProgress(nextIndex, totalAbsolute, "waiting", `Waiting ${remainingSeconds}s…`, remainingSeconds);

            const interval = setInterval(() => {
              if (forceStop) {
                clearInterval(interval);
                return;
              }
              remainingSeconds--;
              if (remainingSeconds <= 0) {
                clearInterval(interval);
                return;
              }
              notifyBatchProgress(nextIndex, totalAbsolute, "waiting", `Waiting ${remainingSeconds}s…`, remainingSeconds);
            }, 1000);

            await sleep(delay);
            clearInterval(interval);
          }
        }

      } catch (error) {
        const handleRetry = async (delaySeconds, message) => {
          const startTime = Date.now();
          const interval = setInterval(() => {
            if (forceStop) {
              clearInterval(interval);
              return;
            }
            const remaining = delaySeconds - Math.ceil((Date.now() - startTime) / 1000);
            if (remaining <= 0) {
              clearInterval(interval);
              return;
            }
            notifyBatchProgress(promptIndex, totalAbsolute, "waiting", `${message} ${remaining}s…`, remaining);
          }, 1000);

          notifyBatchProgress(promptIndex, totalAbsolute, "waiting", `${message} ${delaySeconds}s…`, delaySeconds);
          await sleep(delaySeconds * 1000);
          clearInterval(interval);

          if (!forceStop) {
            notifyBatchProgress(promptIndex, totalAbsolute, "waiting", "Refreshing Flow tab before retry…");
            await reloadFlowTab(tabId);
          }
        };

        if (error.name === "RateLimitError") {
          if (attempts < rateLimitDelays.length) {
            const delay = rateLimitDelays[attempts++];
            await handleRetry(delay, "Rate limited — retrying in");
            if (!forceStop) {
              notifyBatchProgress(promptIndex, totalAbsolute, "running", `[${i + 1}/${prompts.length}] Retrying "${promptText.substring(0, 50)}…"`);
            }
            continue;
          }

          failedCount++;
          consecutiveFailures++;
          success = true; // Mark as handled to avoid infinite loop
          notifyPromptResult(promptIndex, promptText, "failed", [], [], error.message);
          notifyBatchProgress(promptIndex, totalAbsolute, "failed", `🚫 Rate limit persists after ${attempts + 1} attempts — skipping prompt`);

          if (consecutiveFailures >= MAX_FAILURES) {
            notifyBatchProgress(promptIndex, totalAbsolute, "failed", `🛑 ${MAX_FAILURES} prompts failed in a row — stopping batch. Check your Flow page and try again.`);
            isAborted = true;
          }
          break;
        }

        if (error.name === "QuotaError") {
          if (attempts < retryDelays.length) {
            const delay = retryDelays[attempts++];
            const modelName = getModelDisplayName(settings.model);
            await handleRetry(delay, `${modelName} quota hit — retrying in`);
            if (!forceStop) {
              notifyBatchProgress(promptIndex, totalAbsolute, "running", `[${i + 1}/${prompts.length}] Retrying "${promptText.substring(0, 50)}…"`);
            }
            continue;
          }

          const fallbackModel = getFallbackModel(settings.model);
          if (fallbackModel) {
            const oldModelName = getModelDisplayName(settings.model);
            const newModelName = getModelDisplayName(fallbackModel);
            settings.model = fallbackModel;
            attempts = 0;

            notifyBatchProgress(promptIndex, totalAbsolute, "waiting", `⚠️ ${oldModelName} daily quota exhausted — switching to ${newModelName} and continuing batch`);
            notifyModelSwitched(oldModelName, newModelName, fallbackModel);
            notifyBatchProgress(promptIndex, totalAbsolute, "running", `[${i + 1}/${prompts.length}] Retrying with ${newModelName}…`);
            continue;
          }

          failedCount++;
          consecutiveFailures++;
          success = true;
          const modelName = getModelDisplayName(settings.model);
          notifyPromptResult(promptIndex, promptText, "failed", [], [], error.message);
          notifyBatchProgress(promptIndex, totalAbsolute, "failed", `🚫 ${modelName} daily quota exhausted and no fallback model available — stopping batch`);
          isAborted = true;
          break;
        }

        if (error.name === "HardStopError" || hardStop) {
          success = true;
          notifyBatchProgress(promptIndex, totalAbsolute, "stopped", "Force stopped.");
          isAborted = true;
          break;
        }

        // Fatal error
        failedCount++;
        consecutiveFailures++;
        success = true;
        lastRecoveryAttempt = null;

        if (error.name === "FatalError") {
          notifyPromptResult(promptIndex, promptText, "failed", [], [], error.message);
          notifyBatchProgress(promptIndex, totalAbsolute, "failed", "⛔ " + error.message);
          isAborted = true;
          break;
        }

        if (error.message.includes("401") || error.message.includes("expired")) {
          lastRecoveryAttempt = null;
          notifyPromptResult(promptIndex, promptText, "failed", [], [], error.message);
          notifyBatchProgress(promptIndex, totalAbsolute, "failed", "⛔ Session expired — refresh the Flow page and try again");
          isAborted = true;
          break;
        }

        consecutiveFailures++;
        notifyPromptResult(promptIndex, promptText, "failed", [], [], error.message);
        notifyBatchProgress(promptIndex, totalAbsolute, "failed", `[${i + 1}/${prompts.length}] Failed: ${error.message}`);

        if (consecutiveFailures >= MAX_FAILURES) {
          notifyBatchProgress(promptIndex, totalAbsolute, "failed", `🛑 ${MAX_FAILURES} prompts failed in a row — stopping batch. Check your Flow page and try again.`);
          isAborted = true;
        }
        break;
      }
    }
  }

  // Final notification
  notifyBatchDone(completedCount, failedCount, prompts.length, forceStop || hardStop, hardStop);

  // Refresh tab after batch
  if (completedCount > 0 && tabId && !hardStop) {
    lastRecoveryAttempt = null;
    await sleep(300);
    await reloadFlowTab(tabId).catch(() => { });
  }
}

// ============================================================
// TASK CONCURRENCY
// ============================================================

function runConcurrentTasks(tasks, concurrency) {
  return new Promise((resolve, reject) => {
    const results = new Array(tasks.length).fill(undefined);
    let completed = 0;
    let running = 0;
    let index = 0;
    let hasError = false;

    function startNext() {
      while (running < concurrency && index < tasks.length && !hasError) {
        const currentIndex = index++;
        running++;

        tasks[currentIndex]().then(result => {
          results[currentIndex] = result;
        }).catch(error => {
          if (error.name === "QuotaError" || error.name === "RateLimitError" || error.name === "FatalError") {
            hasError = true;
            reject(error);
            return;
          }
          results[currentIndex] = null;
        }).finally(() => {
          if (hasError) return;
          running--;
          completed++;
          if (completed === tasks.length) {
            resolve(results);
          } else {
            startNext();
          }
        });
      }
    }

    if (tasks.length === 0) {
      resolve(results);
      return;
    }

    startNext();
  });
}

// ============================================================
// PROJECT MANAGEMENT
// ============================================================

async function createNewProject() {
  const timestamp = new Date().toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).replace(",", "");

  const result = await callFlowApi(activeFlowTabId, getRpcConfig().createProject, {
    kind: "raw",
    payload: buildCreateProjectPayload(timestamp)
  });

  const projectInfo = extractProjectId(result.data);
  if (!projectInfo?.projectId) {
    throw new Error("createProject failed");
  }

  return projectInfo.projectId;
}

async function listProjects(tabId, cursor = null, pageSize = 20) {
  const result = await callFlowApi(tabId, getRpcConfig().listProjects, {
    kind: "raw",
    payload: getListProjectsPayload()
  });

  const projects = extractProjectsList(result.data).map(project => ({
    projectId: project.projectId,
    title: project.title,
    thumbnailMediaKey: null,
    thumbUrl: project.thumbUrl,
    creationTime: project.creationTime
  }));

  return { projects, nextPageToken: null };
}

async function getProjectName(tabId, projectId) {
  try {
    const result = await callFlowApi(tabId, getRpcConfig().listProjects, {
      kind: "raw",
      payload: getListProjectsPayload()
    });
    const projects = extractProjectsList(result.data);
    const project = projects.find(p => p.projectId === projectId);
    return project?.title || null;
  } catch {
    return null;
  }
}

async function openProject(projectId) {
  const url = getProjectUrl(projectId);
  let tabId = activeFlowTabId;

  if (tabId) {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      tabId = null;
    }
  }

  if (tabId) {
    await chrome.tabs.update(tabId, { url });
  } else {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
  }

  activeFlowTabId = tabId;
  lastRecoveryAttempt = null;

  connectionState.status = "connecting";
  connectionState.flowTabId = tabId;
  connectionState.hasProject = true;
  connectionState.projectId = projectId;
  connectionState.lastCheck = Date.now();
  broadcastConnectionState();

  await waitForTabLoad(tabId);

  connectionState.status = "connected";
  connectionState.flowTabId = tabId;
  connectionState.hasProject = true;
  connectionState.projectId = projectId;
  connectionState.lastCheck = Date.now();
  broadcastConnectionState();

  return tabId;
}

// ============================================================
// TAB WAITING HELPERS
// ============================================================

async function waitForTabLoad(tabId, timeoutMs = 30000) {
  // Wait for tab status to be "complete"
  await new Promise((resolve, reject) => {
    const checkTab = () => {
      chrome.tabs.get(tabId).then(tab => {
        if (tab.status === "complete") {
          resolve();
        } else if (Date.now() > startTime + timeoutMs) {
          reject(new Error("Timed out waiting for Flow tab to load"));
        } else {
          setTimeout(checkTab, 500);
        }
      }).catch(reject);
    };

    const startTime = Date.now();
    checkTab();
  });

  // Wait for page to be ready
  await new Promise((resolve, reject) => {
    const checkPage = async () => {
      if (Date.now() > startTime + timeoutMs) {
        reject(new Error("Timed out waiting for Flow page to be ready"));
        return;
      }

      const state = await getFlowPageState(tabId).catch(() => null);
      if (state?.ok && state.hasProject && (state.hasRecaptcha || state.hasPageConfig)) {
        resolve();
      } else {
        setTimeout(checkPage, 1000);
      }
    };

    const startTime = Date.now();
    setTimeout(checkPage, 2000);
  });
}

// ============================================================
// NOTIFICATION HELPERS
// ============================================================

function notifyBatchProgress(index, total, status, message, countdown = null) {
  chrome.runtime.sendMessage({
    type: "BATCH_PROGRESS",
    index,
    total,
    status,
    message,
    countdown
  }).catch(() => { });
}

function notifyPromptInit(promptIndex, count) {
  chrome.runtime.sendMessage({
    type: "PROMPT_INIT",
    promptIndex,
    count,
    mediaType: "image"
  }).catch(() => { });
}

function notifyPreviewReady(promptIndex, imageSlot, mediaId, fifeUrl, failed = false) {
  chrome.runtime.sendMessage({
    type: "PREVIEW_READY",
    promptIndex,
    imageSlot,
    mediaId,
    fifeUrl,
    failed
  }).catch(() => { });
}

function notifyPromptResult(promptIndex, prompt, status, mediaIds = [], files = [], error = null) {
  chrome.runtime.sendMessage({
    type: "PROMPT_RESULT",
    index: promptIndex,
    prompt,
    status,
    mediaIds,
    files,
    error,
    finishedAt: Date.now()
  }).catch(() => { });
}

function notifyBatchDone(completed, failed, total, stopped = false, hardStopped = false) {
  chrome.runtime.sendMessage({
    type: "BATCH_DONE",
    completed,
    failed,
    total,
    stopped,
    hardStopped
  }).catch(() => { });
}

function notifyShowFixUnusual() {
  chrome.runtime.sendMessage({ type: "SHOW_FIX_UNUSUAL" }).catch(() => { });
}

function notifyShowFlowSignin() {
  chrome.runtime.sendMessage({ type: "SHOW_FLOW_SIGNIN" }).catch(() => { });
}

function notifyModelSwitched(from, to, model) {
  chrome.runtime.sendMessage({
    type: "MODEL_SWITCHED",
    from,
    to,
    model
  }).catch(() => { });
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateRandomSeed() {
  return Math.floor(Math.random() * 300000);
}

function generateUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function sanitizeFolderName(name) {
  return String(name || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 40) || "flow-images";
}

function sanitizePromptForFilename(text) {
  return String(text || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 30)
    .replace(/-+$/g, "") || "prompt";
}

function buildFilename(settings, promptIndex, slot, promptText) {
  const folder = sanitizeFolderName(settings.folder || "Flow_Images");
  const paddedIndex = String(promptIndex + 1).padStart(3, "0");
  const slotSuffix = slot > 0 ? `-${slot + 1}` : "";
  const name = settings.fileNaming === "prompt"
    ? `${paddedIndex}-${sanitizePromptForFilename(promptText)}${slotSuffix}`
    : `${paddedIndex}${slotSuffix}`;
  return `${folder}/${name}.png`;
}

function getModelDisplayName(model) {
  const names = {
    NARWHAL: "NB 2",
    GEM_PIX_2: "NB Pro",
    HARBOR_SEAL: "NB 2 Lite"
  };
  return names[model] || model;
}

let lastDownloadTime = 0;
let is2kWarningShown = false;
let batchProgress = { index: 0, total: 0 };
let retryCounters = { rateLimit: 0, quota: 0 };

function resetRetryCounters() {
  retryCounters = { rateLimit: 0, quota: 0 };
}

// ============================================================
// PROMPT GENERATION (AI Studio)
// ============================================================

const AI_PROVIDERS = {
  gemini: {
    name: "Gemini",
    host: "gemini.google.com",
    url: "https://gemini.google.com/app",
    editorSel: 'rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"]',
    sendSels: [
      'button[aria-label="Send message"]',
      'button[data-mat-icon-name="send"]',
      "button.send-button",
      '[data-testid="send-button"]'
    ],
    turnSel: "model-response",
    turnTextSels: [
      ".model-response-text",
      "message-content",
      ".response-content",
      '[class*="response-text"]'
    ],
    stopSel: 'button[aria-label="Stop response"], button[aria-label="Stop generating"], [data-testid="stop-button"]'
  },
  chatgpt: {
    name: "ChatGPT",
    host: "chatgpt.com",
    url: "https://chatgpt.com/",
    editorSel: 'div.ProseMirror#prompt-textarea[contenteditable="true"]',
    sendSels: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]'
    ],
    turnSel: '[data-message-author-role="assistant"]',
    turnTextSels: [
      ".markdown",
      ".prose",
      '[class*="markdown"]'
    ],
    stopSel: 'button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label*="Stop"]'
  }
};

function getProviderSteps(provider) {
  return [
    { key: "opening", label: `Opening ${provider.name}` },
    { key: "loading", label: `Loading ${provider.host}` },
    { key: "connecting", label: "Connecting to editor" },
    { key: "submitting", label: "Sending your prompt" },
    { key: "generating", label: `${provider.name} is writing` },
    { key: "extracting", label: "Reading response" }
  ];
}

function updateProgressIndicators(tabId, currentStep) {
  chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (step, steps) => {
      const stepIndex = steps.indexOf(step);

      steps.forEach((key, idx) => {
        const dot = document.getElementById(`__ov_dot_${key}__`);
        const text = document.getElementById(`__ov_text_${key}__`);
        const badge = document.getElementById(`__ov_badge_${key}__`);

        if (!dot || !text) return;

        if (idx < stepIndex) {
          // Completed step
          dot.style.cssText = "width:14px;height:14px;border-radius:50%;background:rgba(255,209,0,0.2);flex-shrink:0;display:flex;align-items:center;justify-content:center;";
          dot.innerHTML = '<svg width="8" height="8" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" style="stroke:var(--ovck)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          text.style.color = "var(--ovf)";
          text.style.textDecoration = "line-through";
          text.style.fontWeight = "normal";
          if (badge) badge.style.display = "none";
        } else if (idx === stepIndex) {
          // Current step
          dot.style.cssText = "width:14px;height:14px;border-radius:50%;background:#FFD100;box-shadow:0 0 8px rgba(255,209,0,0.55);flex-shrink:0;display:flex;align-items:center;justify-content:center;animation:ovPulse 1.2s ease-in-out infinite;";
          dot.innerHTML = "";
          text.style.color = "var(--ovt)";
          text.style.textDecoration = "none";
          text.style.fontWeight = "600";
          if (badge) {
            badge.style.color = "var(--ovck)";
            badge.style.background = "rgba(255,209,0,0.12)";
            badge.style.border = "1px solid rgba(255,209,0,0.35)";
            badge.style.display = "inline-block";
          }
        } else {
          // Pending step
          dot.style.cssText = "width:14px;height:14px;border-radius:50%;background:var(--ovi);flex-shrink:0;display:flex;align-items:center;justify-content:center;";
          dot.innerHTML = "";
          text.style.color = "var(--ovp)";
          text.style.textDecoration = "none";
          text.style.fontWeight = "normal";
          if (badge) badge.style.display = "none";
        }
      });
    },
    args: [currentStep, getProviderSteps(provider)]
  }).catch(() => { });
}

function createOverlay(tabId, provider, darkMode) {
  return chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (steps, providerName, isDark) => {
      if (document.getElementById("__oxymai_overlay__")) return;

      // Add styles
      const style = document.createElement("style");
      style.textContent = `
        @keyframes ovPulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.8); }
        }
        @keyframes ovDot {
          0%, 80%, 100% { opacity: 0.15; }
          40% { opacity: 1; }
        }
        @keyframes ovBlob {
          0%, 100% { border-radius: 60% 40% 55% 45% / 50% 60% 40% 50%; }
          25% { border-radius: 45% 55% 40% 60% / 60% 40% 55% 45%; }
          50% { border-radius: 50% 50% 60% 40% / 45% 55% 50% 50%; }
          75% { border-radius: 55% 45% 45% 55% / 55% 45% 60% 40%; }
        }
      `;
      (document.head || document.documentElement).appendChild(style);

      // Build steps HTML
      const stepsHtml = steps.map(({ key, label }) => `
        <div style="display:flex;align-items:center;gap:10px;">
          <div id="__ov_dot_${key}__" style="width:14px;height:14px;border-radius:50%;background:var(--ovi);flex-shrink:0;display:flex;align-items:center;justify-content:center;"></div>
          <span id="__ov_text_${key}__" style="font-size:13px;color:var(--ovp);font-family:system-ui,sans-serif;">${label}</span>
          <span id="__ov_badge_${key}__" style="display:none;font-size:10px;color:var(--ovck);background:rgba(255,209,0,0.12);border:1px solid rgba(255,209,0,0.35);border-radius:9999px;padding:1px 8px;font-family:system-ui,sans-serif;font-weight:700;">running</span>
        </div>
      `).join("");

      // Build overlay
      const overlay = document.createElement("div");
      overlay.id = "__oxymai_overlay__";

      // Apply theme variables
      const themeVars = isDark
        ? {
          "--ovt": "#f3f4f6",
          "--ovf": "rgba(255,255,255,0.40)",
          "--ovp": "rgba(255,255,255,0.25)",
          "--ovi": "rgba(255,255,255,0.08)",
          "--ovck": "#FFD100",
          "--ovcard": "rgba(255,255,255,0.06)",
          "--ovbrd": "rgba(255,255,255,0.08)"
        }
        : {
          "--ovt": "#111827",
          "--ovf": "rgba(17,24,39,0.40)",
          "--ovp": "rgba(17,24,39,0.30)",
          "--ovi": "rgba(17,24,39,0.08)",
          "--ovck": "#C4A400",
          "--ovcard": "#ffffff",
          "--ovbrd": "#f3f4f6"
        };

      Object.entries(themeVars).forEach(([key, value]) => {
        overlay.style.setProperty(key, value);
      });

      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        background: isDark
          ? "#0B0F19"
          : "#f9fafb",
        backgroundImage: isDark
          ? "radial-gradient(600px 400px at 85% -10%, rgba(255,209,0,0.06), transparent 60%), radial-gradient(500px 360px at -10% 110%, rgba(255,209,0,0.04), transparent 60%)"
          : "radial-gradient(600px 400px at 85% -10%, rgba(255,209,0,0.10), transparent 60%), radial-gradient(500px 360px at -10% 110%, rgba(255,209,0,0.07), transparent 60%)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "28px",
        pointerEvents: "all"
      });

      overlay.innerHTML = `
        <div style="display:flex;align-items:center;gap:14px;">
          <div style="position:relative;width:38px;height:38px;flex-shrink:0;">
            <div style="position:absolute;inset:0;background:#FFD100;opacity:0.4;filter:blur(6px);animation:ovBlob 4s ease-in-out infinite;border-radius:60% 40% 55% 45%/50% 60% 40% 50%;"></div>
            <div style="position:absolute;inset:4px;background:#FFD100;box-shadow:0 0 12px rgba(255,209,0,0.5);animation:ovBlob 3s ease-in-out infinite;border-radius:55% 45% 50% 50%/45% 55% 50% 50%;"></div>
          </div>
          <div style="display:flex;flex-direction:column;gap:2px;">
            <div style="display:flex;align-items:baseline;">
              <span style="font-size:18px;font-weight:800;font-family:system-ui,sans-serif;color:var(--ovt);letter-spacing:-0.01em;">Crafting your prompts</span>
              <span style="font-size:18px;font-weight:800;font-family:system-ui,sans-serif;display:inline-flex;gap:1px;margin-left:2px;color:#FFD100;">
                <span style="animation:ovDot 1.4s ease-in-out infinite;animation-delay:0s;">.</span>
                <span style="animation:ovDot 1.4s ease-in-out infinite;animation-delay:0.2s;">.</span>
                <span style="animation:ovDot 1.4s ease-in-out infinite;animation-delay:0.4s;">.</span>
              </span>
            </div>
            <span style="font-size:11px;font-family:system-ui,sans-serif;color:var(--ovf);letter-spacing:0.04em;">Whisk Automator · Powered by ${providerName}</span>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;align-items:flex-start;background:var(--ovcard);border:1px solid var(--ovbrd);border-radius:24px;padding:18px 22px;${isDark ? "" : "box-shadow:0 8px 30px rgba(0,0,0,0.04);"}">${stepsHtml}</div>
      `;

      document.documentElement.appendChild(overlay);
    },
    args: [getProviderSteps(provider), provider.name, !!darkMode]
  }).catch(() => { });
}

// ============================================================
// PROMPT GENERATION - POPUP WINDOW
// ============================================================

async function openProviderPopup(state, onProgress) {
  const provider = AI_PROVIDERS[state.provider];
  onProgress("opening");

  try {
    const window = await chrome.windows.create({
      url: provider.url,
      type: "popup",
      focused: false,
      width: 1024,
      height: 768
    });

    state.tabId = window.tabs?.[0]?.id;
    state.winId = window.id;

    if (!state.tabId) {
      throw new Error("Popup window created but tab ID unavailable.");
    }

    // Minimize window to load in background
    chrome.windows.update(state.winId, { state: "minimized" }).catch(() => { });

    onProgress("loading");

    // Wait for tab to load
    await new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      }, 25000);

      const listener = (tabId, changeInfo) => {
        if (tabId !== state.tabId || changeInfo.status !== "complete") return;
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };

      chrome.tabs.onUpdated.addListener(listener);
    });

    // Get dark mode preference
    const { darkMode } = await chrome.storage.local.get("darkMode").catch(() => ({}));

    // Create the overlay
    await createOverlay(state.tabId, provider, !!darkMode);

    onProgress("connecting");

    // Wait a moment for overlay to render
    await new Promise(resolve => setTimeout(resolve, 3500));

    // Focus the window
    await chrome.windows.update(state.winId, { state: "normal", focused: true }).catch(() => { });

    // Focus guard - keep window focused
    state.focusGuard = (windowId) => {
      if (state.winId && windowId !== state.winId) {
        chrome.windows.update(state.winId, { state: "normal", focused: true }).catch(() => { });
      }
    };
    chrome.windows.onFocusChanged.addListener(state.focusGuard);

    // Keep-alive - ensure window stays normal
    state.keepAlive = setInterval(() => {
      if (state.winId) {
        chrome.windows.get(state.winId).then((win) => {
          if (win.state === "minimized") {
            chrome.windows.update(state.winId, { state: "normal", focused: true }).catch(() => { });
          }
        }).catch(() => { });
      }
    }, 2000);

    return { success: true };

  } catch (error) {
    // Clean up on error
    if (state.winId) {
      chrome.windows.remove(state.winId).catch(() => { });
    }
    state.winId = null;
    state.tabId = null;
    return { success: false, error: `Could not open ${provider.name} popup: ${error.message}` };
  }
}

async function sendPromptAndGetResponse(state, prompt, onProgress) {
  const provider = AI_PROVIDERS[state.provider];

  try {
    onProgress("submitting");

    const result = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      world: "ISOLATED",
      func: async (promptText, editorSel, sendSels, turnSel, hostName) => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        // Find editor
        let editor = null;
        for (let attempt = 0; attempt < 40; attempt++) {
          editor = document.querySelector(editorSel);
          if (editor) break;
          await sleep(500);
        }

        if (!editor) {
          return { success: false, error: `Editor not found. Make sure you are logged in to ${hostName}.` };
        }

        // Insert text
        editor.focus();
        await sleep(200);

        document.execCommand("selectAll", false, null);
        await sleep(100);
        document.execCommand("insertText", false, promptText);
        await sleep(500);

        // Fallback: paste if execCommand didn't work
        if (!editor.textContent.trim()) {
          const clipboardData = new DataTransfer();
          clipboardData.setData("text/plain", promptText);
          editor.dispatchEvent(new ClipboardEvent("paste", {
            clipboardData,
            bubbles: true,
            cancelable: true
          }));
          await sleep(500);
        }

        if (!editor.textContent.trim()) {
          return { success: false, error: "Failed to inject text into the editor." };
        }

        // Find and click send button
        const priorTurns = document.querySelectorAll(turnSel).length;
        let sendButton = null;
        for (const sel of sendSels) {
          sendButton = document.querySelector(sel);
          if (sendButton) break;
        }

        if (sendButton && !sendButton.disabled) {
          sendButton.click();
        } else {
          // Fallback: Enter key
          const event = {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true
          };
          editor.dispatchEvent(new KeyboardEvent("keydown", event));
          await sleep(50);
          editor.dispatchEvent(new KeyboardEvent("keyup", event));
        }

        await sleep(300);
        return { success: true, priorTurns };
      },
      args: [prompt, provider.editorSel, provider.sendSels, provider.turnSel, provider.host]
    });

    const injectResult = result?.[0]?.result;
    if (!injectResult?.success) {
      return injectResult || { success: false, error: "Injection script failed." };
    }

    onProgress("generating");

    // Poll for response
    const responseResult = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      world: "ISOLATED",
      func: async (priorTurns, turnSel, turnTextSels, stopSel) => {
        const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        const getResponseText = () => {
          const turns = document.querySelectorAll(turnSel);
          if (turns.length <= priorTurns) return "";

          const latestTurn = turns[turns.length - 1];
          let text = null;
          for (const sel of turnTextSels) {
            const element = latestTurn.querySelector(sel);
            if (element) {
              text = element.innerText?.trim() || "";
              break;
            }
          }
          return text || latestTurn.innerText?.trim() || "";
        };

        const isStopButtonVisible = () => {
          return !!document.querySelector(stopSel);
        };

        await sleep(2000);

        let lastText = "";
        let stableCount = 0;
        let responseText = "";

        for (let attempt = 0; attempt < 360; attempt++) {
          await sleep(500);

          const stopVisible = isStopButtonVisible();
          const currentText = getResponseText();

          if (currentText !== lastText) {
            lastText = currentText;
            stableCount = 0;
          } else if (currentText) {
            stableCount++;
          }

          if (!stopVisible && stableCount >= 4 && currentText) {
            responseText = currentText;
            break;
          }
        }

        return responseText
          ? { success: true, text: responseText }
          : { success: false, error: "Timed out waiting for the response. Make sure you are logged in and try again." };
      },
      args: [injectResult.priorTurns, provider.turnSel, provider.turnTextSels, provider.stopSel]
    });

    onProgress("extracting");
    return responseResult?.[0]?.result || { success: false, error: "No result from polling script." };

  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================================
// PROMPT GENERATION - CONNECTION HANDLER
// ============================================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "promptGen") return;

  const state = {
    provider: "gemini",
    tabId: null,
    winId: null,
    keepAlive: null,
    focusGuard: null,
    opening: null
  };

  const sendProgress = (step) => {
    try {
      port.postMessage({ type: "progress", stage: step });
    } catch { }
    updateProgressIndicators(state.tabId, step);
  };

  const cleanup = () => {
    if (state.keepAlive) {
      clearInterval(state.keepAlive);
      state.keepAlive = null;
    }
    if (state.focusGuard) {
      try {
        chrome.windows.onFocusChanged.removeListener(state.focusGuard);
      } catch { }
      state.focusGuard = null;
    }
    if (state.winId) {
      chrome.windows.remove(state.winId).catch(() => { });
      state.winId = null;
      state.tabId = null;
    }
  };

  port.onDisconnect.addListener(cleanup);

  const sendResponse = (data) => {
    try {
      port.postMessage(data);
    } catch {
      cleanup();
    }
  };

  port.onMessage.addListener(async (message) => {
    if (message?.action === "open") {
      // Prevent multiple simultaneous opens
      if (state.opening) {
        await state.opening;
      }

      // Reuse existing session if still open
      if (state.tabId) {
        sendResponse({ type: "opened", success: true });
        return;
      }

      state.provider = AI_PROVIDERS[message.provider] ? message.provider : "gemini";
      state.opening = openProviderPopup(state, sendProgress);
      const result = await state.opening;
      state.opening = null;
      sendResponse({ type: "opened", ...result });
      return;
    }

    if (message?.action === "send") {
      if (!state.tabId) {
        sendResponse({
          type: "result",
          reqId: message.reqId,
          success: false,
          error: "Session not open."
        });
        return;
      }

      // Check if tab still exists
      const tabExists = await chrome.tabs.get(state.tabId).then(() => true).catch(() => false);
      if (!tabExists) {
        state.tabId = null;
        state.winId = null;
        sendResponse({
          type: "result",
          reqId: message.reqId,
          success: false,
          error: `${AI_PROVIDERS[state.provider].name} window was closed. Start again to continue.`
        });
        return;
      }

      const result = await sendPromptAndGetResponse(state, message.prompt, sendProgress);
      sendResponse({ type: "result", reqId: message.reqId, ...result });
      return;
    }

    if (message?.action === "close") {
      cleanup();
    }
  });
});

// ============================================================
// BACKGROUND SCRIPT ENTRY POINT
// ============================================================

const backgroundScript = normalizeScriptDefinition({
  type: "module",
  main: () => {
    // WXT plugin initialization (stripped in production)
  }
});

// Initialize
try {
  initializeWXTPlugins();
  const result = backgroundScript.main();
  if (result instanceof Promise) {
    console.warn("The background's main() function returned a promise, but it must be synchronous");
  }
} catch (error) {
  console.error("The background crashed on startup!", error);
  throw error;
}