// ==UserScript==
// @ignorecache
// @name          Zen Tab Grouping
// @description   AI-powered tab sorting and grouping for Zen Browser
// ==/UserScript==

(() => {
  const DEFAULT_CONFIG = {
    // Single user-facing knob. 0 = conservative (tabs only group when
    // very similar); 1 = aggressive (loosely-related tabs still group).
    // All internal thresholds below are derived from this value — see
    // `deriveGroupingThresholds` after CONFIG load.
    GROUPING_STRENGTH: 0.5,
    // Derived thresholds (overwritten post-load). Kept in CONFIG so the
    // rest of the file can reference them without a separate object.
    SIMILARITY_THRESHOLD: 0.475,
    GROUP_SIMILARITY_THRESHOLD: 0.475,
    FUZZY_CLUSTER_THRESHOLD: 0.265,
    MAX_INIT_CHECKS: 50,
    INIT_CHECK_INTERVAL: 100,
    CONSOLIDATION_DISTANCE_THRESHOLD: 2,
    EMBEDDING_BATCH_SIZE: 5,
    EXISTING_GROUP_BOOST: 0.1, // Boost similarity score for existing groups to prefer them
    REORDER_GROUPS_FIRST: true,
    ENABLE_FAILURE_ANIMATION: true,
    FAILURE_AMPLITUDE: 8,
    FAILURE_FREQUENCY: 20,
    FAILURE_SEGMENTS: 100,
    FAILURE_PULSE_DURATION: 400,
    FAILURE_PULSE_COUNT: 3,
    ENABLE_CLEAR_BUTTON_PATCH: true,
    // Per-menu-item visibility. Users can hide either entry if they only
    // use one container style.
    MENU_SORT_GROUPS: true,
    MENU_SORT_FOLDERS: true,
    // After AI/fuzzy, any tabs that didn't land in a group are bucketed
    // into a single "Miscellaneous" group so nothing is left stranded.
    // Turn off if you prefer leftovers to stay loose in the sidebar.
    GROUP_LEFTOVERS_AS_MISC: true,
    // Single-dropdown grouping engine. Each option is independent:
    //   local      -> Firefox on-device ML only
    //   openrouter -> OpenRouter LLM only (needs model + API key)
    //   fuzzy      -> deterministic token/hostname clustering only
    //   hybrid     -> tries OpenRouter, then local AI, then fuzzy
    // No cross-category silent fallbacks for non-hybrid modes.
    GROUPING_ENGINE: "hybrid",
    // OpenRouter model slug (separate from engine choice so the dropdown
    // never mixes "local" with API-key model names).
    OPENROUTER_MODEL: "ling-flash",
    // OpenRouter API key. Empty string disables the OpenRouter path.
    OPENROUTER_API_KEY: "",
    // Optional comma/newline-separated host list that should stay loose
    // (never auto-grouped), e.g. "mail.google.com, calendar.google.com".
    PROTECTED_HOSTS: "",
  };

  const hasMeaningfulTitleSignal = (title) => {
    const normalized = (title || "").toString().trim().toLowerCase();
    if (!normalized || LOW_SIGNAL_TITLES.has(normalized)) return false;
    if (normalized.length < 5) return false;
    if (normalized.startsWith("http:") || normalized.startsWith("https:")) {
      return false;
    }
    // Host-only placeholders like "github.com" or "mail.google.com"
    // usually came from URL fallback, so they carry weak topical signal.
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(normalized)) {
      return false;
    }
    return true;
  };

  const getTitleSignalStats = (tabs) => {
    const validTabs = (tabs || []).filter((tab) => tab?.isConnected);
    if (!validTabs.length) {
      return { total: 0, meaningful: 0, ratio: 0 };
    }
    const meaningful = validTabs.reduce((count, tab) => {
      return count + (hasMeaningfulTitleSignal(getTabTitle(tab)) ? 1 : 0);
    }, 0);
    return {
      total: validTabs.length,
      meaningful,
      ratio: meaningful / validTabs.length,
    };
  };

  // Return the user-selected engine from the dropdown. If the selected
  // engine is unavailable (e.g. "local" but browser.ml.enabled is off,
  // or "openrouter" but no API key), returns "none" so the caller can
  // surface a clear failure. Hybrid is always considered available because
  // it contains its own fallback chain.
  const getSelectedEngine = () => {
    const choice = (CONFIG.GROUPING_ENGINE || "hybrid").trim().toLowerCase();
    if (choice === "hybrid") return "hybrid";
    if (choice === "local") return isAIEnabled() ? "local-ai" : "none";
    if (choice === "openrouter") return isOpenRouterConfigured() ? "openrouter" : "none";
    if (choice === "fuzzy") return "fuzzy";
    return "none";
  };

  // Short dropdown slug -> OpenRouter model ID. Slugs are used as the pref
  // value (safer across Zen's dropdown schema than slashes/colons), and the
  // mapped ID is what we send in the API request body.
  //
  // Picks (researched Apr 2026 against openrouter.ai/collections/free-models
  // for this specific use case — short topic-label generation from tab titles):
  //   - ling-flash:   explicitly "flash" model (7.4B active), lowest latency
  //   - glm-air:      lightweight MoE with hybrid inference (reasoning field)
  const OPENROUTER_MODELS = {
    "ling-flash": "inclusionai/ling-2.6-flash:free",
    "glm-air": "z-ai/glm-4.5-air:free",
  };

  const PREF_BRANCH = "zen.tidytabs.";
  const PREFS = {
    GROUPING_STRENGTH: ["double", "grouping-strength"],
    ENABLE_FAILURE_ANIMATION: ["bool", "ui.enable-failure-animation"],
    ENABLE_CLEAR_BUTTON_PATCH: ["bool", "behavior.patch-clear-button"],
    MENU_SORT_GROUPS: ["bool", "menu.sort-groups"],
    MENU_SORT_FOLDERS: ["bool", "menu.sort-folders"],
    GROUP_LEFTOVERS_AS_MISC: ["bool", "group-leftovers-as-misc"],
    GROUPING_ENGINE: ["string", "grouping-engine"],
    OPENROUTER_MODEL: ["string", "openrouter.model"],
    OPENROUTER_API_KEY: ["string", "openrouter.api-key"],
    PROTECTED_HOSTS: ["string", "behavior.protected-hosts"],
  };

  const services =
    globalThis.Services ??
    ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs")
      .Services;

  const getPrefValue = (type, fullPrefName, fallbackValue) => {
    // The Zen mod marketplace only exposes checkbox / dropdown / string input
    // types, so numeric settings are stored as PREF_STRING when set via the
    // settings UI. Fall back to the native-typed getter for prefs authored
    // via about:config or older builds.
    try {
      const prefs = services?.prefs;
      if (!prefs?.prefHasUserValue(fullPrefName)) {
        return fallbackValue;
      }

      const prefType = prefs.getPrefType(fullPrefName);
      const PREF_BOOL = prefs.PREF_BOOL ?? 128;
      const PREF_INT = prefs.PREF_INT ?? 64;
      const PREF_STRING = prefs.PREF_STRING ?? 32;

      const readString = () => {
        try {
          return prefs.getStringPref(fullPrefName, `${fallbackValue}`);
        } catch {
          return `${fallbackValue}`;
        }
      };

      if (type === "string") {
        return readString();
      }

      if (type === "bool") {
        if (prefType === PREF_BOOL) {
          return prefs.getBoolPref(fullPrefName, fallbackValue);
        }
        if (prefType === PREF_STRING) {
          const raw = readString().trim().toLowerCase();
          if (raw === "true" || raw === "1") return true;
          if (raw === "false" || raw === "0") return false;
        }
        return fallbackValue;
      }

      if (type === "int" || type === "double") {
        let raw;
        if (prefType === PREF_INT) {
          raw = prefs.getIntPref(fullPrefName, fallbackValue);
        } else if (prefType === PREF_STRING) {
          raw = readString();
        } else if (
          type === "double" &&
          typeof prefs.getFloatPref === "function"
        ) {
          raw = prefs.getFloatPref(fullPrefName, fallbackValue);
        } else {
          return fallbackValue;
        }
        const parsed =
          type === "int"
            ? Number.parseInt(raw, 10)
            : Number.parseFloat(raw);
        return Number.isFinite(parsed) ? parsed : fallbackValue;
      }
    } catch (error) {
      console.warn(`[TidyTabs] Failed reading pref ${fullPrefName}:`, error);
    }
    return fallbackValue;
  };

  const loadRuntimeConfig = () => {
    const mergedConfig = { ...DEFAULT_CONFIG };
    Object.entries(PREFS).forEach(([key, [type, prefSuffix]]) => {
      const prefName = `${PREF_BRANCH}${prefSuffix}`;
      mergedConfig[key] = getPrefValue(type, prefName, DEFAULT_CONFIG[key]);
    });
    return mergedConfig;
  };

  // Map the user-facing 0..1 strength onto the internal metric thresholds
  // that actually drive clustering. Each metric has its own sensible
  // range (cosine similarity clusters at ~0.2..0.75; weighted-Jaccard at
  // ~0.08..0.45), so we linearly interpolate the FROM/TO for each.
  //
  // strength = 0 → very strict (only near-duplicate tabs cluster)
  // strength = 1 → very loose (loosely-related tabs still cluster)
  //
  // This inverts the intuition of raw cosine-threshold because users kept
  // expecting "bigger number → more grouping", which is the opposite of
  // what a raw similarity threshold does.
  const deriveGroupingThresholds = (config) => {
    const raw = Number(config.GROUPING_STRENGTH);
    const s = Math.max(0, Math.min(1, Number.isFinite(raw) ? raw : 0.5));
    config.GROUPING_STRENGTH = s;
    config.SIMILARITY_THRESHOLD = 0.75 - s * 0.55;       // 0.75 → 0.20
    config.GROUP_SIMILARITY_THRESHOLD = 0.70 - s * 0.45; // 0.70 → 0.25
    config.FUZZY_CLUSTER_THRESHOLD = 0.45 - s * 0.37;    // 0.45 → 0.08
  };

  const CONFIG = loadRuntimeConfig();
  deriveGroupingThresholds(CONFIG);

  const normalizeHost = (host) => {
    if (!host || typeof host !== "string") return "";
    return host
      .trim()
      .toLowerCase()
      .replace(/^\*\./, "")
      .replace(/^\./, "")
      .replace(/^www\./, "");
  };

  const parseHostListPref = (raw) => {
    if (!raw || typeof raw !== "string") return new Set();
    return new Set(
      raw
        .split(/[\n,]/)
        .map((entry) => normalizeHost(entry))
        .filter(Boolean)
    );
  };

  const PROTECTED_HOSTS = parseHostListPref(CONFIG.PROTECTED_HOSTS);
  const PROTECTED_HOST_PATTERNS = [...PROTECTED_HOSTS];
  const isProtectedHost = (host) => {
    const normalizedHost = normalizeHost(host);
    if (!normalizedHost || PROTECTED_HOST_PATTERNS.length === 0) return false;
    return PROTECTED_HOST_PATTERNS.some(
      (blocked) => normalizedHost === blocked || normalizedHost.endsWith(`.${blocked}`)
    );
  };
  const shouldProtectTabFromGrouping = (tab) => isProtectedHost(getTabHost(tab));

  // When there are lots of tabs or mostly low-signal titles ("Untitled",
  // host-only placeholders, etc.), deterministic fuzzy grouping is usually
  // more reliable/fast than model-based grouping.
  const MAX_TABS_FOR_MODEL_GROUPING = 120;
  const MIN_TITLE_SIGNAL_RATIO_FOR_MODEL_GROUPING = 0.34;
  const LOW_SIGNAL_TITLES = new Set([
    "new tab",
    "about:blank",
    "loading...",
    "untitled page",
    "invalid tab",
    "error processing tab",
  ]);

  // --- Globals & State ---
  let isSorting = false;
  let isPlayingFailureAnimation = false;
  let sortAnimationId = null;
  let eventListenersAdded = false;
  let sidebarMenuListenersAdded = false;
  let sidebarPopupShowingHandler = null;
  let sidebarContextMenuHandler = null;

  let originalCloseAllUnpinnedTabs = null;
  let clearButtonPatched = false;

  let gZenWorkspaceHooksApplied = false;
  let originalWorkspaceOnTabBrowserInserted = null;
  let originalWorkspaceUpdateTabsContainers = null;

  let embeddingEnginePromise = null;
  let namingEnginePromise = null;
  const EMBEDDING_CACHE_LIMIT = 400;
  const EMBEDDING_CACHE = new Map();

  let faviconRefreshRaf = null;
  let faviconRefreshInFlight = false;
  let faviconRefreshPending = false;

  const GROUP_NODE_SELECTOR = ":is(tab-group, zen-folder)";

  const TAB_CONTAINER_EVENTS = [
    "TabOpen",
    "TabClose",
    "TabSelect",
    "TabPinned",
    "TabUnpinned",
    "TabGroupAdd",
    "TabGroupRemove",
    "TabGrouped",
    "TabUngrouped",
    "TabAttrModified",
    "TabMove",
  ];
  let tabContainerEventHandler = null;

  // DOM Cache for performance
  const domCache = {
    separators: null,

    getSeparators() {
      if (!this.separators || !this.separators.length) {
        this.separators = document.querySelectorAll(
          ".pinned-tabs-container-separator"
        );
      }
      return this.separators;
    },

    invalidate() {
      this.separators = null;
    },
  };

  // --- Helper Functions ---

  // Optimized tab filtering function
  const getFilteredTabs = (workspaceId, options = {}) => {
    if (!workspaceId || typeof gBrowser === "undefined" || !gBrowser.tabs) {
      return [];
    }

    const {
      includeGrouped = false,
      includeSelected = true,
      includePinned = false,
      includeEmpty = false,
      includeGlance = false,
    } = options;

    return Array.from(gBrowser.tabs).filter((tab) => {
      if (!tab?.isConnected) return false;

      const isInCorrectWorkspace =
        tab.getAttribute("zen-workspace-id") === workspaceId;
      if (!isInCorrectWorkspace) return false;

      const groupParent =
        tab.group ?? tab.closest(":is(tab-group, zen-folder)");
      const isInGroup = !!groupParent;

      return (
        (includePinned || !tab.pinned) &&
        (includeGrouped || !isInGroup) &&
        (includeSelected || !tab.selected) &&
        (includeEmpty || !tab.hasAttribute("zen-empty-tab")) &&
        (includeGlance || !tab.hasAttribute("zen-glance-tab"))
      );
    });
  };

  const getTabTitle = (tab) => {
    if (!tab?.isConnected) {
      return "Invalid Tab";
    }
    try {
      const originalTitle =
        tab.getAttribute("label") ||
        tab.querySelector(".tab-label, .tab-text")?.textContent ||
        "";

      if (
        !originalTitle ||
        originalTitle === "New Tab" ||
        originalTitle === "about:blank" ||
        originalTitle === "Loading..." ||
        originalTitle.startsWith("http:") ||
        originalTitle.startsWith("https:")
      ) {
        const browser =
          tab.linkedBrowser ||
          tab._linkedBrowser ||
          gBrowser?.getBrowserForTab?.(tab);

        if (
          browser?.currentURI?.spec &&
          !browser.currentURI.spec.startsWith("about:")
        ) {
          try {
            const currentURL = new URL(browser.currentURI.spec);
            const hostname = currentURL.hostname.replace(/^www\./, "");
            if (
              hostname &&
              hostname !== "localhost" &&
              hostname !== "127.0.0.1"
            ) {
              return hostname;
            }
            const pathSegment = currentURL.pathname.split("/")[1];
            if (pathSegment) return pathSegment;
          } catch {
            /* ignore */
          }
        }
        return "Untitled Page";
      }
      return originalTitle.trim() || "Untitled Page";
    } catch (e) {
      console.error("Error getting tab title for tab:", tab, e);
      return "Error Processing Tab";
    }
  };

  const toTitleCase = (str) => {
    if (!str || typeof str !== "string") return "";
    return str
      .toLowerCase()
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  // Shared post-processor for AI-generated group names (both local and
  // OpenRouter paths). Collapses whitespace, strips wrapping punctuation,
  // rejects unsafe / empty outputs, and caps length so groups stay legible.
  // `fallbackTitles` is used when the model's answer is unusable — we pull
  // the first meaningful chunk of the first title as a last resort.
  const sanitizeGroupName = (rawName, fallbackTitles = []) => {
    let name = (rawName || "").toString().split("\n").map((l) => l.trim()).find((l) => l) || "";
    name = toTitleCase(name);
    if (!name || /none|adult content/i.test(name)) {
      const first = (fallbackTitles[0] || "").toString();
      name = first.split("–")[0].trim().slice(0, 24);
    }
    name = name
      .replace(/^['"`]+|['"`]+$/g, "")
      .replace(/[.?!,:;]+$/, "")
      .slice(0, 24);
    return name || "Group";
  };

  // Sanitize a path like "Development → Frontend" by cleaning each segment
  // independently so the arrow delimiter and overall structure survive.
  const sanitizeGroupPath = (rawPath) => {
    if (!rawPath.includes(" → ")) {
      return sanitizeGroupName(rawPath);
    }
    return rawPath
      .split(" → ")
      .map((segment) => sanitizeGroupName(segment.trim()))
      .join(" → ");
  };

  // True iff the user has both picked a non-"local" OpenRouter model AND
  // supplied an API key. Cheap guard so call sites can short-circuit before
  // building prompts or engine state.
  // Convert a potentially nested grouping JSON into flat "Parent → Child" keys.
  // This preserves nesting info in the key name while keeping the rest of
  // the pipeline (rescue passes, dedupe logic, existing-group matching) unchanged.
  const NESTED_GROUP_DELIMITER = " → ";
  const flattenNestedGroups = (parsed) => {
    const result = {};
    const walk = (obj, parentPath = "") => {
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = parentPath ? `${parentPath}${NESTED_GROUP_DELIMITER}${key}` : key;
        if (Array.isArray(value)) {
          result[currentPath] = value;
        } else if (value && typeof value === "object") {
          walk(value, currentPath);
        }
      }
    };
    walk(parsed);
    return result;
  };

  const isOpenRouterConfigured = () => {
    const slug = (CONFIG.OPENROUTER_MODEL || "").trim();
    if (!slug || !OPENROUTER_MODELS[slug]) return false;
    return !!(CONFIG.OPENROUTER_API_KEY || "").trim();
  };

  // Defensively extract a JSON object from a possibly-decorated model
  // response. Free models occasionally wrap output in markdown fences or
  // tack on trailing commentary — we strip both, then grab the outermost
  // {...} slice and try JSON.parse. Returns null on any failure rather
  // than throwing so callers can fall through to fuzzy grouping.
  const parseGroupingJson = (text) => {
    if (!text || typeof text !== "string") return null;
    let cleaned = text.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) cleaned = fenceMatch[1].trim();
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed
        : null;
    } catch (e) {
      console.warn("[TabSort][OpenRouter] JSON parse failed:", e);
      return null;
    }
  };

  // One-shot full-pipeline grouping via OpenRouter. Instead of N embedding
  // calls + N naming calls, we send the entire loose-tab list once and let
  // the model decide both (a) which tabs cluster together and (b) what to
  // name each cluster. Returns a `{ topicName: [tab, tab, ...] }` map on
  // success (same shape as `fuzzyGroupByTokens`) or null on any failure so
  // the caller can degrade to fuzzy grouping.
  //
  // Chrome-privileged fetch: this script runs as a user chrome script, so
  // it can reach arbitrary origins without CSP restrictions. We still set a
  // 20s timeout via AbortController — full-grouping responses are larger
  // than single-label responses, so the ceiling is higher than naming-only.
  //
  // Privacy: we send title + hostname only. Full URLs (path + query) are
  // deliberately excluded to avoid leaking viewing history.
  const askOpenRouterForGroups = async (tabs, existingGroupNames, useFolders = false) => {
    if (!isOpenRouterConfigured()) return null;

    const validTabs = (tabs || []).filter((t) => t?.isConnected);
    if (validTabs.length < 2) return null; // nothing meaningful to cluster

    const modelSlug = (CONFIG.OPENROUTER_MODEL || "").trim();
    const modelId = OPENROUTER_MODELS[modelSlug];
    const apiKey = (CONFIG.OPENROUTER_API_KEY || "").trim();

    // Numbered list keeps the contract tight: "give me back these numbers".
    // Numbers are way more reliable than asking the model to echo titles
    // (which it will paraphrase, truncate, or case-change).
    const lines = validTabs.map((tab, i) => {
      const title = (getTabTitle(tab) || "Untitled").slice(0, 140);
      const host = getTabHost(tab) || "—";
      // Hostname is secondary context — put it at the end so the model
      // focuses on the title's semantic topic, not the domain.
      return `${i + 1}. ${title}  (${host})`;
    });

    const existingHint =
      existingGroupNames && existingGroupNames.size > 0
        ? `\n\nExisting groups in this workspace (REUSE these names when tabs fit): ${[
            ...existingGroupNames,
          ].join(", ")}`
        : "";

    const systemPrompt = useFolders
  ? `You are a tab-topic classifier. Group tabs by CONTEXUAL SEMANTIC TOPIC only. Never by hostname or domain.

      Output format — FLAT (default): {"Topic": [1,2], "Other": [3,4]}
      Output format — NESTED (only when needed): {"Broad": {"Sub A": [1,2], "Sub B": [3,4]}, "Flat": [5,6]}

      Naming rules:
      - Use the specific subject from the tab title (e.g. "Pan Pizza", "React Router", "Tokyo Trip")
      - Never use generic labels: Cooking, Gaming, Travel, Dev, Work, Productivity, Learning
      - Never use website or domain names (just for you understand what user is doing in their broswer)

      Grouping rules:
      - Minimum 2 tabs per group. Omit solo tabs.
      - Same host ≠ same group. Different hosts ≠ different groups. Topic is the only signal.

      Nesting rules (prefer flat):
      - Only nest when a broad theme has 2+ sub-themes with 2+ tabs each (4+ tabs total under that parent)
      - A sub-theme with 1 tab → keep flat or omit
      - A parent with 1 child → keep flat
      - Max 2 levels deep

      Output: raw JSON only. No markdown, no prose, no explanation.`

        : `You are a tab-topic classifier. Group tabs by SEMANTIC TOPIC only. Never by hostname or domain.

      Output format: {"Topic": [1,2], "Other": [3,4]}

      Naming rules:
      - Use the specific subject from the tab title (e.g. "Pan Pizza", "React Router", "Tokyo Trip")
      - Never use generic labels: Cooking, Gaming, Travel, Dev, Work, Productivity, Learning
      - Never use website or domain names

      Grouping rules:
      - Minimum 2 tabs per group. Omit solo tabs.
      - Same host ≠ same group. Different hosts ≠ different groups. Topic is the only signal. (Hostname is just for you understand what user is doing in their broswer)
      - Each tab appears at most once.

      Output: raw JSON only. No markdown, no prose, no explanation.`;

    const userPrompt = `${lines.join("\n")}${existingHint}\n\nJSON:`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      const body = {
        model: modelId,
        // Output is bounded roughly by (groups * ~30 chars) + tab numbers;
        // 1024 is comfortable headroom for ~100 tabs across ~20 groups.
        max_tokens: 1024,
        temperature: 0.3,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      };

      const response = await fetch(
        "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            // Identifies this mod in OpenRouter's rankings (optional).
            "HTTP-Referer": "https://github.com/aree6/Zen-Tidy-Tabs",
            "X-OpenRouter-Title": "Zen Tidy Tabs",
          },
          body: JSON.stringify(body),
        }
      );

      if (!response.ok) {
        console.warn(
          `[TabSort][OpenRouter] HTTP ${response.status} from ${modelId}; falling back to fuzzy.`
        );
        return null;
      }

      const json = await response.json();
      const content = json?.choices?.[0]?.message?.content || json?.choices?.[0]?.message?.reasoning;
      const parsed = parseGroupingJson(content);
      if (!parsed) return null;
      const flatGroups = flattenNestedGroups(parsed);
      if (Object.keys(flatGroups).length === 0) return null;

      // Map 1-based indices back to real tab objects. We also dedupe in
      // case the model accidentally lists a tab under two topics; first
      // assignment wins so output is stable.
      const assignedTabs = new Set();
      const result = {};

      for (const [rawName, indices] of Object.entries(flatGroups)) {
        if (!Array.isArray(indices)) continue;
        const cleanName = sanitizeGroupPath(rawName);
        if (!cleanName) continue;

        const tabsForGroup = [];
        for (const raw of indices) {
          const n = Number.parseInt(raw, 10);
          if (!Number.isInteger(n) || n < 1 || n > validTabs.length) continue;
          const tab = validTabs[n - 1];
          if (!tab?.isConnected || assignedTabs.has(tab)) continue;
          assignedTabs.add(tab);
          tabsForGroup.push(tab);
        }
        if (tabsForGroup.length === 0) continue;

        // If the model reused a name with different casing vs. an existing
        // group, prefer the existing casing so we merge cleanly.
        const finalName = [...(existingGroupNames || [])].find(
          (existing) => existing.toLowerCase() === cleanName.toLowerCase()
        ) || cleanName;

        result[finalName] = (result[finalName] || []).concat(tabsForGroup);
      }

      const groupCount = Object.keys(result).length;
      console.log(
        `[TabSort][OpenRouter] ${modelId} grouped ${assignedTabs.size}/${validTabs.length} tabs into ${groupCount} groups.`
      );
      return groupCount > 0 ? result : null;
    } catch (e) {
      console.warn(
        `[TabSort][OpenRouter] Request failed for ${modelId}; falling back to fuzzy.`,
        e
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const levenshteinDistance = (a, b) => {
    if (!a || !b || typeof a !== "string" || typeof b !== "string") {
      return Math.max(a?.length ?? 0, b?.length ?? 0);
    }
    a = a.toLowerCase();
    b = b.toLowerCase();
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1, // Deletion
          matrix[i][j - 1] + 1, // Insertion
          matrix[i - 1][j - 1] + cost // Substitution
        );
      }
    }
    return matrix[b.length][a.length];
  };

  const escapeForAttrSelector = (value) => {
    const str = (value ?? "").toString();
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
      return CSS.escape(str);
    }
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  };

  const isFolderGroupElement = (groupEl) => {
    if (!groupEl) return false;
    const tag = groupEl.tagName?.toLowerCase();
    return !!groupEl.isZenFolder || tag === "zen-folder";
  };

  const getTabContainerGroup = (tab) =>
    tab?.group ?? tab?.closest?.(GROUP_NODE_SELECTOR) ?? null;

  const isGroupInWorkspace = (groupEl, workspaceId) => {
    if (!groupEl?.isConnected || !workspaceId) return false;
    if (groupEl.getAttribute("zen-workspace-id") === workspaceId) return true;
    return Array.from(groupEl.querySelectorAll("tab")).some(
      (tab) => tab.getAttribute("zen-workspace-id") === workspaceId
    );
  };

  const isTabInWorkspaceGroup = (tab, workspaceId) =>
    isGroupInWorkspace(getTabContainerGroup(tab), workspaceId);

  const getLabelKey = (label) => (label || "").trim().toLowerCase();

  const upsertContainerByLabel = (containerMap, label, kind, element) => {
    if (!(containerMap instanceof Map) || !element?.isConnected) return;
    if (kind !== "folder" && kind !== "group") return;
    const key = getLabelKey(label);
    if (!key) return;
    const entry = containerMap.get(key) || { folder: null, group: null };
    entry[kind] = element;
    containerMap.set(key, entry);
  };

  // --- Tab-Group Collapse Fix (ported from AdvancedTabGroups) ---
  // Zen's native collapse toggle expects a `.group-marker` inside the
  // label container and the `tab-group-editor-mode-create` class to be
  // absent. Without these, newly-created groups are stuck in editor mode
  // and clicks on the header silently do nothing.
  const processTabGroup = (group) => {
    if (
      !group?.isConnected ||
      group.hasAttribute("data-tidy-tabs-processed") ||
      group.classList.contains("zen-folder") ||
      group.hasAttribute("zen-folder") ||
      group.hasAttribute("split-view-group")
    ) {
      return;
    }

    const labelContainer = group.querySelector(".tab-group-label-container");
    if (!labelContainer) return;

    // Remove editor-mode class that blocks collapse clicks
    group.classList.remove("tab-group-editor-mode-create");

    // Strip default context so built-in menus don't intercept the click
    labelContainer.removeAttribute("context");
    group.removeAttribute("context");

    // Inject collapse-toggle marker if absent
    if (!labelContainer.querySelector(".group-marker")) {
      try {
        const frag =
          window.MozXULElement?.parseXULToFragment?.(
            `<div class="tab-group-icon-container">\n` +
            `  <div class="tab-group-icon"></div>\n` +
            `  <image class="group-marker" role="button" keyNav="false" tooltiptext="Toggle Group"/>\n` +
            `</div>\n` +
            `<image class="tab-close-button close-icon" role="button" keyNav="false" tooltiptext="Close Group"/>`
          );
        if (frag) {
          const iconContainer = frag.children[0];
          const closeButton = frag.children[1];
          labelContainer.insertBefore(iconContainer, labelContainer.firstChild);
          labelContainer.appendChild(closeButton);
        }
      } catch (e) {
        // Fallback: standard DOM marker if XUL parsing fails
        const marker = document.createElement("div");
        marker.className = "group-marker";
        marker.setAttribute("role", "button");
        labelContainer.insertBefore(marker, labelContainer.firstChild);
      }
    }

    group.setAttribute("data-tidy-tabs-processed", "true");
  };

  const processExistingTabGroups = () => {
    const groups = document.querySelectorAll(
      'tab-group:not([data-tidy-tabs-processed]):not([split-view-group]):not([zen-folder])'
    );
    groups.forEach((group) => processTabGroup(group));
  };

  const getWorkspaceGroupElements = (workspaceId) =>
    Array.from(document.querySelectorAll(GROUP_NODE_SELECTOR)).filter((groupEl) =>
      isGroupInWorkspace(groupEl, workspaceId)
    );

  const findTopLevelFolderByLabel = (label, workspaceId) => {
    if (!label || !workspaceId) return null;
    const safeLabel = escapeForAttrSelector(label);
    const selector = `zen-folder[label="${safeLabel}"][zen-workspace-id="${workspaceId}"]`;
    return Array.from(document.querySelectorAll(selector)).find(
      (folder) => folder?.isConnected && !folder?.group?.isZenFolder
    );
  };

  const findSubFolderByLabel = (parentFolder, label) => {
    if (!parentFolder?.isConnected || !label) return null;
    const safeLabel = escapeForAttrSelector(label);
    const container = parentFolder.querySelector(":scope > .tab-group-container");
    if (!container) return null;
    return Array.from(container.querySelectorAll(`zen-folder[label="${safeLabel}"]`)).find(
      (folder) => folder?.isConnected && folder?.isZenFolder
    );
  };

  const ensureNestedFolder = async (pathParts, tabs, workspaceId) => {
    if (!Array.isArray(pathParts) || pathParts.length !== 2) return null;
    const [parentName, childName] = pathParts;

    let parentFolder = findTopLevelFolderByLabel(parentName, workspaceId);
    if (!parentFolder?.isConnected) {
      try {
        parentFolder = gZenFolders.createFolder([], {
          renameFolder: false,
          label: parentName,
          workspaceId,
        });
      } catch (e) {
        console.error(`[TidyTabs] Failed to create parent folder "${parentName}":`, e);
        return null;
      }
    }
    if (!parentFolder?.isConnected) return null;
    parentFolder.collapsed = false;

    let childFolder = findSubFolderByLabel(parentFolder, childName);
    if (!childFolder?.isConnected) {
      const seedTabs = tabs.length > 0 ? [tabs[0]] : [];
      const remainingTabs = tabs.length > 1 ? tabs.slice(1) : [];
      try {
        childFolder = gZenFolders.createFolder(seedTabs, {
          renameFolder: false,
          label: childName,
          workspaceId,
          insertAfter: parentFolder.groupContainer?.lastElementChild,
        });
        if (remainingTabs.length) {
          remainingTabs.forEach((t) => {
            try { if (!t.pinned) gBrowser.pinTab(t); } catch {}
          });
          childFolder.addTabs(remainingTabs);
        }
      } catch (e) {
        console.error(`[TidyTabs] Failed to create subfolder "${childName}" in "${parentName}":`, e);
        return null;
      }
    }

    if (!childFolder?.isConnected) return null;

    // Avoid re-adding tabs already attached to a workspace group/folder.
    // This prevents duplicate addTabs calls when nested folders are created.
    const validTabs = tabs.filter(
      (t) => t?.isConnected && !isTabInWorkspaceGroup(t, workspaceId)
    );
    if (validTabs.length) {
      validTabs.forEach((t) => {
        try { if (!t.pinned) gBrowser.pinTab(t); } catch {}
      });
      childFolder.addTabs(validTabs);
    }
    childFolder.collapsed = false;

    return childFolder;
  };

  // --- Folder Tree Connectors ---
  const TREE_SCHEDULE_EVENTS = new Set([
    "TabGroupExpand",
    "TabGroupCollapse",
    "TabGrouped",
    "TabUngrouped",
    "FolderGrouped",
    "FolderUngrouped",
    "TabSelect",
    "TabMove",
    "TabOpen",
    "TabClose",
    "TabAttrModified",
  ]);

  // Tree connectors need the container to be positioned relatively and
  // to have enough inline-start margin for the trunk at
  // `TREE_LINE_X + TREE_CONNECTOR_OFFSET_PX` to sit inside the sidebar.
  // We apply this to BOTH zen-folder and regular tab-group containers so
  // the tree visual shows up consistently everywhere.
  const TREE_CONNECTOR_CSS = `
    zen-folder > .tab-group-container,
    tab-group:not(zen-folder) > .tab-group-container {
      margin-inline-start: ${CONFIG.TREE_FOLDER_INDENT_PX}px !important;
    }

    :root[zen-sidebar-expanded="true"] zen-folder > .tab-group-container,
    :root[zen-sidebar-expanded="true"] tab-group:not(zen-folder) > .tab-group-container,
    .zen-related-group-container {
      position: relative;
    }

    .tree-connector {
      position: absolute;
      top: 0;
      left: ${CONFIG.TREE_CONNECTOR_OFFSET_PX}px;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 0;
      will-change: contents;
    }

    tab.zen-is-related-parent {
      overflow: visible !important;
    }

    tab.zen-is-related-parent > .tab-stack {
      position: relative;
      z-index: 1;
    }

    tab.zen-is-related-child > .tab-stack {
      margin-inline-start: ${CONFIG.TREE_RELATED_CHILD_INDENT_PX}px !important;
      width: calc(100% - ${CONFIG.TREE_RELATED_CHILD_INDENT_PX}px) !important;
    }
  `;

  const ensureTreeConnectorStyles = () => {
    const styleId = "tidy-tabs-tree-connectors-style";
    const existingStyle = document.getElementById(styleId);
    if (existingStyle) {
      existingStyle.textContent = TREE_CONNECTOR_CSS;
      return;
    }
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = TREE_CONNECTOR_CSS;
    document.documentElement.appendChild(style);
  };

  // --- Favicon color sampling for group/folder background tint ---------

  const FAVICON_COLOR_CACHE = new Map();
  const FAVICON_COLOR_CACHE_LIMIT = 300;

  const cacheFaviconColor = (iconUrl, color) => {
    if (!iconUrl) return;
    if (FAVICON_COLOR_CACHE.has(iconUrl)) {
      FAVICON_COLOR_CACHE.delete(iconUrl);
    }
    FAVICON_COLOR_CACHE.set(iconUrl, color);
    if (FAVICON_COLOR_CACHE.size > FAVICON_COLOR_CACHE_LIMIT) {
      const oldestKey = FAVICON_COLOR_CACHE.keys().next().value;
      FAVICON_COLOR_CACHE.delete(oldestKey);
    }
  };

  const sampleFaviconColor = (iconUrl) => {
    if (FAVICON_COLOR_CACHE.has(iconUrl)) {
      return Promise.resolve(FAVICON_COLOR_CACHE.get(iconUrl));
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = 4;
          canvas.height = 4;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, 4, 4);
          const data = ctx.getImageData(0, 0, 4, 4).data;
          let r = 0, g = 0, b = 0, count = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue; // skip transparent pixels
            r += data[i];
            g += data[i + 1];
            b += data[i + 2];
            count++;
          }
          if (count === 0) {
            cacheFaviconColor(iconUrl, null);
            resolve(null);
            return;
          }
          const color = `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
          cacheFaviconColor(iconUrl, color);
          resolve(color);
        } catch (e) {
          cacheFaviconColor(iconUrl, null);
          resolve(null);
        }
      };
      img.onerror = () => {
        cacheFaviconColor(iconUrl, null);
        resolve(null);
      };
      img.src = iconUrl;
    });
  };

  const refreshGroupFaviconColors = async () => {
    if (!window.gBrowser) return;
    const groups = document.querySelectorAll(GROUP_NODE_SELECTOR);
    for (const group of groups) {
      const firstTab = group.querySelector(".tabbrowser-tab");
      if (!firstTab) {
        if (group._tidyFaviconUrl) {
          group.style.removeProperty("--tidy-tabs-favicon-color");
          group._tidyFaviconUrl = null;
        }
        continue;
      }
      const iconImage = firstTab.querySelector(".tab-icon-image");
      const iconUrl = iconImage?.src;
      if (!iconUrl) {
        if (group._tidyFaviconUrl) {
          group.style.removeProperty("--tidy-tabs-favicon-color");
          group._tidyFaviconUrl = null;
        }
        continue;
      }
      if (group._tidyFaviconUrl === iconUrl) continue;
      group._tidyFaviconUrl = iconUrl;
      const color = await sampleFaviconColor(iconUrl);
      if (color) {
        group.style.setProperty("--tidy-tabs-favicon-color", color);
      } else {
        group.style.removeProperty("--tidy-tabs-favicon-color");
      }
    }
  };

  const scheduleFaviconRefresh = () => {
    faviconRefreshPending = true;
    if (faviconRefreshRaf !== null) return;
    faviconRefreshRaf = requestAnimationFrame(async () => {
      faviconRefreshRaf = null;
      if (faviconRefreshInFlight) return;
      faviconRefreshInFlight = true;
      try {
        faviconRefreshPending = false;
        await refreshGroupFaviconColors();
      } finally {
        faviconRefreshInFlight = false;
        if (faviconRefreshPending) {
          scheduleFaviconRefresh();
        }
      }
    });
  };



  // --- AI Interaction ---

  // Helper function to average embeddings
  function averageEmbedding(arrays) {
    if (!Array.isArray(arrays) || arrays.length === 0) return [];
    // If already a flat array, just return it
    if (typeof arrays[0] === "number") return arrays;
    // Otherwise, average across all arrays
    const len = arrays[0].length;
    const avg = new Array(len).fill(0);
    for (const arr of arrays) {
      for (let i = 0; i < len; i++) {
        avg[i] += arr[i];
      }
    }
    for (let i = 0; i < len; i++) {
      avg[i] /= arrays.length;
    }
    return avg;
  }

  // Cosine similarity function
  function cosineSimilarity(a, b) {
    // Guard: ensure both a and b are defined, arrays, and contain numbers
    if (
      !Array.isArray(a) ||
      !Array.isArray(b) ||
      a.length !== b.length ||
      a.length === 0
    )
      return 0;
    if (typeof a[0] !== "number" || typeof b[0] !== "number") return 0;
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // Improved greedy clustering with input validation
  function clusterEmbeddings(vectors, threshold = CONFIG.SIMILARITY_THRESHOLD) {
    if (
      !Array.isArray(vectors) ||
      vectors.length === 0 ||
      typeof threshold !== "number"
    ) {
      return [];
    }

    const groups = [];
    const used = new Array(vectors.length).fill(false);

    for (let i = 0; i < vectors.length; i++) {
      if (used[i]) continue;
      const group = [i];
      used[i] = true;

      for (let j = 0; j < vectors.length; j++) {
        if (
          i !== j &&
          !used[j] &&
          cosineSimilarity(vectors[i], vectors[j]) > threshold
        ) {
          group.push(j);
          used[j] = true;
        }
      }
      groups.push(group);
    }
    return groups;
  }

  // Process embeddings in batches for better performance
  const processTabsInBatches = async (
    tabs,
    batchSize = CONFIG.EMBEDDING_BATCH_SIZE
  ) => {
    if (!Array.isArray(tabs) || tabs.length === 0) return [];

    const results = [];
    for (let i = 0; i < tabs.length; i += batchSize) {
      const batch = tabs.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map((tab) => generateEmbedding(getTabTitle(tab)))
      );
      results.push(...batchResults);
    }
    return results;
  };

  const cacheEmbedding = (key, embedding) => {
    if (!key) return;
    if (EMBEDDING_CACHE.has(key)) {
      EMBEDDING_CACHE.delete(key);
    }
    EMBEDDING_CACHE.set(key, embedding);
    if (EMBEDDING_CACHE.size > EMBEDDING_CACHE_LIMIT) {
      const oldestKey = EMBEDDING_CACHE.keys().next().value;
      EMBEDDING_CACHE.delete(oldestKey);
    }
  };

  const getEmbeddingEngine = async () => {
    if (!embeddingEnginePromise) {
      embeddingEnginePromise = (async () => {
        const { createEngine } = ChromeUtils.importESModule(
          "chrome://global/content/ml/EngineProcess.sys.mjs"
        );
        return createEngine({
          taskName: "feature-extraction",
          modelId: "Mozilla/smart-tab-embedding",
          modelHub: "huggingface",
          engineId: "embedding-engine",
        });
      })().catch((error) => {
        embeddingEnginePromise = null;
        throw error;
      });
    }
    return embeddingEnginePromise;
  };

  const getGroupNamingEngine = async () => {
    if (!namingEnginePromise) {
      namingEnginePromise = (async () => {
        const { createEngine } = ChromeUtils.importESModule(
          "chrome://global/content/ml/EngineProcess.sys.mjs"
        );
        return createEngine({
          taskName: "text2text-generation",
          modelId: "Mozilla/smart-tab-topic",
          modelHub: "huggingface",
          engineId: "group-namer",
        });
      })().catch((error) => {
        namingEnginePromise = null;
        throw error;
      });
    }
    return namingEnginePromise;
  };

  const getEmbeddingCacheKey = (title) =>
    typeof title === "string" ? title.trim().toLowerCase().slice(0, 512) : "";

  const generateEmbedding = async (title) => {
    if (!title || typeof title !== "string") return null;

    const cacheKey = getEmbeddingCacheKey(title);
    if (cacheKey && EMBEDDING_CACHE.has(cacheKey)) {
      return EMBEDDING_CACHE.get(cacheKey);
    }

    try {
      const engine = await getEmbeddingEngine();

      const result = await engine.run({ args: [title] });
      let embedding;

      if (result?.[0]?.embedding && Array.isArray(result[0].embedding)) {
        embedding = result[0].embedding;
      } else if (result?.[0] && Array.isArray(result[0])) {
        embedding = result[0];
      } else if (Array.isArray(result)) {
        embedding = result;
      } else {
        return null;
      }

      const pooled = averageEmbedding(embedding);
      if (
        Array.isArray(pooled) &&
        pooled.length > 0 &&
        typeof pooled[0] === "number"
      ) {
        // Normalize the embedding
        const norm = Math.sqrt(pooled.reduce((sum, v) => sum + v * v, 0));
        const normalized = norm === 0 ? pooled : pooled.map((v) => v / norm);
        cacheEmbedding(cacheKey, normalized);
        return normalized;
      }
      cacheEmbedding(cacheKey, null);
      return null;
    } catch (e) {
      console.error("[TabSort][AI] Error generating embedding:", e);
      cacheEmbedding(cacheKey, null);
      return null;
    }
  };

  const askAIForMultipleTopics = async (tabs) => {
    if (!Array.isArray(tabs) || tabs.length === 0) return [];

    const validTabs = tabs.filter((tab) => tab?.isConnected);
    if (!validTabs.length) return [];

    const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;
    const result = [];
    const ungroupedTabs = [];

    const extractKeywords = (titles) => {
      const allWords = titles
        .join(" ")
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 2);

      const wordCount = {};
      allWords.forEach((word) => {
        wordCount[word] = (wordCount[word] || 0) + 1;
      });

      const stopWords = new Set([
        "the",
        "and",
        "for",
        "are",
        "but",
        "not",
        "you",
        "all",
        "can",
        "had",
        "her",
        "was",
        "one",
        "our",
        "out",
        "day",
        "get",
        "has",
        "him",
        "his",
        "how",
        "man",
        "new",
        "now",
        "old",
        "see",
        "two",
        "way",
        "who",
        "boy",
        "did",
        "its",
        "let",
        "put",
        "say",
        "she",
        "too",
        "use",
      ]);

      return Object.entries(wordCount)
        .filter(([word]) => !stopWords.has(word))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([word]) => word);
    };

    const nameGroupWithSmartTabTopic = async (titles) => {
      const keywords = extractKeywords(titles);
      const input = `Topic from keywords: ${keywords.join(
        ", "
      )}. titles:\n${titles.join("\n")}`;

      try {
        const engine = await getGroupNamingEngine();
        const aiResult = await engine.run({
          args: [input],
          options: { max_new_tokens: 8, temperature: 0.7 },
        });

        return sanitizeGroupName(aiResult?.[0]?.generated_text || "Group", titles);
      } catch (e) {
        console.error("[TabSort][AI] Error naming group:", e);
        return "Group";
      }
    };

    // Get existing groups in current workspace
    const existingWorkspaceGroups = new Map();
    if (currentWorkspaceId) {
      getWorkspaceGroupElements(currentWorkspaceId).forEach((groupEl) => {
        const label = groupEl.getAttribute("label");
        if (label) {
          // Get tabs in this group to calculate group embedding
          const groupTabs = Array.from(groupEl.querySelectorAll('tab')).filter(tab => 
            tab.getAttribute("zen-workspace-id") === currentWorkspaceId
          );
          if (groupTabs.length > 0) {
            existingWorkspaceGroups.set(label, {
              element: groupEl,
              tabs: groupTabs,
              tabTitles: groupTabs.map(tab => getTabTitle(tab))
            });
          }
        }
      });
    }

    // Process tabs in batches for better performance.
    const tabTitles = validTabs.map((tab) => getTabTitle(tab));
    const embeddings = await processTabsInBatches(validTabs);

    // Calculate embeddings for existing workspace groups
    const existingGroupEmbeddings = new Map();
    for (const [groupName, groupInfo] of existingWorkspaceGroups) {
      try {
        const groupTabEmbeddings = await processTabsInBatches(groupInfo.tabs);
        const validGroupEmbeddings = groupTabEmbeddings.filter(emb => 
          Array.isArray(emb) && emb.length > 0
        );
        if (validGroupEmbeddings.length > 0) {
          const avgEmbedding = averageEmbedding(validGroupEmbeddings);
          existingGroupEmbeddings.set(groupName, avgEmbedding);
        }
      } catch (e) {
        console.error(`[TabSort] Error calculating embedding for existing group "${groupName}":`, e);
      }
    }

    // Enhanced matching: try to match tabs to existing groups
    for (let i = 0; i < validTabs.length; i++) {
      const tab = validTabs[i];
      const tabEmbedding = embeddings[i];
      const tabTitle = tabTitles[i];

      if (!tabEmbedding) {
        ungroupedTabs.push(tab);
        continue;
      }

      let bestMatch = null;
      let bestSimilarity = 0;

      // Check against current workspace groups
      for (const [groupName, groupInfo] of existingWorkspaceGroups) {
        const groupEmbedding = existingGroupEmbeddings.get(groupName);
        if (!groupEmbedding) continue;

        let similarity = cosineSimilarity(tabEmbedding, groupEmbedding);
        similarity += CONFIG.EXISTING_GROUP_BOOST; // Always boost existing groups

        if (similarity > CONFIG.GROUP_SIMILARITY_THRESHOLD && similarity > bestSimilarity) {
          bestMatch = { 
            groupData: { groupName }, 
            similarity,
            isExistingGroup: true
          };
          bestSimilarity = similarity;
        }
      }

      // Additional semantic matching for existing groups using title similarity
      if (!bestMatch || bestMatch.similarity < 0.8) {
        for (const [groupName, groupInfo] of existingWorkspaceGroups) {
          // Check if tab title has semantic similarity to group tabs
          const titleSimilarities = groupInfo.tabTitles.map(groupTabTitle => {
            const distance = levenshteinDistance(tabTitle.toLowerCase(), groupTabTitle.toLowerCase());
            const maxLen = Math.max(tabTitle.length, groupTabTitle.length);
            return maxLen > 0 ? 1 - (distance / maxLen) : 0;
          });

          const maxTitleSimilarity = Math.max(...titleSimilarities);
          
          // If we find strong title similarity, consider it a match
          if (maxTitleSimilarity > 0.7) {
            const adjustedSimilarity = maxTitleSimilarity * 0.8 + CONFIG.EXISTING_GROUP_BOOST;
            if (adjustedSimilarity > CONFIG.GROUP_SIMILARITY_THRESHOLD && adjustedSimilarity > bestSimilarity) {
              bestMatch = { 
                groupData: { groupName }, 
                similarity: adjustedSimilarity,
                isExistingGroup: true,
                matchType: 'title'
              };
              bestSimilarity = adjustedSimilarity;
            }
          }
        }
      }

      if (bestMatch) {
        // Add tab to existing group
        result.push({ tab, topic: bestMatch.groupData.groupName });
        console.log(`[TabSort] Matched "${tabTitle}" to existing group "${bestMatch.groupData.groupName}" (similarity: ${bestMatch.similarity.toFixed(3)}, type: ${bestMatch.matchType || 'embedding'})`);
      } else {
        ungroupedTabs.push(tab);
      }
    }

    console.log(`[TabSort] Matched ${result.length} tabs to existing groups, ${ungroupedTabs.length} tabs remain ungrouped`);

    // Second pass: cluster remaining ungrouped tabs (only if we have enough)
    if (ungroupedTabs.length > 1) {
      const ungroupedEmbeddings = await processTabsInBatches(ungroupedTabs);

      // Filter out empty embeddings
      const validEmbeddings = ungroupedEmbeddings.filter(
        (emb) => Array.isArray(emb) && emb.length > 0
      );
      const validIndices = ungroupedEmbeddings
        .map((emb, idx) => (Array.isArray(emb) && emb.length > 0 ? idx : -1))
        .filter((idx) => idx !== -1);

      if (validEmbeddings.length > 1) {
        // Cluster the ungrouped tabs
        const allGroups = clusterEmbeddings(
          validEmbeddings,
          CONFIG.SIMILARITY_THRESHOLD
        );
        const groups = allGroups.filter(
          (group) => Array.isArray(group) && group.length > 1
        );

        if (groups.length > 0) {
          // Group naming via Firefox's on-device Mozilla/smart-tab-topic.
          // This path only runs when OpenRouter is NOT configured — the
          // OpenRouter engine does its own naming as part of a single
          // full-grouping request (see `askOpenRouterForGroups`), so we
          // don't need a separate naming hop here.
          // Process each new group
          for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
            const group = groups[groupIdx];
            const groupTabs = group.map(
              (idx) => ungroupedTabs[validIndices[idx]]
            );
            const groupTitles = groupTabs.map((tab) => getTabTitle(tab));

            // Check if this new group would be similar to an existing group
            let shouldCreateNewGroup = true;
            let targetExistingGroup = null;

            if (groupTabs.length >= 2) {
              const groupEmbeddings = group.map((idx) => validEmbeddings[idx]);
              const avgEmbedding = averageEmbedding(groupEmbeddings);

              // Check similarity to existing groups one more time with the averaged embedding
              for (const [groupName, groupInfo] of existingWorkspaceGroups) {
                const existingEmbedding = existingGroupEmbeddings.get(groupName);
                if (existingEmbedding) {
                  const similarity = cosineSimilarity(avgEmbedding, existingEmbedding) + CONFIG.EXISTING_GROUP_BOOST;
                  if (similarity > CONFIG.GROUP_SIMILARITY_THRESHOLD * 0.9) { // Slightly lower threshold for group-to-group matching
                    shouldCreateNewGroup = false;
                    targetExistingGroup = groupName;
                    console.log(`[TabSort] Merging new group into existing group "${groupName}" (similarity: ${similarity.toFixed(3)})`);
                    break;
                  }
                }
              }
            }

            if (!shouldCreateNewGroup && targetExistingGroup) {
              // Add all tabs to the existing group
              groupTabs.forEach((tab) => {
                result.push({ tab, topic: targetExistingGroup });
              });
            } else {
              // Create new group
              const groupName = await nameGroupWithSmartTabTopic(groupTitles);

              // Add to result
              groupTabs.forEach((tab) => {
                result.push({ tab, topic: groupName });
              });

              console.log(`[TabSort] Created new group "${groupName}" with ${groupTabs.length} tabs`);
            }
          }
        }
      }
    }

    return result;
  };

  // Animation cleanup utility
  const cleanupAnimation = () => {
    // Don't cleanup if failure animation is playing
    if (isPlayingFailureAnimation) {
      return;
    }

    if (sortAnimationId !== null) {
      cancelAnimationFrame(sortAnimationId);
      sortAnimationId = null;

      try {
        const activeWorkspace = gZenWorkspaces?.activeWorkspaceElement;
        const activeSeparator = activeWorkspace?.querySelector(
          ".pinned-tabs-container-separator:not(.has-no-sortable-tabs)"
        );
        const pathElement = activeSeparator?.querySelector("#separator-path");
        if (pathElement) {
          pathElement.setAttribute("d", "M 0 1 L 100 1");
        }
      } catch (resetError) {
        console.error("Error resetting animation:", resetError);
      }
    }
  };

  // Spiky failure animation utility
  const startFailureAnimation = () => {
    if (sortAnimationId !== null) {
      cancelAnimationFrame(sortAnimationId);
    }

    isPlayingFailureAnimation = true;

    try {
      // Find the separator in the ACTIVE workspace, not the first one in DOM
      const activeWorkspace = gZenWorkspaces?.activeWorkspaceElement;
      const activeSeparator = activeWorkspace?.querySelector(
        ".pinned-tabs-container-separator:not(.has-no-sortable-tabs)"
      );
      const pathElement = activeSeparator?.querySelector("#separator-path");

      if (pathElement) {
        const maxAmplitude = CONFIG.FAILURE_AMPLITUDE;
        const frequency = CONFIG.FAILURE_FREQUENCY;
        const segments = CONFIG.FAILURE_SEGMENTS;
        const pulseDuration = CONFIG.FAILURE_PULSE_DURATION;
        const totalPulses = CONFIG.FAILURE_PULSE_COUNT;
        let currentPulse = 0;
        let t = 0;
        let startTime = performance.now();
        let pulseStartTime = startTime;

        function animateFailureLoop(timestamp) {
          if (sortAnimationId === null) return;

          const elapsedSincePulseStart = timestamp - pulseStartTime;
          const pulseProgress = elapsedSincePulseStart / pulseDuration;

          if (pulseProgress >= 1) {
            currentPulse++;
            if (currentPulse >= totalPulses) {
              // Animation complete, reset to straight line
              pathElement.setAttribute("d", "M 0 1 L 100 1");
              sortAnimationId = null;
              isPlayingFailureAnimation = false;
              return;
            }
            // Start next pulse
            pulseStartTime = timestamp;
          }

          // Create spiky wave with sharp peaks and valleys
          const currentProgress = Math.min(pulseProgress, 1);
          const intensity = Math.sin(currentProgress * Math.PI); // Pulse intensity (0 to 1 to 0)
          const currentAmplitude = maxAmplitude * intensity;

          t += 1.2; // Faster animation speed

          const points = [];
          for (let i = 0; i <= segments; i++) {
            const x = (i / segments) * 100;
            // Create sharp spikes using a combination of sine waves
            const baseWave = Math.sin(
              (x / (100 / frequency)) * 2 * Math.PI + t * 0.15
            );
            const sharpWave =
              Math.sign(baseWave) * Math.pow(Math.abs(baseWave), 0.3); // Sharp peaks
            const y = 1 + currentAmplitude * sharpWave;
            points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
          }

          if (pathElement?.isConnected) {
            const pathData = "M" + points.join(" L");
            pathElement.setAttribute("d", pathData);
            sortAnimationId = requestAnimationFrame(animateFailureLoop);
          } else {
            sortAnimationId = null;
            isPlayingFailureAnimation = false;
          }
        }

        sortAnimationId = requestAnimationFrame(animateFailureLoop);
      }
    } catch (error) {
      console.error("Error in failure animation:", error);
      isPlayingFailureAnimation = false;
    }
  };

  // --- Mode Detection -----------------------------------------------------
  // Firefox exposes `browser.ml.enabled`; if it is off (or the pref is
  // missing) local AI grouping is unavailable.
  const isAIEnabled = () => {
    try {
      return services?.prefs?.getBoolPref?.("browser.ml.enabled", false) ?? false;
    } catch {
      return false;
    }
  };

  // --- Name Consolidation ------------------------------------------------
  // Collapse groups whose labels differ by <= N edits (e.g. "Shopping" vs
  // "Shoping") into a single canonical label, preferring pre-existing
  // workspace group names so we don't create near-duplicates.
  const consolidateSimilarGroupNames = (groups, existingNames) => {
    const keys = Object.keys(groups);
    const merged = new Set();
    const rename = {};

    for (let i = 0; i < keys.length; i++) {
      let keyA = keys[i];
      if (merged.has(keyA)) continue;
      while (rename[keyA]) keyA = rename[keyA];

      for (let j = i + 1; j < keys.length; j++) {
        let keyB = keys[j];
        if (merged.has(keyB)) continue;
        while (rename[keyB]) keyB = rename[keyB];
        if (keyA === keyB) continue;

        const dist = levenshteinDistance(keyA, keyB);
        if (dist <= 0 || dist > CONFIG.CONSOLIDATION_DISTANCE_THRESHOLD) continue;

        // Pick the canonical name: prefer existing, then shorter
        let canonical = keyA;
        let dropped = keyB;
        const aExisting = existingNames.has(keyA);
        const bExisting = existingNames.has(keyB);
        if (bExisting && !aExisting) [canonical, dropped] = [keyB, keyA];
        else if (aExisting === bExisting && keyA.length > keyB.length)
          [canonical, dropped] = [keyB, keyA];

        if (groups[dropped]) {
          groups[canonical] ||= [];
          groups[dropped].forEach((t) => {
            if (t?.isConnected && !groups[canonical].includes(t)) {
              groups[canonical].push(t);
            }
          });
          delete groups[dropped];
        }
        merged.add(dropped);
        rename[dropped] = canonical;
        if (dropped === keyA) { keyA = canonical; break; }
      }
    }
    return groups;
  };

  const getUniqueGroupLabel = (groups, label) => {
    const base = (label || "Group").toString().trim() || "Group";
    if (!groups[base]) return base;
    let suffix = 2;
    while (groups[`${base} ${suffix}`]) {
      suffix++;
    }
    return `${base} ${suffix}`;
  };

  // --- Fuzzy Grouping (AI-off fallback) ----------------------------------
  // Pipeline:
  //   1. Tokenize each tab into (title unigrams + title bigrams + hostname
  //      tokens), lowercased, stopword-filtered, min-length gated.
  //   2. Compute IDF across the batch so common tokens shrink and rare ones
  //      stand out.
  //   3. Seed clusters by hostname (strong prior — same host ≈ same topic).
  //   4. Greedy-merge clusters by weighted-Jaccard similarity on IDF-boosted
  //      token weights; titles are weighted higher than hostnames.
  //   5. Name each cluster by the highest-score (support × IDF × source
  //      boost) token, preferring bigrams on near-ties.
  //
  // Deterministic, offline, no model required.
  const FUZZY_STOPWORDS = new Set([
    "the","a","an","and","or","but","of","for","to","in","on","at","by",
    "with","from","is","are","was","were","be","been","being","it","its",
    "this","that","these","those","as","if","then","than","so","not","no",
    "yes","you","your","we","our","us","they","them","their","he","she",
    "his","her","i","me","my","mine","do","does","did","have","has","had",
    "will","would","can","could","should","may","might","must","shall",
    "new","tab","page","home","welcome","untitled","loading","about",
    "blank","localhost","google","search","www","com","net","org","io",
    "co","app","dev","docs","doc","login","signin","sign","in","up","out",
    "help","faq","terms","privacy","policy","contact","more","less","menu"
  ]);

  // Weighted-Jaccard overlap required to merge two clusters. Derived from
  // the user-facing GROUPING_STRENGTH so the knob actually does something.
  const FUZZY_MIN_TOKEN_LEN = 3;
  // Bigrams capture multi-word concepts ("tab groups", "credit card") that
  // get broken up by unigram tokenization. We only bother with title bigrams
  // since hostnames are usually single-concept.
  const FUZZY_USE_BIGRAMS = true;

  const getTabHost = (tab) => {
    try {
      const spec = tab?.linkedBrowser?.currentURI?.spec;
      if (!spec || spec.startsWith("about:")) return "";
      return new URL(spec).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  };

  // Pull tokens out of an arbitrary string: lowercased, stopword-filtered,
  // min-length-gated. Shared by title and hostname paths.
  const extractTokens = (source, splitRe) => {
    if (!source) return [];
    return source
      .toLowerCase()
      .split(splitRe)
      .filter((t) => t && t.length >= FUZZY_MIN_TOKEN_LEN)
      .filter((t) => !FUZZY_STOPWORDS.has(t));
  };

  const tokenizeTab = (tab) => {
    const title = getTabTitle(tab) || "";
    const host = getTabHost(tab);

    const hostTokens = extractTokens(host, /[.\-]/);
    const titleUnigrams = extractTokens(title, /[^a-z0-9]+/);

    // Adjacent pairs from the title as bigrams (joined with a space). Only
    // emitted when both parts passed the unigram filter, so we don't get
    // noise like "the foo".
    const titleBigrams =
      FUZZY_USE_BIGRAMS && titleUnigrams.length >= 2
        ? titleUnigrams
            .slice(0, -1)
            .map((tok, i) => `${tok} ${titleUnigrams[i + 1]}`)
        : [];

    const titleTokens = [...titleUnigrams, ...titleBigrams];
    const allTokens = new Set([...hostTokens, ...titleTokens]);

    return { host, hostTokens, titleTokens, titleUnigrams, titleBigrams, allTokens };
  };

  // Inverse-document-frequency over the batch. Rare tokens get high weights,
  // common ones (present in most tabs) approach zero.
  //   idf(t) = log((N + 1) / (df(t) + 1)) + 1
  // The +1s are smoothing so we never divide by zero nor pick up log(1)=0
  // for tokens present in every doc (those still get the +1 base weight).
  const computeIDF = (meta) => {
    const docCount = meta.size;
    const df = new Map();
    for (const { allTokens } of meta.values()) {
      for (const tok of allTokens) df.set(tok, (df.get(tok) || 0) + 1);
    }
    const idf = new Map();
    df.forEach((count, tok) => {
      idf.set(tok, Math.log((docCount + 1) / (count + 1)) + 1);
    });
    return idf;
  };

  // Token weight map for a tab combines term frequency with IDF, and boosts
  // title tokens over hostname tokens (titles describe the topic, hostnames
  // describe the source).
  const tabTokenWeights = (tabMeta, idf) => {
    const weights = new Map();
    const add = (tok, bump) => {
      const w = (idf.get(tok) || 1) * bump;
      weights.set(tok, (weights.get(tok) || 0) + w);
    };
    tabMeta.titleTokens.forEach((t) => add(t, 2));
    tabMeta.hostTokens.forEach((t) => add(t, 1));
    return weights;
  };

  // Weighted Jaccard similarity between two weight maps:
  //   J_w(A, B) = sum_t min(A[t], B[t]) / sum_t max(A[t], B[t])
  // This differs from unweighted Jaccard by caring HOW STRONGLY each token
  // appears, not just whether it overlaps. Distinctive shared tokens dominate.
  const weightedJaccard = (a, b) => {
    if (a.size === 0 || b.size === 0) return 0;
    let num = 0;
    let den = 0;
    const seen = new Set();
    a.forEach((wa, tok) => {
      const wb = b.get(tok) || 0;
      num += Math.min(wa, wb);
      den += Math.max(wa, wb);
      seen.add(tok);
    });
    b.forEach((wb, tok) => {
      if (seen.has(tok)) return;
      den += wb; // min with missing is 0, contributes nothing to num
    });
    return den === 0 ? 0 : num / den;
  };

  // Pretty-format a lowercased raw token into a group label.
  // Acronym-aware: if `sourceTitles` are provided and the token appears
  // UPPERCASE verbatim in any of them, honor that casing. This keeps
  // groups labeled "DSA"/"CSS"/"API" instead of "Dsa"/"Css"/"Api".
  const prettifyLabel = (raw, sourceTitles) => {
    if (!raw) return "Other";
    if (
      Array.isArray(sourceTitles) &&
      sourceTitles.length &&
      raw.length <= 5 &&
      !raw.includes(" ") &&
      sourceTitles.some(
        (t) => typeof t === "string" && t.includes(raw.toUpperCase())
      )
    ) {
      return raw.toUpperCase();
    }
    return raw
      .split(/[\s\-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  };

  // Pick a label that's (a) shared by a meaningful fraction of the cluster,
  // and (b) distinctive in the batch (high IDF). Prefers bigrams slightly
  // over unigrams when both score similarly — they tend to read better.
  const nameFuzzyCluster = (clusterTabs, meta, idf) => {
    const minSupport = Math.max(2, Math.ceil(clusterTabs.length * 0.4));

    const candidates = new Map(); // token -> { count, score, isBigram }
    for (const tab of clusterTabs) {
      const m = meta.get(tab);
      if (!m) continue;

      const seenInTab = new Set();
      const bump = (tok, weight, isBigram) => {
        if (seenInTab.has(tok)) return;
        seenInTab.add(tok);
        const idfWeight = idf.get(tok) || 1;
        const entry =
          candidates.get(tok) || { count: 0, score: 0, isBigram };
        entry.count++;
        entry.score += idfWeight * weight;
        candidates.set(tok, entry);
      };
      m.titleBigrams.forEach((t) => bump(t, 3, true));
      m.titleUnigrams.forEach((t) => bump(t, 2, false));
      m.hostTokens.forEach((t) => bump(t, 1, false));
    }

    const ranked = [...candidates.entries()]
      .filter(([, e]) => e.count >= minSupport)
      .sort((a, b) => {
        // Primary: score descending
        if (b[1].score !== a[1].score) return b[1].score - a[1].score;
        // Tiebreak 1: bigrams first (usually more descriptive)
        if (a[1].isBigram !== b[1].isBigram) return a[1].isBigram ? -1 : 1;
        // Tiebreak 2: longer token wins
        return b[0].length - a[0].length;
      });

    const sourceTitles = clusterTabs.map((t) => getTabTitle(t));
    if (ranked.length) return prettifyLabel(ranked[0][0], sourceTitles);

    // Fallback: most common hostname in the cluster.
    const hostCount = new Map();
    clusterTabs.forEach((tab) => {
      const h = meta.get(tab)?.host;
      if (h) hostCount.set(h, (hostCount.get(h) || 0) + 1);
    });
    const topHost = [...hostCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    return prettifyLabel(topHost?.split(".")[0] || "Other");
  };

  const fuzzyGroupByTokens = (tabs, existingNames) => {
    const validTabs = tabs.filter((t) => t?.isConnected);
    if (validTabs.length === 0) return {};

    const meta = new Map();
    validTabs.forEach((tab) => meta.set(tab, tokenizeTab(tab)));

    const idf = computeIDF(meta);
    const tabWeights = new Map();
    validTabs.forEach((tab) => tabWeights.set(tab, tabTokenWeights(meta.get(tab), idf)));

    // 1. Seed clusters by hostname — tabs on the same host are almost
    //    always related, so this is a strong prior. Tabs WITHOUT a host
    //    (about:blank, Settings pages, etc.) seed their own singleton
    //    clusters so unrelated blank-ish pages don't get falsely lumped
    //    into a single "Other" group.
    const clusters = new Map();
    const clusterList = [];
    validTabs.forEach((tab) => {
      const host = meta.get(tab).host;
      if (!host) {
        clusterList.push([tab]);
        return;
      }
      if (!clusters.has(host)) {
        const bucket = [];
        clusters.set(host, bucket);
        clusterList.push(bucket);
      }
      clusters.get(host).push(tab);
    });

    // Aggregate token-weight maps per cluster by summing each member's map.
    const buildClusterWeights = (tabs) => {
      const agg = new Map();
      tabs.forEach((tab) => {
        const w = tabWeights.get(tab);
        w?.forEach((v, k) => agg.set(k, (agg.get(k) || 0) + v));
      });
      return agg;
    };
    const clusterWeights = clusterList.map(buildClusterWeights);

    // 2. Greedy-merge clusters whose weighted-Jaccard similarity crosses
    //    the threshold. Uses a simple pass — O(n^2) in cluster count, which
    //    is fine since cluster count << tab count.
    const mergedInto = new Array(clusterList.length).fill(-1);
    for (let i = 0; i < clusterList.length; i++) {
      if (mergedInto[i] !== -1) continue;
      for (let j = i + 1; j < clusterList.length; j++) {
        if (mergedInto[j] !== -1) continue;
        const sim = weightedJaccard(clusterWeights[i], clusterWeights[j]);
        if (sim >= CONFIG.FUZZY_CLUSTER_THRESHOLD) {
          clusterList[i].push(...clusterList[j]);
          clusterWeights[j].forEach((v, k) =>
            clusterWeights[i].set(k, (clusterWeights[i].get(k) || 0) + v)
          );
          mergedInto[j] = i;
        }
      }
    }

    // 3. Emit named groups, dropping singletons.
    const finalGroups = {};
    clusterList.forEach((tabs, idx) => {
      if (mergedInto[idx] !== -1) return;
      if (tabs.length < 2) return;
      const label = getUniqueGroupLabel(
        finalGroups,
        nameFuzzyCluster(tabs, meta, idf)
      );
      finalGroups[label] = tabs;
    });

    return consolidateSimilarGroupNames(finalGroups, existingNames);
  };

  // Small utility used by all rescue passes: which tabs in `allTabs` are
  // NOT already a member of any group in `groups`?
  const collectUngrouped = (allTabs, groups) => {
    const groupedSet = new Set();
    Object.values(groups).forEach((tabs) =>
      tabs.forEach((t) => groupedSet.add(t))
    );
    return allTabs.filter((t) => t?.isConnected && !groupedSet.has(t));
  };

  // --- Rescue pass 1: shared-keyword ---
  // Any distinctive token that appears in ≥2 ungrouped tabs becomes a
  // group. Catches the classic "two DSA tabs on different sites stayed
  // loose because AI embeddings weren't close enough" case.
  //
  // Greedy: pick the token covering the most tabs first; on ties prefer
  // bigrams (more descriptive) and longer tokens. Tabs are assigned to
  // at most one keyword group so we don't double-count.
  const rescueByKeyword = (allTabs, groups) => {
    const ungrouped = collectUngrouped(allTabs, groups);
    if (ungrouped.length < 2) return groups;

    const tokenToTabs = new Map();
    ungrouped.forEach((tab) => {
      const m = tokenizeTab(tab);
      // Title tokens only — hostnames are handled separately and mixing
      // them in here would produce host-named rescue groups, duplicating
      // work the hostname pass already does.
      const tokens = new Set([...m.titleUnigrams, ...m.titleBigrams]);
      tokens.forEach((tok) => {
        if (!tokenToTabs.has(tok)) tokenToTabs.set(tok, new Set());
        tokenToTabs.get(tok).add(tab);
      });
    });

    const ranked = [...tokenToTabs.entries()]
      .filter(([, set]) => set.size >= 2)
      .sort((a, b) => {
        if (b[1].size !== a[1].size) return b[1].size - a[1].size;
        const aBigram = a[0].includes(" ");
        const bBigram = b[0].includes(" ");
        if (aBigram !== bBigram) return aBigram ? -1 : 1;
        return b[0].length - a[0].length;
      });

    const result = { ...groups };
    const used = new Set();
    for (const [tok, tabSet] of ranked) {
      const available = [...tabSet].filter((t) => !used.has(t));
      if (available.length < 2) continue;
      const titles = available.map((t) => getTabTitle(t));
      const label = prettifyLabel(tok, titles);
      result[label] = (result[label] || []).concat(available);
      available.forEach((t) => used.add(t));
    }
    return result;
  };

  // --- Rescue pass 2: shared-hostname ---
  // Any host with ≥2 ungrouped tabs becomes a group (or merges with an
  // existing group sharing the prettified host label). This is the win
  // for AI mode with same-site tabs whose titles are semantically
  // unrelated — e.g. 3 YouTube tabs (news video + channel + subs feed).
  const rescueByHost = (allTabs, groups) => {
    const ungrouped = collectUngrouped(allTabs, groups);
    if (!ungrouped.length) return groups;

    const byHost = new Map();
    ungrouped.forEach((t) => {
      const host = getTabHost(t);
      if (!host) return;
      if (!byHost.has(host)) byHost.set(host, []);
      byHost.get(host).push(t);
    });

    const result = { ...groups };
    for (const [host, tabs] of byHost) {
      if (tabs.length < 2) continue;
      const label = prettifyLabel(host.split(".")[0]);
      result[label] = (result[label] || []).concat(tabs);
    }
    return result;
  };

  // --- Rescue pass 3: Miscellaneous catchall (opt-out) ---
  // Anything still loose — even a single tab — gets bucketed into a
  // "Miscellaneous" group. The whole point of this catchall is to
  // guarantee nothing is left stranded in the sidebar after a sort, so
  // we don't gate it on ≥2 members the way other rescue passes do.
  const rescueAsMiscellaneous = (allTabs, groups) => {
    const stillLoose = collectUngrouped(allTabs, groups);
    if (stillLoose.length === 0) return groups;
    const result = { ...groups };
    const label = "Miscellaneous";
    result[label] = (result[label] || []).concat(stillLoose);
    return result;
  };

  // Full rescue pipeline: keyword → host → misc. Keyword runs first
  // because a shared distinctive topic word is a stronger signal of
  // user intent than a shared hostname.
  const applyPostGroupingRescue = (allTabs, groups, useMisc) => {
    let g = rescueByKeyword(allTabs, groups);
    g = rescueByHost(allTabs, g);
    if (useMisc) g = rescueAsMiscellaneous(allTabs, g);
    return g;
  };

  // Marker class on <html> while a sort is in-flight. Styled in
  // userChrome.css with a subtle opacity pulse on all tabs so the user
  // gets passive feedback without a modal/toast.
  const SORT_IN_PROGRESS_CLASS = "tidy-tabs-sorting";
  const setSortingVisualState = (on) => {
    document.documentElement.classList.toggle(SORT_IN_PROGRESS_CLASS, !!on);
  };

  // --- Main Sorting Function ---
  // Single entry point. Topic-based grouping only:
  //   - AI (Firefox local ML) when `browser.ml.enabled` is on
  //   - Fuzzy token similarity (title + hostname) otherwise
  // `useFolders`: true  -> create Zen Folders (pinned)
  //               false -> create regular tab groups
  const sortTabsByTopic = async (useFolders = false) => {
    if (isSorting) return;
    isSorting = true;
    setSortingVisualState(true);

    let separatorsToSort = [];
    try {
      separatorsToSort = domCache.getSeparators();
      // Apply visual indicator
      if (separatorsToSort.length > 0) {
        separatorsToSort.forEach((sep) => {
          if (sep?.isConnected) {
            sep.classList.add("separator-is-sorting");
          }
        });
      }

      const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;
      if (!currentWorkspaceId) {
        console.error("Cannot get current workspace ID.");
        return; // Exit early
      }

      // --- Step 1: Get ALL Existing Group Names for Context ---
      const allExistingGroupNames = new Set();
      const workspaceGroups = getWorkspaceGroupElements(currentWorkspaceId);

      workspaceGroups.forEach((groupEl) => {
        const label = groupEl.getAttribute("label");
        if (label) {
          allExistingGroupNames.add(label);
        }
      });

      // --- Filter initial tabs using optimized function ---
      // When sorting INTO FOLDERS, include pinned tabs: Zen folders only
      // hold pinned tabs, so excluding them would leave the user's
      // pinned content (often the tabs they most want organized) stranded
      // outside any folder.
      const initialTabsToSort = getFilteredTabs(currentWorkspaceId, {
        includeGrouped: false,
        includeSelected: true,
        includePinned: useFolders,
        includeEmpty: false,
        includeGlance: false,
      }).filter((tab) => {
        if (shouldProtectTabFromGrouping(tab)) return false;
        return !isTabInWorkspaceGroup(tab, currentWorkspaceId);
      });

      if (initialTabsToSort.length === 0) {
        console.log("[TabSort] No eligible tabs to sort in current workspace.");
        return;
      }

      // --- Engine selection ---
      // The dropdown controls the grouping backend. Each non-hybrid option
      // is independent: selecting "OpenRouter" never silently falls back to
      // fuzzy, and selecting "Fuzzy" never touches the network. Only "Hybrid"
      // chains: OpenRouter → local AI → fuzzy.
      let finalGroups = {};
      let aiTabTopics = [];
      let engineProducedGroups = false;
      let usedFuzzy = false;
      const engine = getSelectedEngine();
      console.log(`[TabSort] Engine selected: ${engine}`);

      if (engine === "none") {
        console.warn(
          `[TabSort] Selected engine is unavailable. Check preferences (e.g. missing API key for OpenRouter, or browser.ml.enabled off for Local AI).`
        );
        if (CONFIG.ENABLE_FAILURE_ANIMATION) startFailureAnimation();
        return;
      }

      // ----- OpenRouter -----
      if (engine === "openrouter" || engine === "hybrid") {
        console.log(
          "[TabSort] Using OpenRouter full-grouping for",
          initialTabsToSort.length,
          "tabs"
        );
        const remoteGroups = await askOpenRouterForGroups(
          initialTabsToSort,
          allExistingGroupNames,
          useFolders
        );
        if (remoteGroups && Object.keys(remoteGroups).length > 0) {
          finalGroups = consolidateSimilarGroupNames(
            remoteGroups,
            allExistingGroupNames
          );
          engineProducedGroups = true;
        }
      }

      // ----- Local AI -----
      if (
        (engine === "local-ai" || (engine === "hybrid" && !engineProducedGroups)) &&
        isAIEnabled()
      ) {
        console.log(
          engine === "hybrid"
            ? "[TabSort] OpenRouter returned nothing; trying local AI..."
            : "[TabSort] Using local AI grouping for",
          initialTabsToSort.length,
          "tabs"
        );
        aiTabTopics = await askAIForMultipleTopics(initialTabsToSort);
        console.log(
          "[TabSort] AI returned",
          aiTabTopics.length,
          "tab-topic pairs"
        );
        aiTabTopics.forEach(({ tab, topic }) => {
          if (!topic || topic === "Uncategorized" || !tab || !tab.isConnected) return;
          if (!finalGroups[topic]) finalGroups[topic] = [];
          finalGroups[topic].push(tab);
        });
        finalGroups = consolidateSimilarGroupNames(finalGroups, allExistingGroupNames);
        engineProducedGroups = aiTabTopics.length > 0;
      }

      // ----- Fuzzy -----
      if (
        engine === "fuzzy" ||
        (engine === "hybrid" && !engineProducedGroups)
      ) {
        console.log(
          engine === "hybrid"
            ? "[TabSort] Local AI unavailable; falling back to fuzzy..."
            : "[TabSort] Using fuzzy grouping for",
          initialTabsToSort.length,
          "tabs"
        );
        finalGroups = fuzzyGroupByTokens(initialTabsToSort, allExistingGroupNames);
        engineProducedGroups = Object.keys(finalGroups).length > 0;
        usedFuzzy = true;
      }

      // --- Rescue ungrouped tabs ---
      // Rescue passes are fuzzy post-processing: they only run when fuzzy
      // was actually used (either as the primary engine or as hybrid fallback).
      if (usedFuzzy) {
        console.log(
          `[TabSort] Running post-grouping rescue passes on ${Object.keys(finalGroups).length} initial group(s).`
        );
        finalGroups = applyPostGroupingRescue(
          initialTabsToSort,
          finalGroups,
          CONFIG.GROUP_LEFTOVERS_AS_MISC
        );
      } else {
        console.log(
          "[TabSort] Skipping rescue passes — engine was AI/OpenRouter, rescue is fuzzy-only."
        );
      }

      const finalGroupNames = Object.keys(finalGroups);
      console.log(
        `[TabSort] Final groups (${finalGroupNames.length}):`,
        finalGroupNames.map((n) => `${n} (${finalGroups[n].length})`).join(", ")
      );

      // --- Failure check ---
      // We animate the spiky "failure" only when there's genuinely nothing
      // to show for the sort: no multi-tab groups emerged AND the chosen
      // engine never produced anything pre-rescue AND there were enough
      // tabs that grouping was even expected. `engineProducedGroups`
      // replaces the old aiEnabled/aiTabTopics special-case so OpenRouter
      // and fuzzy paths are treated consistently.
      const multiTabGroups = Object.values(finalGroups).filter((tabs) => tabs.length > 1);
      const sortingFailed =
        multiTabGroups.length === 0 &&
        !engineProducedGroups &&
        initialTabsToSort.length > 1;

      if (sortingFailed) {
        if (CONFIG.ENABLE_FAILURE_ANIMATION) startFailureAnimation();
        return;
      }

      if (Object.keys(finalGroups).length === 0) {
        console.log("[TabSort] No groups produced after rescue pipeline.");
        return;
      }

      // --- Get existing group ELEMENTS ---
      const existingContainersByLabel = new Map();
      workspaceGroups.forEach((groupEl) => {
        const label = groupEl.getAttribute("label");
        if (!label) return;
        const key = getLabelKey(label);
        if (!key) return;
        const entry = existingContainersByLabel.get(key) || {
          folder: null,
          group: null,
        };
        if (isFolderGroupElement(groupEl)) {
          entry.folder = groupEl;
        } else {
          entry.group = groupEl;
        }
        existingContainersByLabel.set(key, entry);
      });

      const getExistingContainer = (topic) => {
        const key = getLabelKey(topic);
        if (!key) return null;
        const entry = existingContainersByLabel.get(key);
        if (!entry) return null;
        return useFolders ? entry.folder : entry.group;
      };

      // --- Process each final, consolidated group ---
      for (const topic in finalGroups) {
        const tabsForThisTopic = finalGroups[topic].filter((t) => {
          if (!t?.isConnected) return false;
          if (shouldProtectTabFromGrouping(t)) return false;
          return !isTabInWorkspaceGroup(t, currentWorkspaceId);
        });

        if (tabsForThisTopic.length === 0) {
          continue;
        }

        const existingGroupElement = getExistingContainer(topic);

        if (existingGroupElement && existingGroupElement.isConnected) {
          try {
            if (existingGroupElement.getAttribute("collapsed") === "true") {
              existingGroupElement.setAttribute("collapsed", "false");
              const groupLabelElement =
                existingGroupElement.querySelector(".tab-group-label");
              if (groupLabelElement) {
                groupLabelElement.setAttribute("aria-expanded", "true");
              }
            }
            for (const tab of tabsForThisTopic) {
              if (tab && tab.isConnected && !isTabInWorkspaceGroup(tab, currentWorkspaceId)) {
                if (isFolderGroupElement(existingGroupElement)) {
                  // Zen folders only hold pinned tabs, so pin before adding or
                  // the tab appears to move but never attaches to the folder.
                  try {
                    if (!tab.pinned) gBrowser.pinTab(tab);
                  } catch (pinErr) {
                    console.warn("[TidyTabs] pinTab failed before addTabs:", pinErr);
                  }
                  existingGroupElement.addTabs([tab]);
                } else {
                  gBrowser.moveTabToExistingGroup(tab, existingGroupElement);
                }
              } else {
                console.warn(
                  ` -> Tab "${
                    getTabTitle(tab) || "Unknown"
                  }" skipped moving to "${topic}" (already grouped or invalid).`
                );
              }
            }
          } catch (e) {
            console.error(
              `Error moving tabs to existing group "${topic}":`,
              e,
              existingGroupElement
            );
          }
        } else {
          if (existingGroupElement && !existingGroupElement.isConnected) {
            console.warn(
              ` -> Existing group element for "${topic}" was found in map but is no longer connected to DOM. Will create a new group.`
            );
          }

          // Create group/folder for any topic with tabs
          if (tabsForThisTopic.length > 0) {
            try {
              let createdContainer = null;

              if (useFolders && typeof gZenFolders?.createFolder === "function") {
                if (topic.includes(NESTED_GROUP_DELIMITER)) {
                  const pathParts = topic.split(NESTED_GROUP_DELIMITER);
                  if (pathParts.length === 2) {
                    createdContainer = await ensureNestedFolder(
                      pathParts,
                      tabsForThisTopic,
                      currentWorkspaceId
                    );
                    if (createdContainer?.isConnected) {
                      upsertContainerByLabel(
                        existingContainersByLabel,
                        topic,
                        "folder",
                        createdContainer
                      );
                    }
                  }
                  // If nested creation failed or path >2 levels, fall back to a flat folder.
                  if (!createdContainer?.isConnected) {
                    const flatLabel = pathParts?.pop().trim() || topic;
                    createdContainer = findTopLevelFolderByLabel(
                      flatLabel,
                      currentWorkspaceId
                    );
                    if (createdContainer?.isConnected) {
                      const tabsForFolder = tabsForThisTopic.filter(
                        (t) => t?.isConnected
                      );
                      tabsForFolder.forEach((t) => {
                        try {
                          if (!t.pinned) gBrowser.pinTab(t);
                        } catch (pinErr) {
                          console.warn("[TidyTabs] pinTab failed:", pinErr);
                        }
                      });
                      if (tabsForFolder.length) {
                        createdContainer.addTabs(tabsForFolder);
                      }
                      createdContainer.collapsed = false;
                      upsertContainerByLabel(
                        existingContainersByLabel,
                        flatLabel,
                        "folder",
                        createdContainer
                      );
                    } else {
                      createdContainer = gZenFolders.createFolder(
                        tabsForThisTopic.filter((t) => t?.isConnected),
                        {
                          renameFolder: false,
                          label: flatLabel,
                          workspaceId: currentWorkspaceId,
                        }
                      );
                      if (createdContainer?.isConnected) {
                        createdContainer.collapsed = false;
                        upsertContainerByLabel(
                          existingContainersByLabel,
                          flatLabel,
                          "folder",
                          createdContainer
                        );
                      }
                    }
                  }
                } else {
                  createdContainer = findTopLevelFolderByLabel(
                    topic,
                    currentWorkspaceId
                  );

                  if (createdContainer?.isConnected) {
                    // Existing folder: pin tabs first, then attach to folder.
                    // Folders only accept pinned tabs (see ZenFolders.mjs createFolder).
                    const tabsForFolder = tabsForThisTopic.filter(
                      (t) => t?.isConnected
                    );
                    tabsForFolder.forEach((t) => {
                      try {
                        if (!t.pinned) gBrowser.pinTab(t);
                      } catch (pinErr) {
                        console.warn("[TidyTabs] pinTab failed:", pinErr);
                      }
                    });
                    if (tabsForFolder.length) {
                      createdContainer.addTabs(tabsForFolder);
                    }
                    createdContainer.collapsed = false;
                    upsertContainerByLabel(
                      existingContainersByLabel,
                      topic,
                      "folder",
                      createdContainer
                    );
                  } else {
                    // Pass tabs directly to createFolder so it pins and attaches
                    // them atomically. Passing [] then calling addTabs leaves the
                    // folder empty because the tabs never get pinned.
                    createdContainer = gZenFolders.createFolder(
                      tabsForThisTopic.filter((t) => t?.isConnected),
                      {
                        renameFolder: false,
                        label: topic,
                        workspaceId: currentWorkspaceId,
                      }
                    );
                    if (createdContainer?.isConnected) {
                      createdContainer.collapsed = false;
                      upsertContainerByLabel(
                        existingContainersByLabel,
                        topic,
                        "folder",
                        createdContainer
                      );
                    }
                  }
                }
              } else {
                // Tab groups cannot nest — flatten to a single label.
                const groupLabel = topic.includes(NESTED_GROUP_DELIMITER)
                  ? topic.split(NESTED_GROUP_DELIMITER).pop().trim()
                  : topic;
                const firstValidTabForGroup = tabsForThisTopic[0];
                const groupOptions = {
                  label: groupLabel,
                  insertBefore: firstValidTabForGroup,
                };
                const newGroup = gBrowser.addTabGroup(
                  tabsForThisTopic,
                  groupOptions
                );
                processTabGroup(newGroup);
                upsertContainerByLabel(
                  existingContainersByLabel,
                  topic,
                  "group",
                  newGroup
                );
              }
            } catch (e) {
              console.error(`Error creating container for topic "${topic}":`, e);
            }
          } else {
          }
        }
      } // End loop through final groups

      // --- Reorder tabs: groups first, then ungrouped tabs ---
      try {
        const workspaceElement = gZenWorkspaces?.activeWorkspaceElement;
        reorderWorkspaceTabs(
          workspaceElement,
          finalGroups,
          shouldProtectTabFromGrouping
        );
      } catch (reorderError) {
        console.error("Error reordering tabs (groups first):", reorderError);
        // Don't fail the whole sort if reordering fails
      }
    } catch (error) {
      console.error("Error during overall sorting process:", error);
    } finally {
      // If failure animation is playing, delay the cleanup
      if (isPlayingFailureAnimation) {
        setTimeout(() => {
          isSorting = false;
          setSortingVisualState(false);
          cleanupAnimation();
          if (separatorsToSort.length > 0) {
            separatorsToSort.forEach((sep) => {
              if (sep?.isConnected) sep.classList.remove("separator-is-sorting");
            });
          }
        }, CONFIG.FAILURE_PULSE_DURATION * CONFIG.FAILURE_PULSE_COUNT + 300);
      } else {
        setTimeout(() => {
          isSorting = false;
          setSortingVisualState(false);
          cleanupAnimation();
          if (separatorsToSort.length > 0) {
            separatorsToSort.forEach((sep) => {
              if (sep?.isConnected) sep.classList.remove("separator-is-sorting");
            });
          }
        }, 800);
      }
    }
  };

  // --- Sidebar Context Menu ------------------------------------------------
  // Strategy (learned from the previous attempt):
  //
  // 1. We can't rely on a specific popup ID (Zen has moved menus around and
  //    the sidebar's context attribute varies by version).
  // 2. Instead we watch ALL `popupshowing` events at the document root.
  //    When a menupopup opens and its trigger node lives inside the sidebar
  //    tabs area (but not on an actual tab/group/toolbarbutton), we append
  //    our items to that popup — whatever its ID happens to be.
  // 3. As a safety net, if the user right-clicks the sidebar and nothing
  //    else handles the contextmenu, we open our own popup.
  //
  // Icon rendering: set the SVG via the `image` attribute using a base64
  // data URI. This is the bullet-proof XUL path — unlike url-encoded
  // data URIs or CSS list-style-image, it has worked on every Firefox
  // chrome version for a decade. Stroke uses a neutral gray that reads
  // on both light and dark themes (we can theme this later once the
  // basic feature is visible).

  const SIDEBAR_MENU_ITEMS = [
    {
      id: "tidy-tabs-sort-groups",
      label: "Tidy Tabs into Groups",
      iconKey: "groups",
      prefKey: "MENU_SORT_GROUPS",
      useFolders: false,
    },
    {
      id: "tidy-tabs-sort-folders",
      label: "Tidy Tabs into Folders",
      iconKey: "folders",
      prefKey: "MENU_SORT_FOLDERS",
      useFolders: true,
    },
  ];

  const TIDY_TABS_MENU_ITEM_CLASS = "tidy-tabs-menuitem";

  // Lucide icons with a `{{STROKE}}` placeholder. Data-URI SVGs rendered
  // through XUL `image` attrs DO NOT inherit currentColor or honor
  // -moz-context-properties, so we have to bake the stroke color into
  // the SVG source at inject time.
  const TIDY_TABS_ICON_SVGS = {
    // layers
    groups:
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="{{STROKE}}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>`,
    // folder-tree
    folders:
      `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="{{STROKE}}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z"/><path d="M3 5a2 2 0 0 0 2 2h3"/><path d="M3 3v13a2 2 0 0 0 2 2h3"/></svg>`,
  };

  // Pick a stroke color that reads well on the current menu background.
  //
  // In chrome windows, `document.documentElement.color` is the effective UI
  // text color — dark on light themes and light on dark themes — which is
  // exactly the contrast we want for menu icons. That's far more reliable
  // than poking at individual CSS custom properties (which Zen overrides
  // in non-obvious ways).
  const getMenuIconStroke = () => {
    try {
      const color = window.getComputedStyle(document.documentElement).color;
      // rgba(0,0,0,0) means "no color set" — skip it so we don't render
      // a transparent icon.
      if (color && color !== "rgba(0, 0, 0, 0)") return color;
    } catch {}
    try {
      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      return isDark ? "#e0e0e0" : "#3a3a3a";
    } catch {}
    return "#888";
  };

  const svgToDataURI = (svg) => {
    try {
      // btoa needs Latin-1; our SVGs are ASCII-only so this is safe.
      return "data:image/svg+xml;base64," + btoa(svg);
    } catch {
      return "";
    }
  };

  const buildIconDataURI = (iconKey) => {
    const template = TIDY_TABS_ICON_SVGS[iconKey];
    if (!template) return "";
    return svgToDataURI(template.replace(/\{\{STROKE\}\}/g, getMenuIconStroke()));
  };

  function createTidyTabsMenuItem(item) {
    const mi = document.createXULElement("menuitem");
    mi.id = item.id;
    mi.className = `menuitem-iconic ${TIDY_TABS_MENU_ITEM_CLASS}`;
    mi.setAttribute("label", item.label);
    const uri = buildIconDataURI(item.iconKey);
    if (uri) mi.setAttribute("image", uri);
    mi.addEventListener("command", () => sortTabsByTopic(item.useFolders));
    return mi;
  }

  function getEnabledMenuItems() {
    return SIDEBAR_MENU_ITEMS.filter((item) => CONFIG[item.prefKey]);
  }

  // Inject our items (plus a separator) into the given menupopup.
  // Idempotent: skips if our items already live in the popup.
  function injectItemsInto(popup) {
    if (!popup || popup.tagName !== "menupopup") return;
    if (popup.querySelector(`.${TIDY_TABS_MENU_ITEM_CLASS}`)) return;

    const items = getEnabledMenuItems();
    if (!items.length) return;

    const sep = document.createXULElement("menuseparator");
    sep.className = `${TIDY_TABS_MENU_ITEM_CLASS} tidy-tabs-menu-separator`;
    popup.appendChild(sep);
    items.forEach((item) => popup.appendChild(createTidyTabsMenuItem(item)));
  }

  // Where in the DOM does a right-click count as "the sidebar tabs area"?
  // We inject only when the trigger is inside one of these containers AND
  // NOT on an interactive element that already has its own context menu.
  const SIDEBAR_TRIGGER_SELECTOR =
    "#tabbrowser-arrowscrollbox, .zen-workspace-tabs-section, " +
    ".zen-workspace-empty-space, #vertical-pinned-tabs-container, " +
    ".pinned-tabs-container-separator";
  const SIDEBAR_IGNORE_SELECTOR =
    "tab:not([zen-empty-tab]), tab-group > .tab-group-label-container, " +
    "zen-folder > .tab-group-label-container, toolbarbutton, " +
    ".tab-close-button";

  function isSidebarBackgroundTrigger(node) {
    if (!node) return false;
    if (node.closest?.(SIDEBAR_IGNORE_SELECTOR)) return false;
    return !!node.closest?.(SIDEBAR_TRIGGER_SELECTOR);
  }

  // Fallback popup, used only when the right-click wouldn't otherwise open
  // a native menu (e.g. on the empty-space vbox which has no `context=`).
  let fallbackPopup = null;
  function ensureFallbackPopup() {
    if (fallbackPopup?.isConnected) return fallbackPopup;

    const existing = document.getElementById("tidy-tabs-sidebar-menu");
    if (existing) existing.remove();

    const items = getEnabledMenuItems();
    if (!items.length) return null;

    const popup = document.createXULElement("menupopup");
    popup.id = "tidy-tabs-sidebar-menu";
    items.forEach((item) => popup.appendChild(createTidyTabsMenuItem(item)));

    (document.getElementById("mainPopupSet") || document.documentElement).appendChild(popup);
    fallbackPopup = popup;
    return popup;
  }

  function ensureSidebarContextMenu() {
    if (sidebarMenuListenersAdded) {
      ensureFallbackPopup();
      return;
    }

    sidebarMenuListenersAdded = true;

    // Build (and stash) the fallback popup up front so it's ready to show
    // on demand. Building it lazily from the contextmenu handler races
    // with the event default.
    ensureFallbackPopup();

    sidebarPopupShowingHandler = (event) => {
      const popup = event.target;
      if (!popup || popup.tagName !== "menupopup") return;

      // Don't self-inject into our own fallback popup (already populated).
      if (popup.id === "tidy-tabs-sidebar-menu") return;

      // Skip bookmarks/history/etc. menus where triggerNode is null.
      const trigger = popup.triggerNode;
      if (!isSidebarBackgroundTrigger(trigger)) return;

      injectItemsInto(popup);
    };

    sidebarContextMenuHandler = (event) => {
      const trigger = event.target;
      if (!isSidebarBackgroundTrigger(trigger)) return;

      // If the event is already going to bring up a native menu (because
      // an ancestor has `context="..."`), just let popupshowing handle it.
      const hasNativeContext =
        !!trigger.closest?.("[context]") ||
        !!trigger.closest?.("[popup]");
      if (hasNativeContext) return;

      const popup = ensureFallbackPopup();
      if (!popup) return;

      event.preventDefault();
      event.stopPropagation();
      popup.openPopupAtScreen(event.screenX, event.screenY, true);
    };

    // Primary path: intercept every popupshowing. If the popup was
    // triggered from the sidebar background, inject our items.
    document.addEventListener(
      "popupshowing",
      sidebarPopupShowingHandler,
      true
    );

    // Secondary path: right-clicks that don't open any native menu
    // (e.g. the `.zen-workspace-empty-space` vbox) get our fallback.
    // We defer with a 0ms timeout so if a native popup IS going to open,
    // the default has already done so by the time we run.
    document.addEventListener(
      "contextmenu",
      sidebarContextMenuHandler,
      true
    );
  }

  // --- gZenWorkspaces Hooks ---
  function setupgZenWorkspacesHooks() {
    if (typeof window.gZenWorkspaces === "undefined" || gZenWorkspaceHooksApplied) {
      return;
    }

    originalWorkspaceOnTabBrowserInserted =
      window.gZenWorkspaces.onTabBrowserInserted;
    originalWorkspaceUpdateTabsContainers =
      window.gZenWorkspaces.updateTabsContainers;

    window.gZenWorkspaces.onTabBrowserInserted = function (event) {
      if (typeof originalWorkspaceOnTabBrowserInserted === "function") {
        try {
          originalWorkspaceOnTabBrowserInserted.call(window.gZenWorkspaces, event);
        } catch (e) {
          console.error(
            "[TidyTabs] Error in original onTabBrowserInserted:",
            e
          );
        }
      }
    };

    window.gZenWorkspaces.updateTabsContainers = function (...args) {
      if (typeof originalWorkspaceUpdateTabsContainers === "function") {
        try {
          originalWorkspaceUpdateTabsContainers.apply(window.gZenWorkspaces, args);
        } catch (e) {
          console.error(
            "[TidyTabs] Error in original updateTabsContainers:",
            e
          );
        }
      }
    };

    gZenWorkspaceHooksApplied = true;
  }

  // --- Patch Clear Button to Preserve Tab-Groups ---
  function patchClearButtonToPreserveGroups() {
    if (typeof window.gZenWorkspaces === "undefined") {
      console.warn("[TidyTabs] gZenWorkspaces not available, cannot patch clear button");
      return;
    }

    if (clearButtonPatched && originalCloseAllUnpinnedTabs) {
      if (!CONFIG.ENABLE_CLEAR_BUTTON_PATCH) {
        window.gZenWorkspaces.closeAllUnpinnedTabs = originalCloseAllUnpinnedTabs;
      }
      return;
    }

    if (!CONFIG.ENABLE_CLEAR_BUTTON_PATCH) {
      return;
    }

    // Store the original method once
    originalCloseAllUnpinnedTabs = window.gZenWorkspaces.closeAllUnpinnedTabs;
    
    if (typeof originalCloseAllUnpinnedTabs !== "function") {
      console.warn("[TidyTabs] closeAllUnpinnedTabs method not found");
      originalCloseAllUnpinnedTabs = null;
      return;
    }

    // Override the method
    window.gZenWorkspaces.closeAllUnpinnedTabs = function() {
      console.log("[TidyTabs] Clear button clicked - filtering to preserve tab-groups");
      
      try {
        // Get the ACTIVE workspace ID - this is critical!
        const currentWorkspaceId = this.activeWorkspace;
        if (!currentWorkspaceId) {
          console.warn("[TidyTabs] No active workspace found");
          return;
        }
        
        // Workspace-scoped tab snapshots.
        const allTabs = getFilteredTabs(currentWorkspaceId, {
          includeGrouped: true,
          includeSelected: true,
          includePinned: true,
          includeEmpty: true,
          includeGlance: true,
        });
        const closeCandidates = getFilteredTabs(currentWorkspaceId, {
          includeGrouped: true,
          includeSelected: false,
          includePinned: false,
          includeEmpty: false,
          includeGlance: false,
        });

        // Preserve grouped/folder tabs (except split-view groups) while still
        // clearing truly loose tabs. `getTabContainerGroup` is used instead of
        // `tab.group` because Zen occasionally exposes group ancestry via DOM
        // without wiring the direct `tab.group` property.
        const tabsToClose = closeCandidates.filter((tab) => {
          if (tab.hasAttribute("zen-essential")) {
            return false;
          }

          const groupContainer = getTabContainerGroup(tab);
          if (!groupContainer) return true;

          if (isFolderGroupElement(groupContainer)) {
            return false;
          }

          const groupTag = groupContainer.tagName?.toLowerCase();
          if (
            groupTag === "tab-group" &&
            !groupContainer.hasAttribute("split-view-group")
          ) {
            return false;
          }

          return true;
        });
        
        console.log(`[TidyTabs] Closing ${tabsToClose.length} tabs, preserving ${allTabs.length - tabsToClose.length} tabs`);
        
        // Close the filtered tabs
        if (tabsToClose.length > 0) {
          gBrowser.removeTabs(tabsToClose);
          
          // Show a toast notification
          if (typeof gZenUIManager !== "undefined" && gZenUIManager.showToast) {
            gZenUIManager.showToast("zen-workspaces-close-all-unpinned-tabs-toast", {
              shortcut: "Ctrl+Shift+T"
            });
          }
        } else {
          console.log("[TidyTabs] No tabs to close");
        }
      } catch (error) {
        console.error("[TidyTabs] Error in patched closeAllUnpinnedTabs:", error);
        // Fallback to original method if there's an error
        if (typeof originalCloseAllUnpinnedTabs === "function") {
          originalCloseAllUnpinnedTabs.call(this);
        }
      }
    };
    clearButtonPatched = true;
    
    console.log("[TidyTabs] Successfully patched closeAllUnpinnedTabs to preserve tab-groups");
  }

  const isLooseUngroupedTab = (node) =>
    node?.tagName?.toLowerCase() === "tab" &&
    !node.hasAttribute("zen-empty-tab") &&
    !node.hasAttribute("zen-glance-tab") &&
    !getTabContainerGroup(node);

  const moveNodeAfter = (node, anchor, container) => {
    if (!node?.isConnected || !container?.isConnected) return anchor;
    if (!anchor?.isConnected) {
      if (container.lastChild !== node) {
        container.appendChild(node);
      }
      return node;
    }
    const next = anchor.nextSibling;
    if (next) {
      container.insertBefore(node, next);
    } else {
      container.appendChild(node);
    }
    return node;
  };

  const reorderWorkspaceTabs = (workspaceElement, _finalGroups, protectHost) => {
    if (!workspaceElement?.tabsContainer || !CONFIG.REORDER_GROUPS_FIRST) return;

    const tabsContainer = workspaceElement.tabsContainer;

    const allChildren = Array.from(tabsContainer.children);
    const groupedChildren = allChildren.filter(
      (child) => {
        const tag = child?.tagName?.toLowerCase();
        return tag === "tab-group" || tag === "zen-folder";
      }
    );
    if (!groupedChildren.length) return;
    let anchor = groupedChildren[groupedChildren.length - 1];

    const looseTabs = Array.from(tabsContainer.children).filter((child) =>
      isLooseUngroupedTab(child)
    );
    if (!looseTabs.length) return;

    looseTabs.forEach((tab) => {
      if (protectHost(tab)) return;
      anchor = moveNodeAfter(tab, anchor, tabsContainer);
    });

    const protectedLooseTabs = looseTabs.filter((tab) => protectHost(tab));
    protectedLooseTabs.forEach((tab) => {
      anchor = moveNodeAfter(tab, anchor, tabsContainer);
    });
  };

  // --- Add Tab Event Listeners ---
  function addTabEventListeners() {
    if (
      eventListenersAdded ||
      typeof gBrowser === "undefined" ||
      !gBrowser.tabContainer
    ) {
      return;
    }

    tabContainerEventHandler = () => {
    };

    TAB_CONTAINER_EVENTS.forEach((eventName) => {
      gBrowser.tabContainer.addEventListener(eventName, tabContainerEventHandler);
    });

    eventListenersAdded = true;
  }

  // --- Cleanup Function ---
  const cleanup = () => {
    try {
      // Stop any running animations
      cleanupAnimation();

      if (faviconRefreshRaf !== null) {
        cancelAnimationFrame(faviconRefreshRaf);
        faviconRefreshRaf = null;
      }
      faviconRefreshPending = false;
      faviconRefreshInFlight = false;

      if (clearButtonPatched && originalCloseAllUnpinnedTabs && window.gZenWorkspaces) {
        window.gZenWorkspaces.closeAllUnpinnedTabs = originalCloseAllUnpinnedTabs;
        clearButtonPatched = false;
      }
      originalCloseAllUnpinnedTabs = null;

      if (gZenWorkspaceHooksApplied && window.gZenWorkspaces) {
        if (typeof originalWorkspaceOnTabBrowserInserted === "function") {
          window.gZenWorkspaces.onTabBrowserInserted =
            originalWorkspaceOnTabBrowserInserted;
        }
        if (typeof originalWorkspaceUpdateTabsContainers === "function") {
          window.gZenWorkspaces.updateTabsContainers =
            originalWorkspaceUpdateTabsContainers;
        }
        gZenWorkspaceHooksApplied = false;
      }
      originalWorkspaceOnTabBrowserInserted = null;
      originalWorkspaceUpdateTabsContainers = null;

      if (
        eventListenersAdded &&
        tabContainerEventHandler &&
        typeof gBrowser !== "undefined" &&
        gBrowser?.tabContainer
      ) {
        TAB_CONTAINER_EVENTS.forEach((eventName) => {
          gBrowser.tabContainer.removeEventListener(eventName, tabContainerEventHandler);
        });
      }
      tabContainerEventHandler = null;

      if (sidebarPopupShowingHandler) {
        document.removeEventListener(
          "popupshowing",
          sidebarPopupShowingHandler,
          true
        );
        sidebarPopupShowingHandler = null;
      }

      if (sidebarContextMenuHandler) {
        document.removeEventListener(
          "contextmenu",
          sidebarContextMenuHandler,
          true
        );
        sidebarContextMenuHandler = null;
      }
      sidebarMenuListenersAdded = false;

      if (fallbackPopup?.isConnected) {
        fallbackPopup.remove();
      }
      fallbackPopup = null;

      embeddingEnginePromise = null;
      namingEnginePromise = null;
      EMBEDDING_CACHE.clear();
      FAVICON_COLOR_CACHE.clear();

      // Clear DOM cache
      domCache.invalidate();

      // Reset state
      isSorting = false;
      setSortingVisualState(false);
      eventListenersAdded = false;

      console.log("Tab sort script cleanup completed");
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  };

  // --- Initial Setup Trigger ---
  function initializeScript() {
    const tryInitialize = () => {
      try {
        const gBrowserReady =
          typeof gBrowser !== "undefined" && gBrowser?.tabContainer;
        const gZenWorkspacesReady =
          typeof window.gZenWorkspaces !== "undefined";

        const ready = gBrowserReady && gZenWorkspacesReady;

        if (ready) {
          ensureSidebarContextMenu();
          setupgZenWorkspacesHooks();
          patchClearButtonToPreserveGroups();
          addTabEventListeners();
          processExistingTabGroups();

          return true;
        }
      } catch (e) {
        console.error("Error during initialization:", e);
      }
      return false;
    };

    // Try immediate initialization
    if (tryInitialize()) return;

    // Fallback to polling
    let checkCount = 0;
    const initCheckInterval = setInterval(() => {
      checkCount++;

      if (tryInitialize()) {
        clearInterval(initCheckInterval);
      } else if (checkCount > CONFIG.MAX_INIT_CHECKS) {
        clearInterval(initCheckInterval);
        console.warn(
          `Tab sort initialization timed out after ${
            CONFIG.MAX_INIT_CHECKS * CONFIG.INIT_CHECK_INTERVAL
          }ms`
        );
      }
    }, CONFIG.INIT_CHECK_INTERVAL);
  }

  // --- Start Initialization ---
  if (document.readyState === "complete") {
    initializeScript();
  } else {
    window.addEventListener("load", initializeScript, { once: true });
  }

  // --- Add Cleanup Listeners ---
  window.addEventListener("unload", cleanup, { once: true });
  window.addEventListener("beforeunload", cleanup, { once: true });
})(); // End script
