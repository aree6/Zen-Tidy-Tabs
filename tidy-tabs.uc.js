// ==UserScript==
// @ignorecache
// @name          Ai tab sort and tab clearer
// @description    sorts tab and arrange them into tab groups
// ==/UserScript==

(() => {
  const DEFAULT_CONFIG = {
    SIMILARITY_THRESHOLD: 0.45,
    GROUP_SIMILARITY_THRESHOLD: 0.65, // Lowered from 0.75 to be more inclusive for existing groups
    MIN_TABS_FOR_SORT: 0, // This is the ammount of tabs for the button to show, not the ammount of tabs you need in a group
    DEBOUNCE_DELAY: 250,
    ANIMATION_DURATION: 800,
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
  };

  const PREF_BRANCH = "zen.tidytabs.";
  const PREFS = {
    SIMILARITY_THRESHOLD: ["double", "ai.similarity-threshold"],
    ENABLE_FAILURE_ANIMATION: ["bool", "ui.enable-failure-animation"],
    ENABLE_CLEAR_BUTTON_PATCH: ["bool", "behavior.patch-clear-button"],
    TREE_CONNECTORS_ENABLED: ["bool", "tree.enabled"],
    MENU_SORT_GROUPS: ["bool", "menu.sort-groups"],
    MENU_SORT_FOLDERS: ["bool", "menu.sort-folders"],
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

  const CONFIG = loadRuntimeConfig();

  // --- Globals & State ---
  let isSorting = false;
  let isPlayingFailureAnimation = false;
  let sortAnimationId = null;
  let eventListenersAdded = false;

  // DOM Cache for performance
  const domCache = {
    separators: null,
    commandSet: null,

    getSeparators() {
      if (!this.separators || !this.separators.length) {
        this.separators = document.querySelectorAll(
          ".pinned-tabs-container-separator"
        );
      }
      return this.separators;
    },

    getCommandSet() {
      if (!this.commandSet) {
        this.commandSet = document.querySelector("commandset#zenCommandSet");
      }
      return this.commandSet;
    },

    invalidate() {
      this.separators = null;
      this.commandSet = null;
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

  const findGroupElement = (topicName, workspaceId) => {
    if (!topicName || typeof topicName !== "string" || !workspaceId)
      return null;

    const sanitizedTopicName = topicName.trim();
    if (!sanitizedTopicName) return null;

    const safeSelectorTopicName = sanitizedTopicName
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');

    try {
      return document.querySelector(
        `tab-group[label="${safeSelectorTopicName}"][zen-workspace-id="${workspaceId}"]`
      );
    } catch (e) {
      console.error(
        `Error finding group selector for "${sanitizedTopicName}":`,
        e
      );
      return null;
    }
  };

  const findTopLevelFolderByLabel = (label, workspaceId) => {
    if (!label || !workspaceId) return null;
    const safeLabel = label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const selector = `zen-folder[label="${safeLabel}"][zen-workspace-id="${workspaceId}"]`;
    return Array.from(document.querySelectorAll(selector)).find(
      (folder) => folder?.isConnected && !folder?.group?.isZenFolder
    );
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

  const ensureTreeConnectorStyles = () => {
    const styleId = "tidy-tabs-tree-connectors-style";
    const existingStyle = document.getElementById(styleId);
    if (existingStyle) {
      existingStyle.textContent = `
        zen-folder > .tab-group-container {
          margin-inline-start: ${CONFIG.TREE_FOLDER_INDENT_PX}px !important;
        }

        :root[zen-sidebar-expanded="true"] zen-folder > .tab-group-container,
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
      return;
    }

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      zen-folder > .tab-group-container {
        margin-inline-start: ${CONFIG.TREE_FOLDER_INDENT_PX}px !important;
      }

      :root[zen-sidebar-expanded="true"] zen-folder > .tab-group-container,
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
    document.documentElement.appendChild(style);
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
      const containers = document.querySelectorAll("zen-folder > .tab-group-container");
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

    getVisibleChildren(container, isParentCollapsed = false) {
      const folder = container.closest("zen-folder, tab-group");
      const items = folder?.allItems || [];
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
              const subContainer = item.querySelector(":scope > .tab-group-container");
              if (subContainer) {
                result.push(...this.getVisibleChildren(subContainer, true));
              }
            } else {
              result.push(item);
            }
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
          ? this.getVisibleChildren(container, isCollapsed)
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

  let treeConnectors = null;

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

  // Batch DOM operations for better performance
  const batchDOMUpdates = (operations) => {
    if (!Array.isArray(operations) || operations.length === 0) return;

    // Use document fragment for batching when possible
    const fragment = document.createDocumentFragment();

    try {
      operations.forEach((operation) => {
        if (typeof operation === "function") {
          operation(fragment);
        }
      });
    } catch (error) {
      console.error("Error in batch DOM operations:", error);
    }
  };

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

  const generateEmbedding = async (title) => {
    if (!title || typeof title !== "string") return null;

    try {
      const { createEngine } = ChromeUtils.importESModule(
        "chrome://global/content/ml/EngineProcess.sys.mjs"
      );
      const engine = await createEngine({
        taskName: "feature-extraction",
        modelId: "Mozilla/smart-tab-embedding",
        modelHub: "huggingface",
        engineId: "embedding-engine",
      });

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
        return norm === 0 ? pooled : pooled.map((v) => v / norm);
      }
      return null;
    } catch (e) {
      console.error("[TabSort][AI] Error generating embedding:", e);
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

    // Get existing groups in current workspace
    const existingWorkspaceGroups = new Map();
    if (currentWorkspaceId) {
      const groupSelector = `:is(tab-group, zen-folder):has(tab[zen-workspace-id="${currentWorkspaceId}"])`;
      document.querySelectorAll(groupSelector).forEach((groupEl) => {
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
          // Extract keywords function
          function extractKeywords(titles) {
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

            const keywords = Object.entries(wordCount)
              .filter(([word]) => !stopWords.has(word))
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([word]) => word);

            return keywords;
          }

          // Group naming function
          async function nameGroupWithSmartTabTopic(titles) {
            const keywords = extractKeywords(titles);
            const input = `Topic from keywords: ${keywords.join(
              ", "
            )}. titles:\n${titles.join("\n")}`;

            try {
              const { createEngine } = ChromeUtils.importESModule(
                "chrome://global/content/ml/EngineProcess.sys.mjs"
              );
              let engine = await createEngine({
                taskName: "text2text-generation",
                modelId: "Mozilla/smart-tab-topic",
                modelHub: "huggingface",
                engineId: "group-namer",
              });

              const aiResult = await engine.run({
                args: [input],
                options: { max_new_tokens: 8, temperature: 0.7 },
              });

              let name = (aiResult[0]?.generated_text || "Group")
                .split("\n")
                .map((l) => l.trim())
                .find((l) => l);

              name = toTitleCase(name);
              if (!name || /none|adult content/i.test(name)) {
                name = titles[0].split("–")[0].trim().slice(0, 24);
              }

              name = name
                .replace(/^['"`]+|['"`]+$/g, "")
                .replace(/[.?!,:;]+$/, "")
                .slice(0, 24);
              return name || "Group";
            } catch (e) {
              console.error("[TabSort][AI] Error naming group:", e);
              return "Group";
            }
          }

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
  // missing) we must fall back to deterministic fuzzy grouping.
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

  // --- Fuzzy Grouping (AI-off fallback) ----------------------------------
  // Approach:
  //   1. Tokenize each tab's (title + hostname) into meaningful lowercase
  //      tokens, dropping stopwords & short noise.
  //   2. Seed clusters with tabs sharing the same hostname (high-signal).
  //   3. Merge clusters whose Jaccard token overlap exceeds a threshold.
  //   4. Pick accurate cluster names: most frequent descriptive token,
  //      falling back to a prettified hostname.
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

  const FUZZY_CLUSTER_THRESHOLD = 0.25; // Jaccard overlap to merge clusters
  const FUZZY_MIN_TOKEN_LEN = 3;

  const getTabHost = (tab) => {
    try {
      const spec = tab?.linkedBrowser?.currentURI?.spec;
      if (!spec || spec.startsWith("about:")) return "";
      return new URL(spec).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  };

  const tokenizeTab = (tab) => {
    const title = getTabTitle(tab) || "";
    const host = getTabHost(tab);
    // Pull identifier-ish tokens from the hostname (github, youtube, …)
    // but skip generic tokens that occur in every URL.
    const hostTokens = host
      .split(/[.\-]/)
      .filter((t) => t && t.length >= FUZZY_MIN_TOKEN_LEN)
      .filter((t) => !FUZZY_STOPWORDS.has(t));

    const titleTokens = title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t && t.length >= FUZZY_MIN_TOKEN_LEN)
      .filter((t) => !FUZZY_STOPWORDS.has(t));

    return { host, hostTokens, titleTokens, allTokens: new Set([...hostTokens, ...titleTokens]) };
  };

  const jaccard = (a, b) => {
    if (!a.size || !b.size) return 0;
    let intersect = 0;
    for (const x of a) if (b.has(x)) intersect++;
    return intersect / (a.size + b.size - intersect);
  };

  const prettifyLabel = (raw) => {
    if (!raw) return "Other";
    return raw
      .split(/[\s\-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  };

  const nameFuzzyCluster = (clusterTabs, meta) => {
    // Tally tokens across the cluster, weighting title tokens higher than
    // hostname tokens (titles are more descriptive of topic).
    const freq = new Map();
    const bump = (tok, weight) => freq.set(tok, (freq.get(tok) || 0) + weight);
    for (const tab of clusterTabs) {
      const m = meta.get(tab);
      if (!m) continue;
      m.titleTokens.forEach((t) => bump(t, 2));
      m.hostTokens.forEach((t) => bump(t, 1));
    }

    const ranked = [...freq.entries()]
      .filter(([, c]) => c >= Math.max(2, Math.floor(clusterTabs.length * 0.4)))
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);

    if (ranked.length) return prettifyLabel(ranked[0][0]);

    // Fallback: most common hostname in cluster.
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

    // 1. Seed by hostname.
    const clusters = new Map(); // hostKey -> [tabs]
    const noHost = [];
    validTabs.forEach((tab) => {
      const host = meta.get(tab).host;
      if (!host) { noHost.push(tab); return; }
      if (!clusters.has(host)) clusters.set(host, []);
      clusters.get(host).push(tab);
    });

    // 2. Merge clusters by Jaccard token similarity.
    const clusterList = [...clusters.values()];
    if (noHost.length) clusterList.push(noHost);

    const clusterTokens = clusterList.map((tabs) => {
      const s = new Set();
      tabs.forEach((tab) => meta.get(tab).allTokens.forEach((t) => s.add(t)));
      return s;
    });

    const mergedInto = new Array(clusterList.length).fill(-1);
    for (let i = 0; i < clusterList.length; i++) {
      if (mergedInto[i] !== -1) continue;
      for (let j = i + 1; j < clusterList.length; j++) {
        if (mergedInto[j] !== -1) continue;
        if (jaccard(clusterTokens[i], clusterTokens[j]) >= FUZZY_CLUSTER_THRESHOLD) {
          clusterList[i].push(...clusterList[j]);
          clusterTokens[j].forEach((t) => clusterTokens[i].add(t));
          mergedInto[j] = i;
        }
      }
    }

    // 3. Emit named groups, dropping singletons.
    const finalGroups = {};
    clusterList.forEach((tabs, idx) => {
      if (mergedInto[idx] !== -1) return;
      if (tabs.length < 2) return;
      let label = nameFuzzyCluster(tabs, meta);
      // Avoid label collisions with existing groups that contain different tabs
      while (finalGroups[label]) label = `${label} 2`;
      finalGroups[label] = tabs;
    });

    return consolidateSimilarGroupNames(finalGroups, existingNames);
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

    let separatorsToSort = [];
    try {
      separatorsToSort = domCache.getSeparators();
      // Apply visual indicator
      if (separatorsToSort.length > 0) {
        batchDOMUpdates([
          () =>
            separatorsToSort.forEach((sep) => {
              if (sep?.isConnected) {
                sep.classList.add("separator-is-sorting");
              }
            }),
        ]);
      }

      const currentWorkspaceId = window.gZenWorkspaces?.activeWorkspace;
      if (!currentWorkspaceId) {
        console.error("Cannot get current workspace ID.");
        return; // Exit early
      }

      // --- Step 1: Get ALL Existing Group Names for Context ---
      const allExistingGroupNames = new Set();
      const groupSelector = `:is(tab-group, zen-folder):has(tab[zen-workspace-id="${currentWorkspaceId}"])`;

      document.querySelectorAll(groupSelector).forEach((groupEl) => {
        const label = groupEl.getAttribute("label");
        if (label) {
          allExistingGroupNames.add(label);
        }
      });

      // --- Filter initial tabs using optimized function ---
      const initialTabsToSort = getFilteredTabs(currentWorkspaceId, {
        includeGrouped: false,
        includeSelected: true,
        includePinned: false,
        includeEmpty: false,
        includeGlance: false,
      }).filter((tab) => {
        const groupParent =
          tab.group ?? tab.closest(":is(tab-group, zen-folder)");
        const isInGroupInCorrectWorkspace = groupParent
          ? groupParent.matches(groupSelector)
          : false;
        return !isInGroupInCorrectWorkspace;
      });

      console.log(
        "[TabSort] Debug - Initial tabs to sort count:",
        initialTabsToSort.length
      );
      if (initialTabsToSort.length === 0) {
        console.log("[TabSort] Debug - No tabs to sort, returning early");
        return;
      }

      // --- Build Final Groups ---
      let finalGroups = {};
      let aiTabTopics = [];
      const aiEnabled = isAIEnabled();

      if (aiEnabled) {
        console.log(
          "[TabSort] Using AI grouping for",
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
      } else {
        console.log(
          "[TabSort] AI disabled — using fuzzy grouping for",
          initialTabsToSort.length,
          "tabs"
        );
        finalGroups = fuzzyGroupByTokens(initialTabsToSort, allExistingGroupNames);
      }

      // --- Failure check ---
      const multiTabGroups = Object.values(finalGroups).filter((tabs) => tabs.length > 1);
      const sortingFailed =
        multiTabGroups.length === 0 &&
        (aiEnabled ? aiTabTopics.length === 0 : true) &&
        initialTabsToSort.length > 1;

      console.log("[TabSort] Debug - Initial tabs:", initialTabsToSort.length);
      console.log("[TabSort] Debug - Final groups:", Object.keys(finalGroups));
      console.log("[TabSort] Debug - Multi-tab groups:", multiTabGroups.length);
      console.log("[TabSort] Debug - Sorting failed:", sortingFailed);

      if (sortingFailed) {
        if (CONFIG.ENABLE_FAILURE_ANIMATION) startFailureAnimation();
        return;
      }

      if (Object.keys(finalGroups).length === 0) {
        console.log(
          "[TabSort] Debug - No final groups, returning early (this should not happen after failure detection)"
        );
        return;
      }

      // --- Get existing group ELEMENTS ---
      const existingGroupElementsMap = new Map();
      document.querySelectorAll(groupSelector).forEach((groupEl) => {
        const label = groupEl.getAttribute("label");
        if (label && !groupEl?.group?.isZenFolder) {
          existingGroupElementsMap.set(label, groupEl);
        }
      });

      // --- Process each final, consolidated group ---
      for (const topic in finalGroups) {
        const tabsForThisTopic = finalGroups[topic].filter((t) => {
          const groupParent =
            t.group ?? t.closest(":is(tab-group, zen-folder)");
          const isInGroupInCorrectWorkspace = groupParent
            ? groupParent.matches(groupSelector)
            : false;
          return t && t.isConnected && !isInGroupInCorrectWorkspace;
        });

        if (tabsForThisTopic.length === 0) {
          continue;
        }

        const existingGroupElement = existingGroupElementsMap.get(topic);

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
              const groupParent =
                tab.group ?? tab.closest(":is(tab-group, zen-folder)");
              const isInGroupInCorrectWorkspace = groupParent
                ? groupParent.matches(groupSelector)
                : false;
              if (tab && tab.isConnected && !isInGroupInCorrectWorkspace) {
                if (existingGroupElement?.isZenFolder) {
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
                  existingGroupElementsMap.set(topic, createdContainer);
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
                    existingGroupElementsMap.set(topic, createdContainer);
                  }
                }
              } else {
                const firstValidTabForGroup = tabsForThisTopic[0];
                const groupOptions = {
                  label: topic,
                  insertBefore: firstValidTabForGroup,
                };
                const newGroup = gBrowser.addTabGroup(
                  tabsForThisTopic,
                  groupOptions
                );
                if (newGroup?.isConnected) {
                  existingGroupElementsMap.set(topic, newGroup);
                }
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
        if (!CONFIG.REORDER_GROUPS_FIRST) {
          return;
        }
        const workspaceElement = gZenWorkspaces?.activeWorkspaceElement;
        
        if (workspaceElement?.tabsContainer) {
          const tabsContainer = workspaceElement.tabsContainer;
          const allChildren = Array.from(tabsContainer.children);
          
          // Separate groups and ungrouped tabs
          // Since we're in the workspace's tabsContainer, all direct children belong to this workspace
          const groups = [];
          const ungroupedTabs = [];
          const otherElements = []; // For any other elements (like periphery hbox)
          
          for (const child of allChildren) {
            const tagName = child.tagName?.toLowerCase();
            if (tagName === "tab-group") {
              // All tab-groups in this container belong to the workspace
              groups.push(child);
            } else if (tagName === "tab") {
              // Check if tab is valid (not empty, not glance)
              if (
                !child.hasAttribute("zen-empty-tab") &&
                !child.hasAttribute("zen-glance-tab")
              ) {
                ungroupedTabs.push(child);
              } else {
                otherElements.push(child);
              }
            } else {
              // Other elements (like hbox periphery)
              otherElements.push(child);
            }
          }
          
          console.log("[TabSort] Reorder - groups:", groups.length, "ungrouped:", ungroupedTabs.length);
          
          // Only reorder if we have both groups AND ungrouped tabs
          if (groups.length > 0 && ungroupedTabs.length > 0) {
            console.log("[TabSort] Reorder - Moving ungrouped tabs below groups...");
            
            // Move each ungrouped tab to after the last group
            const lastGroup = groups[groups.length - 1];
            let insertAfterElement = lastGroup;
            
            ungroupedTabs.forEach((tab) => {
              if (tab.isConnected && insertAfterElement?.isConnected) {
                // Insert tab after the reference element
                const nextSibling = insertAfterElement.nextSibling;
                if (nextSibling) {
                  tabsContainer.insertBefore(tab, nextSibling);
                } else {
                  tabsContainer.appendChild(tab);
                }
                insertAfterElement = tab;
              }
            });
            
            console.log("[TabSort] Reorder - Complete!");
          }
        }
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
          cleanupAnimation();
          if (separatorsToSort.length > 0) {
            batchDOMUpdates([
              () =>
                separatorsToSort.forEach((sep) => {
                  if (sep?.isConnected) sep.classList.remove("separator-is-sorting");
                }),
            ]);
          }
          setTimeout(() => {
            batchDOMUpdates([
              () => {
                if (typeof gBrowser !== "undefined" && gBrowser.tabs) {
                  Array.from(gBrowser.tabs).forEach((tab) => {
                    if (tab?.isConnected) tab.classList.remove("tab-is-sorting");
                  });
                }
              },
            ]);
          }, 500);
        }, CONFIG.FAILURE_PULSE_DURATION * CONFIG.FAILURE_PULSE_COUNT + 300);
      } else {
        setTimeout(() => {
          isSorting = false;
          cleanupAnimation();
          if (separatorsToSort.length > 0) {
            batchDOMUpdates([
              () =>
                separatorsToSort.forEach((sep) => {
                  if (sep?.isConnected) sep.classList.remove("separator-is-sorting");
                }),
            ]);
          }
          setTimeout(() => {
            batchDOMUpdates([
              () => {
                if (typeof gBrowser !== "undefined" && gBrowser.tabs) {
                  Array.from(gBrowser.tabs).forEach((tab) => {
                    if (tab?.isConnected) tab.classList.remove("tab-is-sorting");
                  });
                }
              },
            ]);
          }, 300);
        }, 800);
      }
    }
  };

  // --- Sidebar Context Menu ------------------------------------------------
  // Menu items are injected into Zen's existing sidebar menu
  // (`zenWorkspaceMoreActions`) so the user still sees every native option
  // (Delete/Rename workspace, etc.) plus our sort actions beneath a
  // menuseparator. If the native menu isn't present yet we poll for it, and
  // if it never arrives we fall back to a private popup bound to right-click
  // on the sidebar background — that way the feature still works on older
  // Zen versions where the menu ID changed.
  //
  // Icon strategy: menuitems get a stable class name; the actual SVG is
  // drawn by userChrome.css via list-style-image on
  // `.menu-iconic-icon`. Using CSS sidesteps the inline-data-URI quirks
  // that plagued the previous implementation (icons not rendering).

  const SIDEBAR_MENU_ITEMS = [
    {
      id: "tidy-tabs-sort-groups",
      label: "Tidy Tabs into Groups",
      iconClass: "tidy-tabs-icon-groups",
      prefKey: "MENU_SORT_GROUPS",
      useFolders: false,
    },
    {
      id: "tidy-tabs-sort-folders",
      label: "Tidy Tabs into Folders",
      iconClass: "tidy-tabs-icon-folders",
      prefKey: "MENU_SORT_FOLDERS",
      useFolders: true,
    },
  ];

  const NATIVE_SIDEBAR_MENU_ID = "zenWorkspaceMoreActions";
  const TIDY_TABS_MENU_ITEM_CLASS = "tidy-tabs-menuitem";

  function createTidyTabsMenuItem(item) {
    const mi = document.createXULElement("menuitem");
    mi.id = item.id;
    mi.className = `menuitem-iconic ${TIDY_TABS_MENU_ITEM_CLASS} ${item.iconClass}`;
    mi.setAttribute("label", item.label);
    mi.addEventListener("command", () => sortTabsByTopic(item.useFolders));
    return mi;
  }

  function getEnabledMenuItems() {
    return SIDEBAR_MENU_ITEMS.filter((item) => CONFIG[item.prefKey]);
  }

  // Inject our items + leading separator into the given menupopup, only
  // once. Safe to call repeatedly — no duplicates.
  function injectItemsInto(popup) {
    if (!popup || popup.querySelector(`.${TIDY_TABS_MENU_ITEM_CLASS}`)) return;
    const items = getEnabledMenuItems();
    if (!items.length) return;

    const sep = document.createXULElement("menuseparator");
    sep.className = `${TIDY_TABS_MENU_ITEM_CLASS} tidy-tabs-menu-separator`;
    popup.appendChild(sep);
    items.forEach((item) => popup.appendChild(createTidyTabsMenuItem(item)));
  }

  // Try to attach to the native Zen sidebar menu. Returns true on success.
  function tryAttachToNativeMenu() {
    const native = document.getElementById(NATIVE_SIDEBAR_MENU_ID);
    if (!native) return false;
    injectItemsInto(native);
    return true;
  }

  // Fallback popup in case the native menu isn't available (future-proofing
  // against ID renames). Bound only if native-menu attach failed.
  function buildFallbackPopup() {
    const existing = document.getElementById("tidy-tabs-sidebar-menu");
    if (existing) existing.remove();

    const items = getEnabledMenuItems();
    if (!items.length) return null;

    const popup = document.createXULElement("menupopup");
    popup.id = "tidy-tabs-sidebar-menu";
    items.forEach((item) => popup.appendChild(createTidyTabsMenuItem(item)));

    (document.getElementById("mainPopupSet") || document.documentElement).appendChild(popup);
    return popup;
  }

  function bindFallbackContextMenu() {
    const popup = buildFallbackPopup();
    if (!popup) return;

    const TRIGGERS = [
      "#tabbrowser-arrowscrollbox",
      ".zen-workspace-tabs-section",
      ".zen-workspace-empty-space",
    ];
    const IGNORE =
      "tab, tab-group, zen-folder, .tab-group-label-container, toolbarbutton, .tab-close-button";

    document
      .getElementById("navigator-toolbox")
      ?.addEventListener(
        "contextmenu",
        (event) => {
          const t = event.target;
          if (!t?.closest?.(TRIGGERS.join(","))) return;
          if (t.closest?.(IGNORE)) return;
          event.preventDefault();
          event.stopPropagation();
          popup.openPopupAtScreen(event.screenX, event.screenY, true);
        },
        true
      );
  }

  function ensureSidebarContextMenu() {
    if (tryAttachToNativeMenu()) return;

    // Native menu may be constructed lazily (first right-click). Watch the
    // DOM briefly; if it never appears, fall back.
    let tries = 0;
    const tick = () => {
      if (tryAttachToNativeMenu()) return;
      if (++tries >= CONFIG.MAX_INIT_CHECKS) {
        console.warn(
          `[TidyTabs] native sidebar menu #${NATIVE_SIDEBAR_MENU_ID} not found, using fallback popup`
        );
        bindFallbackContextMenu();
        return;
      }
      setTimeout(tick, CONFIG.INIT_CHECK_INTERVAL);
    };
    tick();

    // Also listen for popupshowing on any descendant menupopup — Zen may
    // construct the native menu on first open, so we catch it there too
    // and inject before the user sees it.
    document.addEventListener(
      "popupshowing",
      (event) => {
        const popup = event.target;
        if (popup?.id === NATIVE_SIDEBAR_MENU_ID) {
          injectItemsInto(popup);
        }
      },
      true
    );
  }

  // --- gZenWorkspaces Hooks ---
  function setupgZenWorkspacesHooks() {
    if (typeof window.gZenWorkspaces === "undefined") {
      return;
    }

    const originalOnTabBrowserInserted =
      window.gZenWorkspaces.onTabBrowserInserted;
    const originalUpdateTabsContainers =
      window.gZenWorkspaces.updateTabsContainers;

    window.gZenWorkspaces.onTabBrowserInserted = function (event) {
      if (typeof originalOnTabBrowserInserted === "function") {
        try {
          originalOnTabBrowserInserted.call(window.gZenWorkspaces, event);
        } catch (e) {
          console.error(
            "SORT BTN HOOK: Error in original onTabBrowserInserted:",
            e
          );
        }
      }
      treeConnectors?.scheduleUpdate?.();
    };

    window.gZenWorkspaces.updateTabsContainers = function (...args) {
      if (typeof originalUpdateTabsContainers === "function") {
        try {
          originalUpdateTabsContainers.apply(window.gZenWorkspaces, args);
        } catch (e) {
          console.error(
            "SORT BTN HOOK: Error in original updateTabsContainers:",
            e
          );
        }
      }
      treeConnectors?.scheduleUpdate?.();
    };
  }

  // --- Patch Clear Button to Preserve Tab-Groups ---
  function patchClearButtonToPreserveGroups() {
    if (!CONFIG.ENABLE_CLEAR_BUTTON_PATCH) {
      return;
    }

    if (typeof window.gZenWorkspaces === "undefined") {
      console.warn("[TidyTabs] gZenWorkspaces not available, cannot patch clear button");
      return;
    }

    // Store the original method
    const originalCloseAllUnpinnedTabs = window.gZenWorkspaces.closeAllUnpinnedTabs;
    
    if (typeof originalCloseAllUnpinnedTabs !== "function") {
      console.warn("[TidyTabs] closeAllUnpinnedTabs method not found");
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
        
        // Get all tabs and filter to ONLY the active workspace
        const allTabs = Array.from(gBrowser.tabs).filter(tab => {
          const tabWorkspaceId = tab.getAttribute("zen-workspace-id");
          return tabWorkspaceId === currentWorkspaceId;
        });
        
        // Filter tabs to close: exclude pinned, grouped, essential, empty, and selected tabs
        const tabsToClose = allTabs.filter(tab => {
          // Safety check
          if (!tab || !tab.isConnected) return false;
          
          // Don't close the selected tab
          if (tab.selected) {
            return false;
          }
          
          // Don't close pinned tabs
          if (tab.pinned) {
            return false;
          }
          
          // Don't close tabs that are in a group/folder
          if (tab.group) {
            // Check if it's a zen-folder
            if (tab.group.isZenFolder || tab.group.tagName === "zen-folder") {
              return false;
            }
            // Check if it's a regular tab-group (not split-view)
            if (tab.group.tagName === "tab-group" && !tab.group.hasAttribute("split-view-group")) {
              return false;
            }
          }
          
          // Don't close essential tabs
          if (tab.hasAttribute("zen-essential")) {
            return false;
          }
          
          // Don't close empty tabs
          if (tab.hasAttribute("zen-empty-tab")) {
            return false;
          }
          
          // Don't close glance tabs
          if (tab.hasAttribute("zen-glance-tab")) {
            return false;
          }
          
          // This tab can be closed
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
    
    console.log("[TidyTabs] Successfully patched closeAllUnpinnedTabs to preserve tab-groups");
  }

  // --- Add Tab Event Listeners ---
  function addTabEventListeners() {
    if (
      eventListenersAdded ||
      typeof gBrowser === "undefined" ||
      !gBrowser.tabContainer
    ) {
      return;
    }

    const events = [
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
    ];

    events.forEach((eventName) => {
      gBrowser.tabContainer.addEventListener(eventName, () => {
        treeConnectors?.scheduleUpdate?.();
      });
    });

    eventListenersAdded = true;
  }

  // --- Debounce Utility (to prevent rapid firing) ---
  function debounce(func, wait) {
    if (typeof func !== "function" || typeof wait !== "number") {
      return () => {};
    }

    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // --- Cleanup Function ---
  const cleanup = () => {
    try {
      // Stop any running animations
      cleanupAnimation();

      // Clear DOM cache
      domCache.invalidate();

      // Reset state
      isSorting = false;
      eventListenersAdded = false;
      treeConnectors?.destroy?.();

      console.log("Tab sort script cleanup completed");
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  };

  // --- Initial Setup Trigger ---
  function initializeScript() {
    const tryInitialize = () => {
      try {
        const separatorExists = domCache.getSeparators().length > 0;
        const commandSetExists = !!domCache.getCommandSet();
        const gBrowserReady =
          typeof gBrowser !== "undefined" && gBrowser?.tabContainer;
        const gZenWorkspacesReady =
          typeof window.gZenWorkspaces !== "undefined";

        const ready =
          gBrowserReady &&
          commandSetExists &&
          separatorExists &&
          gZenWorkspacesReady;

        if (ready) {
          ensureSidebarContextMenu();
          setupgZenWorkspacesHooks();
          patchClearButtonToPreserveGroups(); // Patch the clear button
          treeConnectors = new TidyTabsTreeConnectors();
          treeConnectors.init();
          addTabEventListeners();

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
