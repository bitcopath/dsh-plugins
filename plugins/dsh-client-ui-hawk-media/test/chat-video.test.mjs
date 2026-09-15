/**
 * hawk-media — in-chat video player test harness.
 *
 * Two layers, both runnable with `node test/chat-video.test.mjs`:
 *
 *   A. PURE RULES — src/media.js decides what counts as a media reference and
 *      which URLs to try. Plain assertions over plain functions.
 *
 *   B. THE ENHANCER — src/client/chat-video.js actually inserts players into a
 *      DOM. It runs in a small hand-rolled fake DOM: just enough of
 *      document/element/MutationObserver for the enhancer's real code path
 *      (element creation, attribute marks, insertion, sibling placement, the
 *      streamed-route probe and the /api/file fallback). No jsdom, no network.
 *
 * This is the honesty check the plugin did not have before: it exercises the
 * code the browser will run, without claiming a browser was involved.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMediaHandler, parseRange } from "../src/host.js";
import { basenameOf, buildSources, clock, mediaFromText, sizeText, MEDIA_ROUTE, API_FILE_ROUTE } from "../src/media.js";
import { enhance, injectCss, startEnhancer, __scanSelector } from "../src/client/chat-video.js";
import { MEDIA_CONTENT_TYPES, MEDIA_EXTENSIONS } from "../src/shared.js";

/* ------------------------------------------------------------------ *
 * A. pure rules
 * ------------------------------------------------------------------ */

test("mediaFromText: absolute video path", () => {
  const target = mediaFromText("/home/user/clips/film.mp4");
  assert.equal(target.kind, "video");
  assert.equal(target.extension, "mp4");
  assert.equal(target.path, "/home/user/clips/film.mp4");
  assert.equal(target.url, undefined);
});

test("mediaFromText: inline-code text and backticks", () => {
  assert.equal(mediaFromText("`/tmp/clip.webm`").path, "/tmp/clip.webm");
  assert.equal(mediaFromText('"/tmp/clip.MOV"').path, "/tmp/clip.MOV");
  assert.equal(mediaFromText("  /tmp/clip.m4v  ").path, "/tmp/clip.m4v");
});

test("mediaFromText: audio, and every extension the host route allows", () => {
  for (const extension of MEDIA_EXTENSIONS) {
    const clean = extension.slice(1);
    const target = mediaFromText(`/tmp/track.${clean}`);
    assert.notEqual(target, undefined, `expected /tmp/track.${clean} to be media`);
  }
  assert.equal(mediaFromText("/tmp/bed.mp3").kind, "audio");
  assert.equal(mediaFromText("/tmp/bed.flac").kind, "audio");
});

test("mediaFromText: http URL is kept verbatim, query stripped", () => {
  const target = mediaFromText("http://127.0.0.1:7788/film.mp4?token=abc#t=3");
  assert.equal(target.url, "http://127.0.0.1:7788/film.mp4");
  assert.equal(target.path, undefined);
});

test("mediaFromText: the chat's own /api/file URL is reusable", () => {
  const target = mediaFromText("http://127.0.0.1:3081/api/file?path=%2Fhome%2Fx%2Ffilm.mp4");
  assert.equal(target.url, "http://127.0.0.1:3081/api/file?path=%2Fhome%2Fx%2Ffilm.mp4");
});

test("mediaFromText: file:// URL becomes a path", () => {
  assert.equal(mediaFromText("file:///tmp/clip.mp4").path, "/tmp/clip.mp4");
});

test("mediaFromText: ~ expansion needs a home, and then works", () => {
  assert.equal(mediaFromText("~/clips/film.mp4"), undefined);
  assert.equal(mediaFromText("~/clips/film.mp4", "/home/user").path, "/home/user/clips/film.mp4");
});

test("mediaFromText: refuses non-media and relative paths", () => {
  assert.equal(mediaFromText("/home/x/report.md"), undefined);
  assert.equal(mediaFromText("clips/film.mp4"), undefined);
  assert.equal(mediaFromText("/home/x/${OUT}/film.mp4"), undefined);
  assert.equal(mediaFromText("/home/x/a b/film.mp4"), undefined);
  assert.equal(mediaFromText("https://example.com/page"), undefined);
  assert.equal(mediaFromText(""), undefined);
  assert.equal(mediaFromText(undefined), undefined);
});

test("buildSources: streamed route first, /api/file second", () => {
  const target = mediaFromText("/tmp/clip.mp4");
  const sources = buildSources(target, "http://127.0.0.1:3081");
  assert.deepEqual(sources.map((entry) => entry.label), ["stream", "api-file"]);
  assert.equal(sources[0].url, `http://127.0.0.1:3081${MEDIA_ROUTE}?path=${encodeURIComponent("/tmp/clip.mp4")}`);
  assert.equal(sources[1].url, `http://127.0.0.1:3081${API_FILE_ROUTE}?path=${encodeURIComponent("/tmp/clip.mp4")}`);
});

test("buildSources: an http URL is the only source; no origin means no sources", () => {
  const remote = buildSources(mediaFromText("http://host/clip.mp4"), "http://127.0.0.1:3081");
  assert.deepEqual(remote.map((entry) => entry.label), ["url"]);
  assert.deepEqual(buildSources(mediaFromText("/tmp/clip.mp4"), ""), []);
  assert.deepEqual(buildSources(undefined, "http://x"), []);
});

test("clock / basenameOf / sizeText", () => {
  assert.equal(clock(0), "");
  assert.equal(clock(Number.NaN), "");
  assert.equal(clock(9), "0:09");
  assert.equal(clock(75), "1:15");
  assert.equal(clock(3725), "1:02:05");
  assert.equal(basenameOf("/a/b/film.mp4"), "film.mp4");
  assert.equal(basenameOf("/a/b/"), "b");
  assert.equal(sizeText(900), "900 B");
  assert.equal(sizeText(20 * 1024 * 1024), "20.0 MB");
});

/* ------------------------------------------------------------------ *
 * B. the enhancer, against a hand-rolled fake DOM
 * ------------------------------------------------------------------ */

/**
 * Build the smallest DOM the enhancer needs, and return both the root element
 * and the list of `<video>`/`<audio>` elements created, so a test can act like a
 * browser (fire `loadedmetadata` / `error`).
 *
 * @returns a fake DOM harness.
 */
function createFakeDom() {
  const media = [];

  class Node {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.nodeType = 1;
      this.attributes = new Map();
      this.parentNode = null;
      this.content = [];
      this._hidden = false;
      this.className = "";
      this.dataset = {};
      this.listeners = new Map();
    }

    get nextSibling() {
      if (this.parentNode === null) return null;
      const siblings = this.parentNode.children;
      const at = siblings.indexOf(this);
      return at >= 0 && at + 1 < siblings.length ? siblings[at + 1] : null;
    }

    /**
     * Like the real DOM: this element's own text nodes plus its descendants'. The
     * enhancer's "is this block empty apart from the reference?" test reads it, so
     * the fake must include both (a bare property would make the empty-paragraph
     * test lie).
     */
    get textContent() {
      return this.content.map((node) => (node.nodeType === 3 ? node.value : node.textContent)).join("");
    }

    set textContent(value) {
      const text = String(value);
      const node = { nodeType: 3, value: text, parentNode: this };
      this.content = text === "" ? [] : [node];
    }

    /**
     * Every node in order, exposed as a NodeList-LIKE, never a real Array — that
     * is what the real DOM returns, and returning `content` directly let
     * `Array.isArray(block.childNodes)` pass here while it is always false in a
     * browser (the 2026-09-15 hide-up-to-BODY black screen shipped green that
     * way).
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

    /** Test helper: append a text node (the shell does this with append()). */
    appendText(text) {
      this.content.push({ nodeType: 3, value: String(text), parentNode: this });
      return this;
    }

    /** A real media element owns `src` as a reflected property, not an attribute. */
    set src(value) {
      this._src = value;
    }

    get src() {
      return this._src ?? null;
    }

    load() {}

    /** A real element reflects `hidden` as a content attribute; so does this one. */
    set hidden(value) {
      this._hidden = value === true;
      if (this._hidden) this.attributes.set("hidden", "");
      else this.attributes.delete("hidden");
    }

    get hidden() {
      return this._hidden;
    }

    setAttribute(name, value) {
      this.attributes.set(String(name), String(value));
      if (String(name) === "hidden") this._hidden = true;
      if (String(name).startsWith("data-")) {
        const key = String(name).slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[key] = String(value);
      }
    }

    getAttribute(name) {
      return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
      if (String(name) === "hidden") this._hidden = false;
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

    removeChild(child) {
      const at = this.content.indexOf(child);
      if (at >= 0) this.content.splice(at, 1);
      child.parentNode = null;
      return child;
    }

    addEventListener(type, handler) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(handler);
    }

    /** Test-only: act like the browser firing an element event. */
    fire(type) {
      for (const handler of this.listeners.get(type) ?? []) handler({ type, currentTarget: this });
    }

    /** Only the ancestors the skip-rule cares about: `pre` and text-entry hosts. */
    closest(selector) {
      const wanted = String(selector)
        .split(",")
        .map((part) => part.trim().toLowerCase());
      let node = this.parentNode;
      while (node !== null && node !== undefined) {
        const tag = String(node.tagName).toLowerCase();
        for (const part of wanted) {
          if (part === tag) return node;
          if (part === "[contenteditable='true']" && node.getAttribute("contenteditable") === "true") return node;
          if (part === "[contenteditable='plaintext-only']" && node.getAttribute("contenteditable") === "plaintext-only") return node;
          if (part === "[role='textbox']" && node.getAttribute("role") === "textbox") return node;
        }
        node = node.parentNode;
      }
      return null;
    }

    descendants() {
      const out = [];
      for (const child of this.children) out.push(child, ...child.descendants());
      return out;
    }

    /** Minimal selector support: tag, [attr], [attr=value], tag[class*=x]. */
    matches(selector) {
      const attr = /^\[([a-zA-Z-]+)(?:([*^$]?=)"?([^"\]]*)"?)?\]$/.exec(selector);
      if (attr !== null) {
        const value = this.getAttribute(attr[1]);
        if (value === null) return false;
        if (attr[2] === undefined) return true;
        if (attr[2] === "*=") return value.includes(attr[3]);
        if (attr[2] === "^=") return value.startsWith(attr[3]);
        return value === attr[3];
      }
      const attrOnTag = /^([a-zA-Z]+)\[([a-zA-Z-]+)(?:([*]?=)"?([^"\]]*)"?)?\]$/.exec(selector);
      if (attrOnTag !== null) {
        if (this.tagName.toLowerCase() !== attrOnTag[1].toLowerCase()) return false;
        const value = this.getAttribute(attrOnTag[2]);
        if (value === null) return false;
        if (attrOnTag[3] === undefined) return true;
        if (attrOnTag[3] === "*=") return value.includes(attrOnTag[4]);
        return value === attrOnTag[4];
      }
      return this.tagName.toLowerCase() === selector.toLowerCase();
    }

    querySelectorAll(selector) {
      const results = [];
      for (const node of this.descendants()) {
        if (selector.split(",").some((part) => node.matches(part.trim()))) results.push(node);
      }
      return results;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }

  const tags = [];
  const document_ = {
    head: new Node("head"),
    body: new Node("body"),
    createElement(tag) {
      const node = new Node(tag);
      // Real elements know their document; the enhancer reads it to create the
      // player, so the fake has to answer the same way.
      node.ownerDocument = document_;
      tags.push(node);
      if (node.tagName === "VIDEO" || node.tagName === "AUDIO") media.push(node);
      return node;
    },
    querySelector(selector) {
      return document_.head.querySelector(selector);
    },
  };
  document_.head.ownerDocument = document_;
  document_.body.ownerDocument = document_;

  /** Build an element attached under `body`. */
  const el = (tag, attributes = {}) => {
    const node = document_.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  };
  const mount = (parent, node) => parent.appendChild(node);
  return { document: document_, Node, el, mount, media, tags };
}

/**
 * Install the fake DOM (and fetch) as the enhancer's globals for the whole run.
 * The callbacks are awaited BEFORE the globals are restored: eager restoration
 * would leave a player's probe microtask reading `window.location` from the real
 * (undefined) global and silently lose its origin.
 */
async function withFakeBrowser(run, options = {}) {
  const dom = createFakeDom();
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
    fetch: globalThis.fetch,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };
  const probes = [];
  globalThis.window = { location: { origin: options.origin ?? "http://127.0.0.1:3081" } };
  globalThis.document = dom.document;
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  // Synchronous rAF: the enhancer's coalescing code path runs without leaving a
  // pending timer behind for the next test to trip over.
  globalThis.requestAnimationFrame = (callback) => callback();
  globalThis.fetch = async (url, init) => {
    probes.push({ url, method: init?.method });
    const answer = options.probe?.(url) ?? { ok: true, status: 200, headers: { get: () => "20971520" } };
    return answer;
  };
  try {
    return await run(dom, probes);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

/**
 * Wait until `check` is true, the way a browser would: the player's first source
 * is chosen from a HEAD probe, so its `src` lands one microtask after the scan.
 *
 * @param check - predicate.
 * @param label - failure message.
 */
async function waitFor(check, label) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("enhance: an inline-code chat path becomes a player after its paragraph", async () => {
  await withFakeBrowser(async (dom) => {
    const paragraph = dom.el("p");
    const code = dom.el("code");
    code.textContent = "/home/user/clips/film.mp4";
    paragraph.appendChild(code);
    dom.mount(dom.document.body, paragraph);

    assert.equal(enhance(dom.document.body), 1);
    assert.equal(code.getAttribute("data-hawk-media-enhanced"), "1");

    const container = dom.document.body.querySelector("[data-hawk-media-player]");
    assert.notEqual(container, null);
    assert.equal(container.getAttribute("data-hawk-media-kind"), "video");
    assert.equal(container.parentNode, dom.document.body, "video sits at paragraph level");
    assert.equal(dom.document.body.children[0], paragraph, "the agent's own line stays first");

    const video = dom.media[0];
    assert.equal(video.tagName, "VIDEO");
    assert.equal(video.getAttribute("controls"), "");
    assert.equal(video.getAttribute("preload"), "metadata");
    assert.equal(video.getAttribute("data-hawk-media-file"), "/home/user/clips/film.mp4");
    assert.equal(video.parentNode.getAttribute("data-kind"), "video");

    // CHANGE 1: the reference it consumed is gone, and so is the block that held
    // nothing else — the caption under the player is now the only copy.
    assert.equal(code.hidden, true, "the consumed inline-code path is hidden");
    assert.equal(code.getAttribute("data-hawk-media-hidden"), "1");
    assert.equal(paragraph.hidden, true, "a reference-only paragraph is hidden");
    assert.equal(paragraph.getAttribute("data-hawk-media-hidden"), "1");

    // A second scan must not duplicate the player.
    assert.equal(enhance(dom.document.body), 0);
    assert.equal(dom.document.body.querySelectorAll("[data-hawk-media-player]").length, 1);
  });
});

test("CHANGE 1: prose around a reference is NOT hidden, only the reference", async () => {
  await withFakeBrowser(async (dom) => {
    const paragraph = dom.el("p");
    paragraph.textContent = "Here is the verdict clip for shot 5 — watch it: ";
    const anchor = dom.el("a", { href: "http://127.0.0.1:7788/take-05.mp4" });
    anchor.textContent = "take-05.mp4";
    paragraph.appendChild(anchor);
    paragraph.appendText(" and tell me if the grade holds.");
    dom.mount(dom.document.body, paragraph);

    assert.equal(enhance(dom.document.body), 1);
    assert.equal(anchor.hidden, true, "the consumed link is hidden");
    assert.equal(paragraph.hidden, false, "the prose paragraph stays visible");
    assert.equal(paragraph.getAttribute("data-hawk-media-hidden"), null);
    // The verdict request is still readable.
    assert.match(paragraph.textContent, /here is the verdict clip/i);
    assert.match(paragraph.textContent, /tell me if the grade holds/i);
  });
});

test("CHANGE 1: a reference in its own block is hidden with that block, prose siblings survive", async () => {
  await withFakeBrowser(async (dom) => {
    const row = dom.el("tr");
    const proseCell = dom.el("td");
    proseCell.textContent = "shot 5 — years 35, portrait, 9s";
    const mediaCell = dom.el("td");
    const code = dom.el("code");
    code.textContent = "/home/user/clips/take-05.mp4";
    mediaCell.appendChild(code);
    row.appendChild(proseCell);
    row.appendChild(mediaCell);
    dom.mount(dom.document.body, row);

    assert.equal(enhance(dom.document.body), 1);
    assert.equal(code.hidden, true, "the reference is hidden");
    assert.equal(mediaCell.hidden, true, "the cell that held only the reference is hidden");
    assert.equal(proseCell.hidden, false, "the description cell is untouched");
    assert.equal(row.hidden, false, "the row still carries the description");
  });
});

test("CHANGE 2: the caption carries the authored reference, and it is a blue link", async () => {
  await withFakeBrowser(async (dom) => {
    const paragraph = dom.el("p");
    const code = dom.el("code");
    code.textContent = "/home/user/clips/interview-master.mp4";
    paragraph.appendChild(code);
    dom.mount(dom.document.body, paragraph);
    enhance(dom.document.body);

    const caption = dom.document.body.querySelector("[data-hawk-media-ref]");
    assert.notEqual(caption, null, "the caption is the reference");
    assert.equal(caption.getAttribute("data-hawk-media-ref"), "/home/user/clips/interview-master.mp4");
    // Exactly what the agent wrote, with the globe glyph the design uses.
    assert.equal(
      caption.textContent,
      "\u{1F310} /home/user/clips/interview-master.mp4",
    );
    assert.match(caption.className, /hm-link/, "blue link style");
    assert.match(caption.className, /hm-path/, "a path is shown as a path");
    assert.equal(caption.getAttribute("target"), "_blank");
    // A path cannot be a browser target, so the click goes to something playable.
    await waitFor(() => caption.getAttribute("href").startsWith("http"), "the caption to point at a playable URL");
    assert.ok(caption.getAttribute("href").includes(encodeURIComponent("/home/user/clips/")));
  });
});

test("CHANGE 1: a paragraph holding two references is hidden once both are players", async () => {
  await withFakeBrowser(async (dom) => {
    const shot = dom.el("p");
    const one = dom.el("code");
    one.textContent = "/home/user/clips/take-05.mp4";
    const two = dom.el("code");
    two.textContent = "/home/user/clips/take-06.mp4";
    shot.appendChild(one);
    shot.appendChild(two);
    dom.mount(dom.document.body, shot);

    assert.equal(enhance(dom.document.body), 2, "both references get a player");
    assert.equal(one.hidden, true);
    assert.equal(two.hidden, true);
    assert.equal(shot.hidden, true, "with both consumed, the paragraph is an empty shell");
    assert.equal(dom.document.body.querySelectorAll("[data-hawk-media-player]").length, 2);
  });
});

test("CHANGE 1: a partially consumed paragraph keeps the live reference visible", async () => {
  await withFakeBrowser(async (dom) => {
    const shot = dom.el("p");
    const good = dom.el("code");
    good.textContent = "/home/user/clips/take-05.mp4";
    const other = dom.el("code");
    other.textContent = "shot 6 is still rendering";
    shot.appendChild(good);
    shot.appendChild(other);
    dom.mount(dom.document.body, shot);

    assert.equal(enhance(dom.document.body), 1, "only the media reference is enhanced");
    assert.equal(good.hidden, true);
    assert.equal(other.hidden, false, "the non-media note is untouched");
    assert.equal(shot.hidden, false, "the paragraph still says something");
  });
});

test("CHANGE 2: the duration badge survives the caption change", async () => {
  await withFakeBrowser(async (dom) => {
    const paragraph = dom.el("p");
    const code = dom.el("code");
    code.textContent = "/tmp/clip.mp4";
    paragraph.appendChild(code);
    dom.mount(dom.document.body, paragraph);
    enhance(dom.document.body);
    await new Promise((resolve) => setTimeout(resolve, 5));

    dom.media[0].duration = 75;
    dom.media[0].fire("loadedmetadata");

    const container = dom.document.body.querySelector("[data-hawk-media-player]");
    const caption = container.children[1].children[0];
    const badge = container.children[1].children[2];
    assert.match(caption.className, /hm-link/);
    assert.equal(caption.textContent, "\u{1F310} /tmp/clip.mp4");
    assert.match(badge.textContent, /1:15/, "duration still on the badge");
    assert.equal(badge.getAttribute("data-state"), "ok");
  });
});

test("CHANGE 2: an authored URL is shown as that URL and linked to itself", async () => {
  await withFakeBrowser(async (dom) => {
    injectCss();
    const paragraph = dom.el("p");
    const anchor = dom.el("a", { href: "http://127.0.0.1:7788/take-05.mp4" });
    anchor.textContent = "\u{1F310} http://127.0.0.1:7788/take-05.mp4";
    paragraph.appendChild(anchor);
    dom.mount(dom.document.body, paragraph);
    enhance(dom.document.body);

    const caption = dom.document.body.querySelector("[data-hawk-media-ref]");
    assert.equal(caption.getAttribute("data-hawk-media-ref"), "http://127.0.0.1:7788/take-05.mp4");
    assert.equal(caption.textContent, "\u{1F310} http://127.0.0.1:7788/take-05.mp4");
    assert.equal(caption.getAttribute("href"), "http://127.0.0.1:7788/take-05.mp4");
    assert.match(caption.className, /hm-link/);
    assert.doesNotMatch(caption.className, /hm-path/, "a URL is not shown in path styling");
    // Exactly ONE caption rule, and it is the blue one: an earlier commit added a
    // second, equal-specificity block that re-styled the caption as a bordered
    // button and silently killed the blue caption (later block wins).
    const sheet = dom.document.head.children
      .filter((node) => node.tagName === "STYLE")
      .map((node) => node.textContent)
      .join("");
    const blueRules = sheet.match(/\.hm-link\s*\{[^}]*--dsw-alias-label-link[^}]*\}/g) ?? [];
    assert.equal(blueRules.length, 1, "one blue caption rule");
    assert.doesNotMatch(sheet, /\.hm-link:hover\s*\{[^}]*background:/, "the button re-style is gone");
    assert.doesNotMatch(sheet, /\.hm-link\s*\{[^}]*border: 1px solid/, "no second block re-styles the caption");
    // The hiding rule that makes a consumed reference disappear ships too.
    assert.match(sheet, /\[data-hawk-media-hidden\]\s*\{\s*display: none !important;\s*\}/);
  });
});

test("enhance: an <a> href wins, audio stays inline, and the /api/file URL is honoured", async () => {
  await withFakeBrowser(async (dom) => {
    const paragraph = dom.el("p");
    const anchor = dom.el("a", { href: "http://127.0.0.1:3081/api/file?path=%2Ftmp%2Fbed.mp3" });
    anchor.textContent = "bed.mp3";
    paragraph.appendChild(anchor);
    dom.mount(dom.document.body, paragraph);

    assert.equal(enhance(dom.document.body), 1);
    const container = dom.document.body.querySelector("[data-hawk-media-player]");
    assert.equal(container.getAttribute("data-hawk-media-kind"), "audio");
    assert.equal(container.parentNode, paragraph, "audio stays inside the line");
    const audio = dom.media[0];
    assert.equal(audio.tagName, "AUDIO");
    assert.equal(audio.src, "http://127.0.0.1:3081/api/file?path=%2Ftmp%2Fbed.mp3");
    // CHANGE 2: the caption shows the authored reference (here the href), not a basename.
    const caption = paragraph.querySelector("[data-hawk-media-ref]");
    assert.equal(caption.textContent, "\u{1F310} http://127.0.0.1:3081/api/file?path=%2Ftmp%2Fbed.mp3");
    assert.equal(caption.getAttribute("href"), "http://127.0.0.1:3081/api/file?path=%2Ftmp%2Fbed.mp3");
  });
});

test("enhance: skips code blocks, the composer, and inert text", async () => {
  await withFakeBrowser(async (dom) => {
    const pre = dom.el("pre");
    const codeBlock = dom.el("code");
    codeBlock.textContent = "/tmp/clip.mp4";
    pre.appendChild(codeBlock);
    dom.mount(dom.document.body, pre);

    const composer = dom.el("div", { contenteditable: "true" });
    const composerCode = dom.el("code");
    composerCode.textContent = "/tmp/clip.mp4";
    composer.appendChild(composerCode);
    dom.mount(dom.document.body, composer);

    const prose = dom.el("p");
    const proseCode = dom.el("code");
    proseCode.textContent = "/home/x/report.md";
    prose.appendChild(proseCode);
    dom.mount(dom.document.body, prose);

    assert.equal(enhance(dom.document.body), 0);
    assert.equal(dom.media.length, 0);
  });
});

test("enhance: a `pre` ancestor only blocks its own subtree", async () => {
  await withFakeBrowser(async (dom) => {
    const pre = dom.el("pre");
    const inside = dom.el("code");
    inside.textContent = "/tmp/inside.mp4";
    pre.appendChild(inside);
    dom.mount(dom.document.body, pre);

    const paragraph = dom.el("p");
    const outside = dom.el("code");
    outside.textContent = "/tmp/outside.mp4";
    paragraph.appendChild(outside);
    dom.mount(dom.document.body, paragraph);

    assert.equal(enhance(dom.document.body), 1);
    assert.equal(inside.getAttribute("data-hawk-media-enhanced"), null);
    assert.equal(dom.media[0].getAttribute("data-hawk-media-file"), "/tmp/outside.mp4");
  });
});

test("player: the streamed route is probed, and a missing route falls back to /api/file", async () => {
  await withFakeBrowser(async (dom, probes) => {
    const paragraph = dom.el("p");
    const code = dom.el("code");
    code.textContent = "/tmp/clip.mp4";
    paragraph.appendChild(code);
    dom.mount(dom.document.body, paragraph);
    enhance(dom.document.body);

    // The probe is a HEAD against the plugin's own route.
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(probes.length, 1);
    assert.equal(probes[0].method, "HEAD");
    assert.ok(probes[0].url.startsWith(`http://127.0.0.1:3081${MEDIA_ROUTE}?path=`));
    assert.equal(dom.media[0].src, probes[0].url, "route present -> streamed");

    // Now the same code path with the route absent (before a `dsh web` restart):
    // the player must move on to /api/file by itself.
    dom.document.body.removeChild(paragraph);
    const second = dom.el("p");
    const secondCode = dom.el("code");
    secondCode.textContent = "/tmp/clip2.mp4";
    second.appendChild(secondCode);
    dom.mount(dom.document.body, second);
    probes.length = 0;
    globalThis.fetch = async (url, init) => {
      probes.push({ url, method: init?.method });
      return { ok: false, status: 404, headers: { get: () => null } };
    };
    enhance(dom.document.body);
    await waitFor(() => dom.media[1]?.src !== null && dom.media[1] !== undefined, "the second player to pick a source");

    const video = dom.media[1];
    assert.ok(video.src.startsWith("http://127.0.0.1:3081/api/file?path="), "404 -> /api/file fallback");
  });
});

test("player: an exhausted source list reports why, not a silent black box", async () => {
  await withFakeBrowser(async (dom) => {
    // The route is absent for BOTH candidates, so the player walks its whole
    // list before it may report a failure.
    globalThis.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null } });

    const paragraph = dom.el("p");
    const code = dom.el("code");
    code.textContent = "/tmp/clip.mp4";
    paragraph.appendChild(code);
    dom.mount(dom.document.body, paragraph);
    enhance(dom.document.body);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const video = dom.media[0];
    assert.equal(video.src, "http://127.0.0.1:3081/api/file?path=%2Ftmp%2Fclip.mp4", "fell through to /api/file");

    // The browser raises one error per failed source; the last one must latch a
    // message instead of starting another swap.
    video.fire("error");
    await new Promise((resolve) => setTimeout(resolve, 5));
    video.fire("error");

    const container = dom.document.body.querySelector("[data-hawk-media-player]");
    const error = container.children[2];
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /larger than the harness image limit|No playable source/);
    const badge = container.children[1].children[2];
    assert.equal(badge.getAttribute("data-state"), "error");
    assert.ok(badge.textContent.length > 0);
    assert.equal(dom.media.length, 1, "a failed player never spawns a second element");
  });
});

test("player: loadedmetadata fills the duration into the badge", async () => {
  await withFakeBrowser(async (dom) => {
    const paragraph = dom.el("p");
    const code = dom.el("code");
    code.textContent = "/tmp/clip.mp4";
    paragraph.appendChild(code);
    dom.mount(dom.document.body, paragraph);
    enhance(dom.document.body);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const video = dom.media[0];
    video.duration = 75;
    video.fire("loadedmetadata");
    const container = dom.document.body.querySelector("[data-hawk-media-player]");
    const badge = container.children[1].children[2];
    assert.equal(badge.getAttribute("data-state"), "ok");
    assert.match(badge.textContent, /1:15/);
    assert.match(badge.textContent, /20\.0 MB/);
  });
});

test("enhance: a relative path is reported, never guessed", async () => {
  await withFakeBrowser(async (dom) => {
    const paragraph = dom.el("p");
    const code = dom.el("code");
    code.textContent = "reports/film.mp4";
    paragraph.appendChild(code);
    dom.mount(dom.document.body, paragraph);
    assert.equal(enhance(dom.document.body), 0);
  });
});

test("injectCss and startEnhancer are idempotent and inject exactly one stylesheet", async () => {
  await withFakeBrowser(async (dom) => {
    injectCss();
    injectCss();
    assert.equal(dom.document.head.querySelectorAll("style").length, 1, "one stylesheet per document");
    const stop = startEnhancer();
    assert.equal(dom.document.body.getAttribute("data-hawk-media-observing"), "1");
    startEnhancer();
    assert.equal(dom.document.body.getAttribute("data-hawk-media-observing"), "1", "a second start does not re-own the observer");
    stop();
    assert.equal(dom.document.body.getAttribute("data-hawk-media-observing"), null);
    // After a real stop, the module owns the document again.
    startEnhancer();
    assert.equal(dom.document.body.getAttribute("data-hawk-media-observing"), "1");
  });
});

test("the scanner selector covers link, code, file chip and failed-image alt shapes", () => {
  assert.match(__scanSelector, /a\[href\]/);
  assert.match(__scanSelector, /code/);
  assert.match(__scanSelector, /data-file-type-mark/);
  assert.match(__scanSelector, /imageAlt/);
});

/* ------------------------------------------------------------------ *
 * C. the host route
 * ------------------------------------------------------------------ */

test("parseRange: the three real forms, plus refusals", () => {
  assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=500-", 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange("bytes=0-5000", 1000), { start: 0, end: 999 }, "end clamps to size");
  assert.equal(parseRange(undefined, 1000), undefined, "no header -> full body");
  assert.equal(parseRange("bytes=", 1000), undefined);
  assert.equal(parseRange("items=0-1", 1000), undefined, "only bytes ranges are served");
  assert.equal(parseRange("bytes=1000-1200", 1000), "unsatisfiable", "past EOF is 416");
  assert.equal(parseRange("bytes=800-100", 1000), "unsatisfiable");
  assert.equal(parseRange("bytes=-0", 1000), "unsatisfiable");
});

/** Call the host handler with a tiny fake request/response and capture the outcome. */
async function callHandler(handler, { method = "GET", url, headers = {} }) {
  const chunks = [];
  const { Writable } = await import("node:stream");
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  response.statusCode = 0;
  response.headers = {};
  response.setHeader = function setHeader(name, value) {
    this.headers[name] = value;
  };
  response.writeHead = function writeHead(status, headers) {
    this.statusCode = status;
    Object.assign(this.headers, headers);
  };
  response.destroy = function destroy() {
    this.destroyed = true;
  };
  response._chunks = chunks;
  const request = { method, url, headers };
  await handler(request, response);
  if (response.statusCode === 200 || response.statusCode === 206) {
    // Let a piped ReadStream finish before the assertions run.
    await new Promise((resolve) => response.on("finish", resolve));
  }
  return response;
}

test("host route: auth first, then method, then path shape, then extension", async () => {
  const ctx = { connection: { requestRejection: () => 401 } };
  const rejected = await callHandler(createMediaHandler(ctx), { url: "/api/hawk-media?path=/tmp/a.mp4" });
  assert.equal(rejected.statusCode, 401);

  const open = { connection: { requestRejection: () => undefined } };
  const handler = createMediaHandler(open);
  assert.equal((await callHandler(handler, { method: "POST", url: "/api/hawk-media?path=/tmp/a.mp4" })).statusCode, 405);
  assert.equal((await callHandler(handler, { url: "/api/hawk-media" })).statusCode, 400);
  assert.equal((await callHandler(handler, { url: "/api/hawk-media?path=relative.mp4" })).statusCode, 400);
  assert.equal((await callHandler(handler, { url: "/api/hawk-media?path=/etc/hostname" })).statusCode, 415);
  assert.equal((await callHandler(handler, { url: "/api/hawk-media?path=/tmp/definitely-missing.mp4" })).statusCode, 404);
});

test("host route: HEAD reports length and type, GET streams with Range", async () => {
  // This test file is small but real, and ends in a served extension only by
  // copying it — instead serve a real media-looking file we create ourselves.
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "hawk-media-test-"));
  const file = join(directory, "clip.mp4");
  const payload = Buffer.alloc(4096, 7);
  await writeFile(file, payload);

  const handler = createMediaHandler({ connection: { requestRejection: () => undefined } });
  const head = await callHandler(handler, {
    method: "HEAD",
    url: `/api/hawk-media?path=${encodeURIComponent(file)}`,
  });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers["content-length"], "4096");
  assert.equal(head.headers["content-type"], "video/mp4");
  assert.equal(head.headers["accept-ranges"], "bytes");

  const partial = await callHandler(handler, {
    url: `/api/hawk-media?path=${encodeURIComponent(file)}`,
    headers: { range: "bytes=0-1023" },
  });
  assert.equal(partial.statusCode, 206);
  assert.equal(partial.headers["content-length"], "1024");
  assert.equal(partial.headers["content-range"], "bytes 0-1023/4096");

  const beyond = await callHandler(handler, {
    url: `/api/hawk-media?path=${encodeURIComponent(file)}`,
    headers: { range: "bytes=99999-100000" },
  });
  assert.equal(beyond.statusCode, 416);

  const { rm } = await import("node:fs/promises");
  await rm(directory, { recursive: true, force: true });
});

test("host and client agree on the route and the extension list", async () => {
  const clientExtensions = Object.keys(MEDIA_CONTENT_TYPES).map((key) => key.slice(1)).sort();
  assert.deepEqual(clientExtensions, MEDIA_EXTENSIONS.map((extension) => extension.slice(1)).sort());
  assert.equal(MEDIA_ROUTE, "/api/hawk-media");
});

/* ------------------------------------------------------------------ *
 * D. the image arm (2026-09-15): same frame, same blue caption, no transport
 * ------------------------------------------------------------------ */

test("mediaFromText: an absolute image path is the third arm", () => {
  const target = mediaFromText("/home/user/shots/frames-sheet.png");
  assert.equal(target.kind, "image");
  assert.equal(target.extension, "png");
  assert.equal(target.path, "/home/user/shots/frames-sheet.png");
});

test("mediaFromText: every image extension the page is likely to name", () => {
  for (const extension of ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"]) {
    assert.equal(mediaFromText(`/tmp/shot.${extension}`).kind, "image", extension);
  }
});

test("shared: the image arm carries MIME types the host route can serve", () => {
  const expected = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
  };
  for (const [extension, type] of Object.entries(expected)) {
    assert.equal(MEDIA_CONTENT_TYPES[extension], type, extension);
  }
});

test("player: the image arm renders an <img> with the blue caption and NO controls", async () => {
  await withFakeBrowser(async (dom) => {
    const paragraph = dom.el("p");
    const code = dom.el("code");
    code.textContent = "/home/user/screens/sheet.png";
    paragraph.appendChild(code);
    dom.mount(dom.document.body, paragraph);
    enhance(dom.document.body);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const container = dom.document.body.querySelector("[data-hawk-media-player]");
    assert.ok(container, "an image reference gets the same player container as audio and video");
    assert.equal(container.getAttribute("data-hawk-media-kind"), "image");

    const frame = container.children[0];
    assert.equal(frame.getAttribute("data-kind"), "image");
    const image = frame.children[0];
    assert.equal(image.tagName, "IMG", "the image arm builds an <img>, not a <video>");
    const controls = image.getAttribute("controls");
    assert.ok(controls === undefined || controls === null, "an image must carry no transport controls");

    const bar = container.children[1];
    const name = bar.children[0];
    assert.match(name.className, /hm-link/, "the caption keeps the blue link class");
    assert.ok(name.textContent.includes("sheet.png"), "the caption names the authored file");
    assert.equal(name.getAttribute("data-hawk-media-ref"), "/home/user/screens/sheet.png");

    image.naturalWidth = 1365;
    image.naturalHeight = 1365;
    image.fire("load");
    const badge = bar.children[2];
    assert.equal(badge.getAttribute("data-state"), "ok");
    assert.match(badge.textContent, /1365/, "an image reports its pixel size where a clip shows a duration");
  });
});

test("player: an image that fails reports a sentence, not a silent box", async () => {
  await withFakeBrowser(async (dom) => {
    const paragraph = dom.el("p");
    const code = dom.el("code");
    code.textContent = "/tmp/missing.png";
    paragraph.appendChild(code);
    dom.mount(dom.document.body, paragraph);
    enhance(dom.document.body);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const image = dom.document.body.querySelector("img");
    image.fire("error");
    image.fire("error");
    const container = dom.document.body.querySelector("[data-hawk-media-player]");
    const error = container.children[2];
    assert.equal(error.hidden, false);
    assert.match(error.textContent, /image could not be displayed|larger than the harness image limit/);
  });
});

test("player: an image on its own line keeps its frame VISIBLE (the block is not hidden with it)", async () => {
  await withFakeBrowser(async (dom) => {
    const paragraph = dom.el("p");
    const code = dom.el("code");
    code.textContent = "/tmp/sheet.png";
    paragraph.appendChild(code);
    dom.mount(dom.document.body, paragraph);
    enhance(dom.document.body);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const container = dom.document.body.querySelector("[data-hawk-media-player]");
    assert.ok(container, "the frame was built");
    // The bug this test exists for (2026-09-15): the frame was inserted inside the paragraph it had
    // consumed, the paragraph was judged reference-only and hidden, and the reader saw nothing at all.
    let up = container.parentNode;
    const hiddenAncestors = [];
    while (up !== null && up !== undefined) {
      if (typeof up.getAttribute === "function" && up.getAttribute("data-hawk-media-hidden") !== null) {
        hiddenAncestors.push(up.tagName);
      }
      up = up.parentNode;
    }
    assert.deepEqual(hiddenAncestors, [], "no ancestor of the frame may be hidden");
    assert.equal(code.getAttribute("data-hawk-media-hidden"), "1", "the reference itself is still consumed");
  });
});

test("player: a standalone audio line is not hidden with its player either", async () => {
  await withFakeBrowser(async (dom) => {
    const paragraph = dom.el("p");
    const code = dom.el("code");
    code.textContent = "/tmp/voice.mp3";
    paragraph.appendChild(code);
    dom.mount(dom.document.body, paragraph);
    enhance(dom.document.body);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const container = dom.document.body.querySelector("[data-hawk-media-player]");
    assert.ok(container, "the player was built");
    let up = container.parentNode;
    const hiddenAncestors = [];
    while (up !== null && up !== undefined) {
      if (typeof up.getAttribute === "function" && up.getAttribute("data-hawk-media-hidden") !== null) {
        hiddenAncestors.push(up.tagName);
      }
      up = up.parentNode;
    }
    assert.deepEqual(hiddenAncestors, [], "no ancestor of the player may be hidden");
  });
});
