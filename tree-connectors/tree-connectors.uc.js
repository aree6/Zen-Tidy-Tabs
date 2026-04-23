// ==UserScript==
// @ignorecache
// @name          Zen Tree Connectors
// @description   Visual tree connectors for Zen Browser folder tabs and tab groups
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
    TREE_CONNECTORS_ENABLED: true,
    TREE_INCLUDE_RELATED_TABS: true,
    TREE_REFRESH_ON_ANIMATIONS: true,
    TREE_LINE_X: 6,
    TREE_STROKE_WIDTH: 2,
    TREE_BRANCH_RADIUS: 7,
    TREE_OPACITY: 0.25,
    TREE_BRANCH_OVERSHOOT: 0,
    TREE_FOLDER_INDENT_PX: 12,
    TREE_RELATED_CHILD_INDENT_PX: 20,
    TREE_CONNECTOR_OFFSET_PX: -15,
    // Per-menu-item visibility. Users can hide either entry if they only
    // use one container style.
    MENU_SORT_GROUPS: true,
    MENU_SORT_FOLDERS: true,
    // After AI/fuzzy, any tabs that didn't land in a group are bucketed
    // into a single "Miscellaneous" group so nothing is left stranded.
    // Turn off if you prefer leftovers to stay loose in the sidebar.
    GROUP_LEFTOVERS_AS_MISC: true,
    // Grouping backend. "local" keeps everything on-device (Firefox ML
    // embeddings + local topic naming). Any other value must be a key in
    // OPENROUTER_MODELS below and routes the ENTIRE grouping decision
    // through OpenRouter using the user's API key.
    AI_GROUP_NAMER: "local",
    // OpenRouter API key. Only read when AI_GROUP_NAMER != "local".
    // Stored verbatim in the pref store; empty string disables the path.
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

  const chooseGroupingEngine = (tabs) => {
    const validTabs = (tabs || []).filter((tab) => tab?.isConnected);
    if (validTabs.length < 2) {
      return {
        engine: "fuzzy",
        reason: "Not enough tabs for model clustering",
      };
    }

    if (validTabs.length > MAX_TABS_FOR_MODEL_GROUPING) {
      return {
        engine: "fuzzy",
        reason: `Large batch (${validTabs.length} tabs)`,
      };
    }

    const titleSignal = getTitleSignalStats(validTabs);
    const lowSignal =
      titleSignal.ratio < MIN_TITLE_SIGNAL_RATIO_FOR_MODEL_GROUPING;

    if (isOpenRouterConfigured() && !lowSignal) {
      return {
        engine: "openrouter",
        reason: `OpenRouter configured + strong title signal (${titleSignal.meaningful}/${titleSignal.total})`,
      };
    }

    if (isAIEnabled() && !lowSignal) {
      return {
        engine: "local-ai",
        reason: `Local AI available + strong title signal (${titleSignal.meaningful}/${titleSignal.total})`,
      };
    }

    if (isOpenRouterConfigured() || isAIEnabled()) {
      return {
        engine: "fuzzy",
        reason: `Low title signal (${titleSignal.meaningful}/${titleSignal.total})`,
      };
    }

    return {
      engine: "fuzzy",
      reason: "AI disabled",
    };
  };

  // Short dropdown slug -> OpenRouter model ID. Slugs are used as the pref
  // value (safer across Zen's dropdown schema than slashes/colons), and the
  // mapped ID is what we send in the API request body.
  //
  // Picks (researched Apr 2026 against openrouter.ai/collections/free-models
  // for this specific use case — short topic-label generation from tab titles):
  //   - gemma3-27b:   balanced speed + quality, strong short-label outputs
  //   - llama33-70b:  most accurate free instruct model, best fallback quality
  //   - ling-flash:   explicitly "flash" model (7.4B active), lowest latency
  //   - glm-air:      lightweight MoE with non-thinking mode for real-time
  const OPENROUTER_MODELS = {
    "gemma3-27b": "google/gemma-3-27b-it:free",
    "llama33-70b": "meta-llama/llama-3.3-70b-instruct:free",
    "ling-flash": "inclusionai/ling-2.6-flash:free",
    "glm-air": "z-ai/glm-4.5-air:free",
  };

  const PREF_BRANCH = "zen.tidytabs.";
  const PREFS = {
    GROUPING_STRENGTH: ["double", "grouping-strength"],
    ENABLE_FAILURE_ANIMATION: ["bool", "ui.enable-failure-animation"],
    ENABLE_CLEAR_BUTTON_PATCH: ["bool", "behavior.patch-clear-button"],
    TREE_CONNECTORS_ENABLED: ["bool", "tree.enabled"],
    MENU_SORT_GROUPS: ["bool", "menu.sort-groups"],
    MENU_SORT_FOLDERS: ["bool", "menu.sort-folders"],
    GROUP_LEFTOVERS_AS_MISC: ["bool", "group-leftovers-as-misc"],
    AI_GROUP_NAMER: ["string", "ai.group-namer"],
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
    const slug = (CONFIG.AI_GROUP_NAMER || "local").trim();
    if (!slug || slug === "local") return false;
    if (!OPENROUTER_MODELS[slug]) return false;
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

    const modelSlug = (CONFIG.AI_GROUP_NAMER || "").trim();
    const modelId = OPENROUTER_MODELS[modelSlug];
    const apiKey = (CONFIG.OPENROUTER_API_KEY || "").trim();

    // Numbered list keeps the contract tight: "give me back these numbers".
    // Numbers are way more reliable than asking the model to echo titles
    // (which it will paraphrase, truncate, or case-change).
    const lines = validTabs.map((tab, i) => {
      const title = (getTabTitle(tab) || "Untitled").slice(0, 140);
      const host = getTabHost(tab) || "—";
      return `${i + 1}. [${host}] ${title}`;
    });

    const existingHint =
      existingGroupNames && existingGroupNames.size > 0
        ? `\n\nExisting groups in this workspace (REUSE these names when tabs fit): ${[
            ...existingGroupNames,
          ].join(", ")}`
        : "";

    const systemPrompt = useFolders
      ? "Group tabs by topic intent, not hostname. Return a single JSON object.\n\n" +
        "FLAT: {\"Topic\": [1,2], \"Other\": [3,4]}\n" +
        "NESTED (rare): {\"Broad\": {\"Sub A\": [1,2], \"Sub B\": [3,4]}, \"Flat\": [5,6]}\n\n" +
        "Nesting rules:\n" +
        "- ONLY nest when a broad theme clearly splits into 2+ distinct sub-themes with 2+ tabs each.\n" +
        "- If a sub-theme has 1 tab, or a parent has 1 child, or a topic has <4 tabs total — keep FLAT.\n" +
        "- Prefer FLAT. Nesting must improve UX, not create empty hierarchy.\n" +
        "- Max 2 levels. Omit unmatched tabs. No markdown, no prose."
      : "Group tabs by topic intent, not hostname(unless nothing is clear). Return a single flat JSON object.\n\n" +
        "Format: {\"Topic\": [1,2], \"Other\": [3,4]}\n\n" +
        "Rules: every tab at most once; omit unmatched tabs; reuse existing names; no markdown, no prose.";

    const userPrompt = `${lines.join("\n")}${existingHint}\n\nJSON:`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      const body = {
        model: modelId,
        // Output is bounded roughly by (groups * ~30 chars) + tab numbers;
        // 1024 is comfortable headroom for ~100 tabs across ~20 groups.
        max_tokens: 1024,
        temperature: 0.2,
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
      const content = json?.choices?.[0]?.message?.content;
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

  class TidyTabsTreeConnectors {
    constructor() {
      this.SVG_NS = "http://www.w3.org/2000/svg";
      this.raf = null;
      this.resizeObserver = null;
      this.mutationObserver = null;
      this.windowUtils = window.windowUtils;
      this.isSetup = false;
      this.boundHandleEvent = this.handleEvent.bind(this);
    }

    init() {
      if (this.isSetup || !CONFIG.TREE_CONNECTORS_ENABLED) return;
      try {
        ensureTreeConnectorStyles();
        this.setupEventListeners();
        this.refreshVisualRelationships();
        this.scheduleUpdate();
        this.isSetup = true;
      } catch (e) {
        console.error("[TidyTabs][Tree] Failed to initialize", e);
      }
    }

    destroy() {
      if (!this.isSetup) return;

      const events = [...TREE_SCHEDULE_EVENTS, "TabGroupCreate"];
      events.forEach((eventName) => {
        window.removeEventListener(eventName, this.boundHandleEvent);
      });

      const arrowScrollbox = document.getElementById("tabbrowser-arrowscrollbox");
      if (arrowScrollbox && CONFIG.TREE_REFRESH_ON_ANIMATIONS) {
        arrowScrollbox.removeEventListener("transitionend", this.boundHandleEvent, true);
        arrowScrollbox.removeEventListener("animationend", this.boundHandleEvent, true);
      }

      if (this.mutationObserver) {
        this.mutationObserver.disconnect();
        this.mutationObserver = null;
      }

      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
        this.resizeObserver = null;
      }

      this.isSetup = false;
    }

    scheduleUpdate() {
      if (!CONFIG.TREE_CONNECTORS_ENABLED || this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = null;
        this.onRefreshConnectors();
      });
    }

    handleEvent(event) {
      if (event.type === "TabGroupCreate") {
        this.registerResizeObservers();
        this.scheduleUpdate();
        return;
      }

      if (
        TREE_SCHEDULE_EVENTS.has(event.type) ||
        event.type === "transitionend" ||
        event.type === "animationend"
      ) {
        this.scheduleUpdate();
      }
    }

    setupEventListeners() {
      const events = [...TREE_SCHEDULE_EVENTS, "TabGroupCreate"];
      events.forEach((eventName) => {
        window.addEventListener(eventName, this.boundHandleEvent);
      });

      this.mutationObserver = new MutationObserver(() => this.scheduleUpdate());
      this.mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["zen-sidebar-expanded"],
      });

      const arrowScrollbox = document.getElementById("tabbrowser-arrowscrollbox");
      if (arrowScrollbox) {
        this.mutationObserver.observe(arrowScrollbox, {
          attributes: true,
          attributeFilter: ["active", "collapsedpinnedtabs"],
          subtree: true,
        });

        if (CONFIG.TREE_REFRESH_ON_ANIMATIONS) {
          arrowScrollbox.addEventListener("transitionend", this.boundHandleEvent, true);
          arrowScrollbox.addEventListener("animationend", this.boundHandleEvent, true);
        }
      }

      this.registerResizeObservers();
    }

    registerResizeObservers() {
      if (!this.resizeObserver) {
        this.resizeObserver = new ResizeObserver(() => this.scheduleUpdate());
      }
      const containers = document.querySelectorAll(
        "zen-folder > .tab-group-container, tab-group:not(zen-folder) > .tab-group-container"
      );
      containers.forEach((container) => {
        if (!container._tidyTreeObserved) {
          container._tidyTreeObserved = true;
          this.resizeObserver.observe(container);
        }
      });
    }

    observeTabElement(tab) {
      if (!this.resizeObserver) {
        this.resizeObserver = new ResizeObserver(() => this.scheduleUpdate());
      }
      if (!tab._tidyTreeObserved) {
        tab._tidyTreeObserved = true;
        this.resizeObserver.observe(tab);
      }
    }

    isOwnedTabsInFolderEnabled() {
      try {
        return services.prefs.getBoolPref("zen.folders.owned-tabs-in-folder", false);
      } catch {
        return false;
      }
    }

    onRefreshConnectors() {
      if (!window.gBrowser || !CONFIG.TREE_CONNECTORS_ENABLED) return;

      try {
        const activeWorkspace = document.querySelector("zen-workspace[active='true']");
        this.refreshVisualRelationships();

        const folders = activeWorkspace
          ? activeWorkspace.querySelectorAll("zen-folder")
          : document.querySelectorAll("zen-folder");
        folders.forEach((folder) => this.refreshFolderConnector(folder));

        // Regular tab-groups get the same tree treatment (simpler logic —
        // no pinned-collapse / rootMostCollapsed nesting applies).
        const groups = activeWorkspace
          ? activeWorkspace.querySelectorAll("tab-group:not(zen-folder)")
          : document.querySelectorAll("tab-group:not(zen-folder)");
        groups.forEach((group) => this.refreshTabGroupConnector(group));

        if (CONFIG.TREE_INCLUDE_RELATED_TABS) {
          const relatedParents = activeWorkspace
            ? activeWorkspace.querySelectorAll("tab.zen-is-related-parent")
            : document.querySelectorAll("tab.zen-is-related-parent");
          relatedParents.forEach((parent) => this.refreshRelatedTabConnector(parent));
        }
      } catch (e) {
        console.error("[TidyTabs][Tree] Error during refresh", e);
      }
    }

    // Minimal version of refreshFolderConnector for regular tab-groups.
    // Skips folder-only concerns (nested-folder collapse, pinned-section
    // collapse) that don't exist for vanilla groups.
    refreshTabGroupConnector(group) {
      const container = group.querySelector(":scope > .tab-group-container");
      if (!container) return;

      const isExpanded =
        document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
      const isCollapsed = group.hasAttribute("collapsed");
      const hasActive = group.hasAttribute("has-active");
      const isVisible = !isCollapsed || hasActive;

      const children =
        isExpanded && isVisible
          ? this.getVisibleChildren(group, isCollapsed)
          : [];

      let connector = container.querySelector(":scope > .tree-connector");
      if (!children.length) {
        if (connector) connector.hidden = true;
        return;
      }

      if (!connector) {
        connector = document.createElement("div");
        connector.className = "tree-connector";
        container.prepend(connector);
      }
      connector.hidden = false;

      this.performSVGUpdate(connector, children, false);
    }

    refreshVisualRelationships() {
      if (!window.gBrowser?.tabs) return;
      if (!CONFIG.TREE_INCLUDE_RELATED_TABS || this.isOwnedTabsInFolderEnabled()) {
        this.clearVisualNesting();
        return;
      }

      const tabs = Array.from(window.gBrowser.tabs);
      let activeParent = null;
      let lineage = new Set();

      tabs.forEach((tab) => {
        tab.classList.remove("zen-is-related-child", "zen-is-related-parent");

        const isBoundary =
          tab.pinned ||
          tab.group ||
          tab.classList.contains("zen-tab-group-start");

        if (isBoundary) {
          activeParent = null;
          lineage.clear();
          return;
        }

        const activeParentFolder = activeParent ? this.getRootFolder(activeParent) : null;
        const tabFolder = this.getRootFolder(tab);
        const isInSameFolder = !!activeParentFolder && activeParentFolder === tabFolder;

        const owner = tab.ownerTab || tab.openerTab;
        const isDirectChild =
          owner && activeParent && isInSameFolder && (owner === activeParent || lineage.has(owner));

        if (isDirectChild) {
          tab.classList.add("zen-is-related-child");
          lineage.add(tab);
          activeParent.classList.add("zen-is-related-parent");
          this.observeTabElement(tab);
          this.observeTabElement(activeParent);
        } else {
          activeParent = tab;
          lineage.clear();
        }
      });

      this.pruneStaleConnectors();
    }

    clearVisualNesting() {
      const nodes = document.querySelectorAll(
        ".zen-is-related-child, .zen-is-related-parent"
      );
      nodes.forEach((node) => {
        node.classList.remove("zen-is-related-child", "zen-is-related-parent");
        const connector = node.querySelector(":scope > .tree-connector");
        if (connector?._isVisualConnector) {
          connector.hidden = true;
        }
      });
    }

    pruneStaleConnectors() {
      const connectors = document.querySelectorAll("tab > .tree-connector");
      connectors.forEach((connector) => {
        if (!connector._isVisualConnector) return;
        const owner = connector.closest("tab");
        if (!owner?.classList.contains("zen-is-related-parent")) {
          connector.hidden = true;
        }
      });
    }

    getRootFolder(item) {
      let rootFolder = null;
      for (let node = item; node; node = node.parentElement) {
        if (node.localName === "zen-folder") {
          rootFolder = node;
        }
      }
      return rootFolder;
    }

    // `host` is a zen-folder OR a regular tab-group. We deliberately accept
    // the element directly (rather than deriving via container.closest)
    // because closest() was picking up the wrong ancestor in some nested
    // shapes (e.g. a folder containing a group), which silently broke the
    // folder connector.
    getVisibleChildren(host, isParentCollapsed = false) {
      if (!host) return [];

      // zen-folder exposes an `.allItems` live list including nested
      // folders; vanilla tab-group doesn't, so fall back to the
      // container's direct children.
      let items = null;
      if (Array.isArray(host.allItems) || host.allItems?.length >= 0) {
        items = host.allItems;
      }
      if (!items || !items.length) {
        const container = host.querySelector(":scope > .tab-group-container");
        items = container ? Array.from(container.children) : [];
      }
      if (!items.length) return [];

      const result = [];
      items.forEach((item) => {
        if (item.offsetHeight <= 0) return;

        if (window.gBrowser.isTabGroup(item)) {
          if (item.hasAttribute("split-view-group")) {
            result.push(item);
            return;
          }

          if (item.isZenFolder) {
            const rootMost = item.rootMostCollapsedFolder;
            if (isParentCollapsed || (rootMost && rootMost !== item)) {
              result.push(...this.getVisibleChildren(item, true));
            } else {
              result.push(item);
            }
          } else {
            // Regular nested tab-group inside a folder: treat it as a leaf
            // point in the parent's tree so the connector reaches it.
            result.push(item);
          }
        } else if (
          window.gBrowser.isTab(item) &&
          !item.classList.contains("zen-tab-group-start") &&
          !item.classList.contains("pinned-tabs-container-separator")
        ) {
          result.push(item);
        }
      });

      return result;
    }

    refreshFolderConnector(folder) {
      const container = folder.querySelector(":scope > .tab-group-container");
      if (!container) return;

      const rootMost = folder.rootMostCollapsedFolder;
      if (rootMost && rootMost !== folder) {
        const ghost = container.querySelector(":scope > .tree-connector");
        if (ghost) {
          ghost.hidden = true;
          delete ghost._cachedPathElement;
        }
        return;
      }

      const isPinnedSection = folder.closest(".zen-workspace-pinned-tabs-section");
      const workspace = folder.closest("zen-workspace");
      const isPinnedCollapsed =
        isPinnedSection && workspace?.hasAttribute("collapsedpinnedtabs");

      if (isPinnedCollapsed) {
        const connector = container.querySelector(":scope > .tree-connector");
        if (connector) {
          connector.hidden = true;
          delete connector._cachedPathElement;
        }
        return;
      }

      const isExpanded =
        document.documentElement.getAttribute("zen-sidebar-expanded") === "true";
      const isCollapsed = folder.hasAttribute("collapsed");
      const hasActive = folder.hasAttribute("has-active");
      const isVisible = !isCollapsed || hasActive;

      const children =
        isExpanded && isVisible
          ? this.getVisibleChildren(folder, isCollapsed)
          : [];

      let connector = container.querySelector(":scope > .tree-connector");
      if (!children.length) {
        if (connector) {
          connector.hidden = true;
        }
        return;
      }

      if (!connector) {
        connector = document.createElement("div");
        connector.className = "tree-connector";
        container.prepend(connector);
      }
      connector.hidden = false;

      this.performSVGUpdate(connector, children, false);
    }

    refreshRelatedTabConnector(parent) {
      if (!CONFIG.TREE_INCLUDE_RELATED_TABS) return;

      const descendants = [];
      let sibling = parent.nextElementSibling;
      while (sibling?.classList.contains("zen-is-related-child")) {
        descendants.push(sibling);
        sibling = sibling.nextElementSibling;
      }

      let connector = parent.querySelector(":scope > .tree-connector");
      if (!descendants.length) {
        if (connector?._isVisualConnector) connector.hidden = true;
        return;
      }

      if (!connector) {
        connector = document.createElement("div");
        connector.className = "tree-connector";
        connector._isVisualConnector = true;
        parent.appendChild(connector);
      }
      connector.hidden = false;

      this.performSVGUpdate(connector, descendants, true, parent);
    }

    performSVGUpdate(host, targets, isRelated, contextTab = null) {
      const baseRect = this.windowUtils.getBoundsWithoutFlushing(host);
      const points = targets
        .map((item) => {
          const targetElement = isRelated
            ? item.querySelector(".tab-stack") || item
            : item;
          const itemRect = this.windowUtils.getBoundsWithoutFlushing(targetElement);

          let tx = 0;
          let ty = 0;
          const inlineTransform = targetElement.style.transform;
          const transformValue =
            inlineTransform && inlineTransform !== "none" ? inlineTransform : null;

          if (transformValue) {
            const matrix = new window.DOMMatrix(transformValue);
            tx = matrix.m41;
            ty = matrix.m42;
          } else if (!inlineTransform) {
            const computed = window.getComputedStyle(targetElement).transform;
            if (computed && computed !== "none") {
              const matrix = new window.DOMMatrix(computed);
              tx = matrix.m41;
              ty = matrix.m42;
            }
          }

          let x = itemRect.left - tx - baseRect.left + CONFIG.TREE_BRANCH_OVERSHOOT;
          let y = itemRect.top - ty - baseRect.top;

          if (!isRelated) {
            if (item.isZenFolder) {
              const label = item.querySelector(":scope > .tab-group-label-container");
              if (label) y += label.offsetHeight / 2;
            } else if (window.gBrowser.isTabGroup(item)) {
              const tab = item.querySelector("tab");
              if (tab) {
                const tabRect = this.windowUtils.getBoundsWithoutFlushing(tab);
                y = tabRect.top - ty - baseRect.top + tab.offsetHeight / 2;
              } else {
                y += item.offsetHeight / 2;
              }
            } else {
              y += item.offsetHeight / 2;
            }
          } else {
            y += targetElement.offsetHeight / 2;
          }

          return {
            y,
            x,
            r: Math.min(CONFIG.TREE_BRANCH_RADIUS, Math.max(0, x - CONFIG.TREE_LINE_X)),
          };
        })
        .filter((point) => point.y > 1);

      if (!points.length) {
        host.hidden = true;
        return;
      }

      const last = points[points.length - 1];
      const trunkTerminateY = last.y - last.r;
      if (trunkTerminateY < 0) return;

      const pathStart = isRelated && contextTab ? contextTab.offsetHeight / 2 : 0;
      let pathData = `M ${CONFIG.TREE_LINE_X} ${pathStart} L ${CONFIG.TREE_LINE_X} ${trunkTerminateY}`;
      points.forEach(({ y, x, r }) => {
        pathData += ` M ${CONFIG.TREE_LINE_X} ${y - r} A ${r} ${r} 0 0 0 ${CONFIG.TREE_LINE_X + r} ${y} L ${x} ${y}`;
      });

      let path = host._cachedPathElement;
      if (!path) {
        path = document.createElementNS(this.SVG_NS, "path");
        const svg = document.createElementNS(this.SVG_NS, "svg");
        svg.setAttribute("width", "100%");
        svg.setAttribute("height", "100%");
        svg.style.position = "absolute";
        svg.style.top = "0";
        svg.style.left = "0";
        svg.style.overflow = "visible";
        svg.style.pointerEvents = "none";

        const group = document.createElementNS(this.SVG_NS, "g");
        group.setAttribute("opacity", `${CONFIG.TREE_OPACITY}`);
        group.setAttribute("stroke", "currentColor");
        group.setAttribute("stroke-width", `${CONFIG.TREE_STROKE_WIDTH}`);
        group.setAttribute("fill", "none");
        group.setAttribute("stroke-linecap", "round");

        group.appendChild(path);
        svg.appendChild(group);
        host.replaceChildren(svg);
        host._cachedPathElement = path;
      }

      if (path.getAttribute("d") !== pathData) {
        path.setAttribute("d", pathData);
      }
    }
  }

  // Auto-init
  const init = () => {
    if (!CONFIG.TREE_CONNECTORS_ENABLED) return;
    processExistingTabGroups();
    const tree = new TidyTabsTreeConnectors();
    globalThis.ZenTreeConnectors = tree;
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
