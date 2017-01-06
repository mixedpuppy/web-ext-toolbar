/* -*- Mode: indent-tabs-mode: nil; js-indent-level: 2 -*- */
/* vim: set sts=2 sw=2 et tw=80: */
"use strict";

const {classes: Cc, interfaces: Ci, results: Cr, utils: Cu} = Components;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "ExtensionParent",
                              "resource://gre/modules/ExtensionParent.jsm");

let {
  TabManager,
  TabContext,
  WindowListManager,
  makeWidgetId
} = ExtensionParent.apiManager.global;

const collapseToolbar = event => {
  let toolbar = event.target.parentNode;
  toolbar.collapsed = true;
};

const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";

// WeakMap[Extension -> ToolbarAction]
var toolbarActionMap = new WeakMap();

// Responsible for the toolbar_action section of the manifest as well
// as the associated panel.
function ToolbarAction(options, extension) {
  this.extension = extension;

  let widgetId = makeWidgetId(extension.id);
  this.id = `${widgetId}-toolbar-action`;

  this.tabManager = TabManager.for(extension);

  this.defaults = {
    enabled: true,
    title: options.default_title || extension.name,
    panel: options.default_panel || "",
  };

  this.tabContext = new TabContext(tab => Object.create(this.defaults),
                                   extension);
}

ToolbarAction.prototype = {
  build() {
    this.tabContext.on("tab-select", // eslint-disable-line mozilla/balanced-listeners
                       (evt, tab) => { this.updateWindow(tab.ownerGlobal); });

    for (let window of WindowListManager.browserWindows()) {
      this.updateWindow(window);
    }
  },

  createToolbar(window, details) {
    let {document} = window;
    if (!details || !details.panel) {
      details = this.defaults;
    }

    let toolbar = document.createElementNS(XUL_NS, "toolbar");
    toolbar.setAttribute("id", this.id);
    toolbar.setAttribute("collapsed", details.collapsed);
    toolbar.setAttribute("toolbarname", details.title);
    toolbar.setAttribute("pack", "end");
    toolbar.setAttribute("customizable", "false");
    toolbar.setAttribute("style", "padding: 2px 0; max-height: 40px;");
    toolbar.setAttribute("mode", "icons");
    toolbar.setAttribute("iconsize", "small");
    toolbar.setAttribute("context", "toolbar-context-menu");
    toolbar.setAttribute("class", "chromeclass-toolbar");

    let label = document.createElementNS(XUL_NS, "label");
    label.setAttribute("value", details.title);
    label.setAttribute("collapsed", "true");
    toolbar.appendChild(label);

    let closeButton = document.createElementNS(XUL_NS, "toolbarbutton");
    closeButton.setAttribute("id", "close-" + this.id);
    closeButton.setAttribute("class", "close-icon");
    closeButton.setAttribute("customizable", false);
    closeButton.addEventListener("command", collapseToolbar);

    toolbar.appendChild(closeButton);

    let browser = document.createElementNS(XUL_NS, "browser");
    browser.setAttribute("id", "inner-" + this.id);
    browser.setAttribute("style", "-moz-appearance: none; overflow: hidden; background: transparent; padding: 0 4px;");
    browser.setAttribute("type", "content");
    browser.setAttribute("transparent", "true");
    browser.setAttribute("webextension-view-type", "toolbar");
    browser.setAttribute("context", "toolbar-context-menu");
    browser.setAttribute("flex", "1");
    toolbar.insertBefore(browser, closeButton);

    const toolbox = document.getElementById("navigator-toolbox");
    toolbox.appendChild(toolbar);

    browser.messageManager.loadFrameScript("chrome://browser/content/content.js", true);
    ExtensionParent.apiManager.emit("extension-browser-inserted", browser);
    return toolbar;
  },

  // Update the toolbar button |node| with the tab context data
  // in |tabData|.
  updateToolbar(window, tabData) {
    let {document} = window;
    let title = tabData.title || this.extension.name;
    let toolbar = document.getElementById(this.id);
    if (!toolbar) {
      toolbar = this.createToolbar(window, tabData);
    }
    // handle any updates we may need
    let label = toolbar.firstChild;
    label.setAttribute("value", title);
    let browser = document.getElementById("inner-" + this.id);
    browser.setAttribute("src", this.extension.baseURI.resolve(tabData.panel));
  },

  // Update the toolbar button for a given window.
  updateWindow(window) {
    let tab = window.gBrowser.selectedTab;
    this.updateToolbar(window, this.tabContext.get(tab));
  },

  // Update the toolbar button when the extension changes the icon,
  // title, badge, etc. If it only changes a parameter for a single
  // tab, |tab| will be that tab. Otherwise it will be null.
  updateOnChange(tab) {
    if (tab) {
      if (tab.selected) {
        this.updateWindow(tab.ownerGlobal);
      }
    } else {
      for (let window of WindowListManager.browserWindows()) {
        this.updateWindow(window);
      }
    }
  },

  // tab is allowed to be null.
  // prop should be one of "icon", "title", or "panel".
  setProperty(tab, prop, value) {
    if (tab == null) {
      this.defaults[prop] = value;
    } else if (value != null) {
      this.tabContext.get(tab)[prop] = value;
    } else {
      delete this.tabContext.get(tab)[prop];
    }

    this.updateOnChange(tab);
  },

  // tab is allowed to be null.
  // prop should be one of "icon", "title", or "panel".
  getProperty(tab, prop) {
    if (tab == null) {
      return this.defaults[prop];
    }
    return this.tabContext.get(tab)[prop];
  },

  shutdown() {
    this.tabContext.shutdown();
    for (let window of WindowListManager.browserWindows()) {
      let {document} = window;
      document.getElementById(this.id).remove();
    }
  },
};

ToolbarAction.for = (extension) => {
  return toolbarActionMap.get(extension);
};

ExtensionParent.apiManager.on("manifest_toolbar_action", (type, directive, extension, manifest) => {
  let toolbarAction = new ToolbarAction(manifest.toolbar_action, extension);
  toolbarAction.build();
  toolbarActionMap.set(extension, toolbarAction);
});

ExtensionParent.apiManager.on("shutdown", (type, extension) => {
  if (toolbarActionMap.has(extension)) {
    // Don't remove everything on app shutdown so session restore can handle
    // restoring open toolbars.
    // XXX shutdownReason has not landed yet
    if (extension.shutdownReason != "APP_SHUTDOWN") {
      toolbarActionMap.get(extension).shutdown();
    }
    toolbarActionMap.delete(extension);
  }
});

class API extends ExtensionAPI {
  getAPI(context) {
    return {
      toolbarAction: {
        setPanel(details) {
          let tab = details.tabId !== null ? TabManager.getTab(details.tabId, context) : null;
          let url = details.panel && context.uri.resolve(details.panel);
          ToolbarAction.for(extension).setProperty(tab, "panel", url);
        },
        getPanel(details) {
          let tab = details.tabId !== null ? TabManager.getTab(details.tabId, context) : null;

          let panel = ToolbarAction.for(extension).getProperty(tab, "panel");
          return Promise.resolve(panel);
        },
      },
    };
  }
}
