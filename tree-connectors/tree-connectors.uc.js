// ==UserScript==
// @ignorecache
// @name          Zen Tree Connectors
// @description   Visual tree connectors for Zen Browser folder tabs and tab groups
// ==/UserScript==

(() => {
  const DEFAULT_CONFIG = {
    MAX_INIT_CHECKS: 50,
    INIT_CHECK_INTERVAL: 100,
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
  };

  const PREF_BRANCH = "zen.treeconnectors.";

  const PREFS = {
    TREE_CONNECTORS_ENABLED: ["bool", "enabled"],
    TREE_INCLUDE_RELATED_TABS: ["bool", "include-related-tabs"],
    TREE_REFRESH_ON_ANIMATIONS: ["bool", "refresh-on-animations"],
    TREE_LINE_X: ["int", "line-x"],
    TREE_STROKE_WIDTH: ["int", "stroke-width"],
    TREE_BRANCH_RADIUS: ["int", "branch-radius"],
    TREE_OPACITY: ["string", "opacity"],
    TREE_BRANCH_OVERSHOOT: ["int", "branch-overshoot"],
    TREE_FOLDER_INDENT_PX: ["int", "folder-indent-px"],
    TREE_RELATED_CHILD_INDENT_PX: ["int", "related-child-indent-px"],
    TREE_CONNECTOR_OFFSET_PX: ["int", "connector-offset-px"],
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

    // Wire up collapse/expand toggle on the group marker and header.
    // Without Advanced-Tab-Groups, vanilla tab-groups have no click handler
    // for collapsing — clicking the header does nothing and tree connectors
    // glitch because hidden tabs still occupy layout space.
    const marker = labelContainer.querySelector(".group-marker");
    if (marker && !marker._tidyCollapseHandler) {
      const syncTabVisibility = () => {
        const container = group.querySelector(":scope > .tab-group-container");
        if (!container) return;
        const isCollapsed = group.hasAttribute("collapsed");
        const hasActive = group.hasAttribute("has-active");
        container.querySelectorAll(":scope > tab").forEach((tab) => {
          const isActive = tab.matches("[selected='true']") || tab.hasAttribute("selected");
          tab.hidden = isCollapsed && !isActive;
        });
        // Rotate the marker to show collapsed state (CSS transitions it).
        marker.style.transform = isCollapsed ? "rotate(-90deg)" : "rotate(0deg)";
      };

      const toggleCollapse = (e) => {
        if (e) {
          e.stopPropagation();
          e.preventDefault();
        }
        if (group.hasAttribute("collapsed")) {
          group.removeAttribute("collapsed");
          window.dispatchEvent(new CustomEvent("TabGroupExpand", { bubbles: true }));
        } else {
          group.setAttribute("collapsed", "true");
          window.dispatchEvent(new CustomEvent("TabGroupCollapse", { bubbles: true }));
        }
        syncTabVisibility();
      };

      marker.addEventListener("click", toggleCollapse);
      marker._tidyCollapseHandler = toggleCollapse;

      // Clicking the label container (but not the close button) also toggles.
      labelContainer.style.cursor = "pointer";
      labelContainer.addEventListener("click", (e) => {
        if (
          e.target.closest(".group-marker") ||
          e.target.closest(".tab-close-button")
        ) {
          return;
        }
        toggleCollapse(e);
      });

      // Sync visibility on first process in case the group was already collapsed.
      syncTabVisibility();
    }

    group.setAttribute("data-tidy-tabs-processed", "true");
  };

  const processExistingTabGroups = () => {
    const groups = document.querySelectorAll(
      'tab-group:not([data-tidy-tabs-processed]):not([split-view-group]):not([zen-folder])'
    );
    groups.forEach((group) => processTabGroup(group));
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

      // New groups created after init need collapse-toggle wiring too.
      processExistingTabGroups();

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

          const isSplit =
            !isRelated &&
            window.gBrowser.isTabGroup(item) &&
            item.hasAttribute("split-view-group");

          return {
            y,
            x,
            r: Math.min(CONFIG.TREE_BRANCH_RADIUS, Math.max(0, x - CONFIG.TREE_LINE_X)),
            isSplit,
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
      points.forEach(({ y, x, r, isSplit }) => {
        if (isSplit) {
          // Smooth ⊂-style C-curve for split-view tabs: a gentle cubic bezier
          // that bulges left like a subset symbol opening to the right.
          const depth = Math.max(4, Math.min(r, 7));
          const height = depth * 0.6;
          pathData += ` M ${CONFIG.TREE_LINE_X} ${y}` +
            ` C ${CONFIG.TREE_LINE_X - depth} ${y - height}` +
            `, ${x - depth} ${y - height}` +
            `, ${x} ${y}`;
        } else {
          pathData += ` M ${CONFIG.TREE_LINE_X} ${y - r} A ${r} ${r} 0 0 0 ${CONFIG.TREE_LINE_X + r} ${y} L ${x} ${y}`;
        }
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
    tree.init();
    globalThis.ZenTreeConnectors = tree;
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
