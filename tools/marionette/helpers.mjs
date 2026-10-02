// SPDX-License-Identifier: GPL-3.0-or-later
// Chrome-context helpers for extension glue tests: a fake native file picker
// (headless Firefox cannot click the "Save as" dialog) and clipboard access.

/**
 * Registers a JS nsIFilePicker for "@mozilla.org/filepicker;1", like the
 * test-only MockFilePicker (not shipped in release builds). Each open() waits
 * `delayMs`, then answers returnOK with `path` (or returnCancel).
 * @param {import("./firefox.mjs").Session} session
 */
export function installMockFilePicker(session) {
  return session.chrome(`
    if (window.__mockFilePicker) return "already installed";
    const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    const state = { delayMs: 0, path: null, cancel: false, calls: [] };
    window.__mockFilePicker = state;
    function MockFilePicker() {}
    MockFilePicker.prototype = {
      QueryInterface: ChromeUtils.generateQI(["nsIFilePicker"]),
      init(browsingContext, title, mode) {
        this.mode = mode;
        state.calls.push({ ev: "init", t: Date.now(), mode });
      },
      appendFilters() {},
      appendFilter() {},
      appendRawFilter() {},
      defaultString: "",
      defaultExtension: "",
      filterIndex: 0,
      displayDirectory: null,
      displaySpecialDirectory: "",
      addToRecentDocs: false,
      okButtonLabel: "",
      get file() {
        const f = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        f.initWithPath(state.path);
        return f;
      },
      get fileURL() {
        return Services.io.newFileURI(this.file);
      },
      open(callback) {
        const result = state.cancel ? Ci.nsIFilePicker.returnCancel : Ci.nsIFilePicker.returnOK;
        state.calls.push({ ev: "open", t: Date.now(), defaultString: this.defaultString, delayMs: state.delayMs });
        setTimeout(() => {
          state.calls.push({ ev: "done", t: Date.now(), result, path: state.path });
          if (typeof callback === "function") callback(result);
          else callback.done(result);
        }, state.delayMs);
      },
      close() {},
    };
    const factory = {
      createInstance(iid) {
        return new MockFilePicker().QueryInterface(iid);
      },
      QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    };
    Components.manager
      .QueryInterface(Ci.nsIComponentRegistrar)
      .registerFactory(Services.uuid.generateUUID(), "mock file picker", "@mozilla.org/filepicker;1", factory);
    return "installed";
  `);
}

/** @param {import("./firefox.mjs").Session} session */
export function configureMockFilePicker(session, { delayMs = 0, path, cancel = false }) {
  return session.chrome(
    `Object.assign(window.__mockFilePicker, { delayMs: arguments[0], path: arguments[1], cancel: arguments[2] }); return true;`,
    delayMs,
    path,
    cancel,
  );
}

/** @param {import("./firefox.mjs").Session} session */
export function mockFilePickerCalls(session) {
  return session.chrome("return window.__mockFilePicker ? window.__mockFilePicker.calls : null;");
}

/**
 * Reads Firefox's own clipboard (in headless mode an in-process clipboard).
 * @param {import("./firefox.mjs").Session} session
 * @param {string[]} flavors
 */
export function readClipboard(session, flavors = ["text/html", "text/plain"]) {
  return session.chrome(
    `const out = {};
     for (const flavor of arguments[0]) {
       const trans = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
       trans.init(null);
       trans.addDataFlavor(flavor);
       try {
         Services.clipboard.getData(trans, Ci.nsIClipboard.kGlobalClipboard, window.browsingContext.currentWindowContext);
         const data = {};
         trans.getTransferData(flavor, data);
         out[flavor] = data.value.QueryInterface(Ci.nsISupportsString).data;
       } catch (e) {
         out[flavor] = null;
       }
     }
     return out;`,
    flavors,
  );
}

/** @param {import("./firefox.mjs").Session} session */
export function clearClipboard(session) {
  return session.chrome("Services.clipboard.emptyClipboard(Ci.nsIClipboard.kGlobalClipboard); return true;");
}

/** @param {import("./firefox.mjs").Session} session */
export function copyStringFromChrome(session, text) {
  return session.chrome(
    `Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(arguments[0]); return true;`,
    text,
  );
}
