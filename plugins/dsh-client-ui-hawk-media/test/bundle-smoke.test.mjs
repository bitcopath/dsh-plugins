/**
 * hawk-media — bundle smoke test.
 *
 * Loads the BUILT `lib/client.js` the way the web shell does — through
 * `window.__ModuleLoader__.load({ id, factory })`, with `require("react")` coming
 * from the platform module table — and then drives the real plugin:
 *
 *   1. exactly one registration, under the package id the shell keys on;
 *   2. `apply()` registers the Sidebar preview type and its keyed slot body;
 *   3. `apply()` arms the in-chat enhancer on the document;
 *   4. a message carrying an absolute `.mp4` path (inline code, the shape an
 *      agent actually writes) ends up with a playable `<video>` element.
 *
 * This is the closest thing to a browser run available in a terminal: it
 * exercises the generated artifact, not the source. A real browser is still
 * required to confirm pixels and playback.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, "..", "lib", "client.js");

/** The smallest DOM the plugin touches. */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.attributes = new Map();
    this.content = [];
    this.parentNode = null;
    this._hidden = false;
    this.className = "";
    this.dataset = {};
    this.listeners = new Map();
    this._src = undefined;
  }

  get textContent() {
    return this.content.map((node) => (node.nodeType === 3 ? node.value : node.textContent)).join("");
  }

  set textContent(value) {
    const text = String(value);
    this.content = text === "" ? [] : [{ nodeType: 3, value: text, parentNode: this }];
  }

  /**
   * Every node in order, text nodes included — exposed as a NodeList-LIKE, never
   * a real Array, because that is what a browser returns. Returning `content`
   * directly let `Array.isArray(block.childNodes)` pass in tests while it is
   * always false in the browser, which is exactly how the 2026-09-15 black
   * screen (every ancestor judged reference-only, hidden up to BODY) shipped
   * green.
   */
  get childNodes() {
    const content = this.content;
    return {
      get length() {
        return content.length;
      },
      item: (index) => content[index] ?? null,
      *[Symbol.iterator]() {
        yield* content;
      },
    };
  }

  /** Element children only, the way `children` behaves in the real DOM. */
  get children() {
    return this.content.filter((node) => node.nodeType === 1);
  }

  /** A real element reflects `hidden` as a content attribute. */
  set hidden(value) {
    this._hidden = value === true;
    if (this._hidden) this.attributes.set("hidden", "");
    else this.attributes.delete("hidden");
  }

  get hidden() {
    return this._hidden;
  }

  set src(value) {
    this._src = value;
  }

  get src() {
    return this._src ?? null;
  }

  load() {}

  get nextSibling() {
    const siblings = this.parentNode?.children ?? [];
    const at = siblings.indexOf(this);
    return at >= 0 && at + 1 < siblings.length ? siblings[at + 1] : null;
  }

  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
    if (String(name) === "hidden") this._hidden = true;
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.content.push(child);
    return child;
  }

  insertBefore(child, reference) {
    child.parentNode = this;
    const at = this.content.indexOf(reference);
    if (at < 0) this.content.push(child);
    else this.content.splice(at, 0, child);
    return child;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  closest() {
    return null;
  }

  descendants() {
    const out = [];
    for (const child of this.children) out.push(child, ...child.descendants());
    return out;
  }

  matches(selector) {
    const attr = /^\[([a-zA-Z-]+)(?:(\*=)"?([^"\]]*)"?)?\]$/.exec(selector);
    if (attr !== null) {
      const value = this.getAttribute(attr[1]);
      if (value === null) return false;
      if (attr[2] === undefined) return true;
      return value.includes(attr[3]);
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  querySelectorAll(selector) {
    return this.descendants().filter((node) => selector.split(",").some((part) => node.matches(part.trim())));
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/**
 * Load the built bundle under a fake shell and keep those globals installed for
 * the whole run — the plugin's enhancer reads `window.location` and `document`
 * lazily, so restoring them before the callback finishes would hide real bugs
 * behind an empty origin.
 *
 * @param run - receives the registered module, the fake document, and the entries.
 */
async function withBuiltBundle(run) {
  const document_ = {
    head: new El("head"),
    body: new El("body"),
    createElement(tag) {
      const node = new El(tag);
      node.ownerDocument = document_;
      return node;
    },
    querySelector() {
      return null;
    },
  };
  document_.head.ownerDocument = document_;
  document_.body.ownerDocument = document_;

  const registered = [];
  const react = {
    createElement: (...args) => ({ type: args[0] }),
    useMemo: (factory) => factory(),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
  };

  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    fetch: globalThis.fetch,
  };
  globalThis.window = {
    location: { origin: "http://127.0.0.1:3081" },
    __ModuleLoader__: {
      load(entry) {
        registered.push(entry);
      },
    },
  };
  globalThis.document = document_;
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (callback) => callback();
  globalThis.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null } });

  try {
    // eslint-disable-next-line no-eval -- the shell evaluates this bundle in global scope.
    (0, eval)(readFileSync(BUNDLE, "utf8"));
    assert.equal(registered.length, 1, "the bundle must register exactly one module");
    const entry = registered[0];
    assert.equal(entry.id, "dsh-client-ui-hawk-media");
    const module = entry.factory((id) => {
      if (id === "react") return react;
      throw new Error(`unexpected platform require: ${id}`);
    });
    return await run({ module, document: document_, entry });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

test("built lib/client.js never branches on Array.isArray(childNodes)", () => {
  // Regression guard for the 2026-09-15 black screen: childNodes is a NodeList
  // in the browser, never an Array, so `Array.isArray(x.childNodes) ? ... : []`
  // always takes the empty branch there — isReferenceOnlyBlock then called every
  // ancestor reference-only and hid the page up to BODY. Forbid the pattern in
  // the generated artifact outright.
  const bundle = readFileSync(BUNDLE, "utf8");
  assert.doesNotMatch(bundle, /Array\.isArray\([^)]*\.childNodes\)/);
});

test("built lib/client.js registers once, under the package id the shell keys on", async () => {
  await withBuiltBundle(({ module }) => {
    assert.equal(typeof module.apply, "function");
    // CHANGE 3: the Sidebar arm is gone, so neither documentPreviews nor slots is
    // declared any more — a dangling inject entry would be a load-order contract
    // with a service this plugin no longer uses.
    assert.deepEqual(module.inject.slice().sort(), ["locale"]);
  });
});

test("CHANGE 3: apply() wires ONLY the in-chat enhancer — no preview, no sidebar slot", async () => {
  await withBuiltBundle(({ module, document: document_ }) => {
    const effects = [];
    let previewRegistrations = 0;
    let slotRegistrations = 0;
    const ctx = {
      locale: { bind: () => (key) => key, register: () => ({}) },
      documentPreviews: {
        register: () => {
          previewRegistrations += 1;
          return {};
        },
      },
      slots: {
        inject: (name, callback) => callback(),
        register: () => {
          slotRegistrations += 1;
          return {};
        },
      },
      effect: (factory) => {
        effects.push(factory());
      },
    };
    module.apply(ctx);

    assert.equal(previewRegistrations, 0, "no document-preview type is registered");
    assert.equal(slotRegistrations, 0, "no sidebar slot body is registered");
    assert.equal(effects.length, 2, "dictionaries + the in-chat enhancer");
    assert.equal(document_.body.getAttribute("data-hawk-media-observing"), "1");
    assert.equal(document_.head.children.length, 1, "one stylesheet");
    assert.equal(typeof globalThis.window.__hawkMedia.count, "function");
  });
});

test("a chat message naming an .mp4 becomes an inline player in the built bundle", async () => {
  await withBuiltBundle(async ({ module, document: document_ }) => {
    module.apply({
      locale: { bind: () => (key) => key, register: () => ({}) },
      effect: (factory) => factory(),
    });

    const paragraph = document_.createElement("p");
    const code = document_.createElement("code");
    code.textContent = "/home/user/clips/interview-master.mp4";
    paragraph.appendChild(code);
    document_.body.appendChild(paragraph);

    assert.equal(globalThis.window.__hawkMedia.scan(), 1);
    const players = document_.body.querySelectorAll("[data-hawk-media-player]");
    assert.equal(players.length, 1);
    assert.equal(players[0].getAttribute("data-hawk-media-kind"), "video");
    const video = players[0].children[0].children[0];
    assert.equal(video.tagName, "VIDEO");
    assert.equal(video.getAttribute("controls"), "");
    // The route probe is a promise; wait the one microtask it needs.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(video.src, "http://127.0.0.1:3081/api/file?path=%2Fhome%2Fuser%2Fclips%2Finterview-master.mp4");

    // CHANGE 1 + 2 in the built artifact: the agent's line is gone, the block that
    // held only the reference is gone, and the caption carries the authored path.
    assert.equal(code.hidden, true, "the consumed reference is hidden");
    assert.equal(paragraph.hidden, true, "the reference-only paragraph is hidden");
    const caption = document_.body.querySelector("[data-hawk-media-ref]");
    assert.notEqual(caption, null, "the caption is the authored reference");
    assert.equal(
      caption.getAttribute("data-hawk-media-ref"),
      "/home/user/clips/interview-master.mp4",
    );
    assert.match(caption.className, /hm-link/);
  });
});
