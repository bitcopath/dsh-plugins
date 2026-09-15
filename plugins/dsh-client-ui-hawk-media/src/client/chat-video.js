/**
 * hawk-media — inline player for media named in the chat.
 *
 * WHAT THIS IS
 *   A DOM enhancer, not a slot occupant. The chat markdown renderer has no
 *   `<video>` support of any kind (verified: zero `createElement("video")` in the
 *   whole web frontend bundle) and no raw-HTML step, so the only thing a message
 *   can carry is TEXT — a link, an inline-code path, or an image's alt span that
 *   survives a failed load. An agent that renders a film writes its path in
 *   exactly that shape.
 *
 *   So: one document-wide `MutationObserver` scans for anchors, code spans and
 *   alt spans that name a media file and have not been enhanced yet, and inserts a
 *   native player (controls, scrubber, mute, fullscreen, download) directly under
 *   the line the agent wrote. The reference it consumed is then HIDDEN — and the
 *   whole paragraph too when that paragraph held nothing but the reference — so
 *   the reader sees the player and its caption, not three copies of one link
 *   (2026-09-15). Prose around a reference is never touched.
 *
 * WHY NOT A SLOT
 *   `conversation.message.images`, `conversation.trajectory.images` and
 *   `tool.call.images` are SINGLE slots: a registration REPLACES the shipped
 *   image gallery (slot catalog in dsh-cordis-client-runner:
 *   `replaceRisk: "shadows-shipped-ui"`). Taking one over to add video would mean
 *   re-implementing inline image rendering and image attachments — regression risk
 *   with no upside. The chat-node and turn-tail seats are each occupied by a much
 *   larger shipped renderer. The additive, tag-and-class-free DOM hook breaks no
 *   contract, and it also enhances history that is already on screen.
 */

import {
  buildSources,
  clock,
  mediaFromText,
  sizeText,
} from "../media.js";

/** Marker on an element that already has a player. */
const ENHANCED = "data-hawk-media-enhanced";
/** Marker on our own container, so a scan never re-reads its own output. */
const PLAYER_TAG = "data-hawk-media-player";

const MEDIA_SELECTOR = [
  "a[href]",
  "code",
  "[data-file-type-mark]",
  '[class*="imageAlt"]',
].join(",");

/** Never enhance inside these: code samples, the composer, our own output. */
const SKIP_CONTAINER = [
  "pre",
  "textarea",
  "input",
  "form",
  "[contenteditable='true']",
  "[contenteditable='plaintext-only']",
  "[role='textbox']",
  `[${PLAYER_TAG}]`,
].join(",");

/**
 * Live state of one player.
 *
 * @typedef {object} HawkPlayerState
 * @property {Array<{ url: string, label: string }>} sources candidate URLs, best first
 * @property {number} index which candidate is currently loaded
 * @property {boolean} switched true while a candidate swap is in flight
 * @property {boolean} exhausted true once the last candidate has failed
 * @property {number | undefined} bytes size reported by the probe, when known
 * @property {string} clockText duration readout for the badge
 * @property {HTMLElement} badge status badge
 * @property {HTMLElement} error failure line
 * @property {HTMLMediaElement} media the <video>/<audio> element
 */

/** Live state per host element. */
const STATE = new WeakMap();

/**
 * Documents whose stylesheet and observer this module already owns. A module
 * instance can be applied more than once (HMR reload, a second mount), and one
 * stylesheet plus one observer per document is the contract — neither the CSS
 * tag nor the body attribute survives a full re-render in every case.
 */
const STYLED = new WeakSet();
const OBSERVING = new WeakSet();

/**
 * Inject the player stylesheet once. Every class is ours (`hm-*`), so nothing
 * here can collide with the shell's hashed CSS modules.
 *
 * @returns void
 */
export function injectCss() {
  if (typeof document === "undefined") return;
  if (STYLED.has(document)) return;
  const tagId = "dsh-client-ui-hawk-media/in-chat-video.css";
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) {
    STYLED.add(document);
    return;
  }
  const tag = document.createElement("style");
  tag.dataset.plugin = "dsh-client-ui-hawk-media";
  tag.dataset.pluginCss = tagId;
  tag.textContent = `
.hm-box { box-sizing: border-box; display: flex; flex-direction: column; gap: 4px; width: 100%; max-width: 720px; margin: 6px 0 2px; }
.hm-box *, .hm-box *::before, .hm-box *::after { box-sizing: border-box; }
/* A consumed reference is hidden with the hidden attribute; a hidden element is
   display:none by default, but the shell's markdown CSS sets its own display on
   paragraphs and links, so it is stated explicitly here. */
[data-hawk-media-hidden] { display: none !important; }
.hm-frame { position: relative; width: 100%; background: #000; border: 1px solid var(--dsw-alias-border-l1, #2e3240); border-radius: 10px; overflow: hidden; line-height: 0; }
.hm-frame[data-kind="audio"] { background: var(--dsw-specific-tip, #161922); padding: 8px; line-height: normal; }
/* Image arm (2026-09-15): no black letterbox and no fixed height — the picture sets its own
   proportions and shrinks to fit the message column, keeping the caption directly under it. */
.hm-frame[data-kind="image"] { background: var(--dsw-alias-bg-layer1, #161922); padding: 4px; line-height: normal; }
.hm-frame[data-kind="image"] .hm-media { width: auto; max-width: 100%; max-height: 640px; margin: 0 auto; background: transparent; }
.hm-media { display: block; width: 100%; max-height: 420px; background: #000; }
.hm-frame[data-kind="audio"] .hm-media { max-height: none; }
.hm-bar { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f9e); }
/* The caption is the authored reference: a blue globe link when the agent wrote a
   URL, the literal path otherwise. Only ONE .hm-link rule exists — an earlier
   commit added a second one that re-styled it as a bordered button, and equal
   specificity meant the later block silently won and killed the blue. */
.hm-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hm-link { color: var(--dsw-alias-label-link, #5aa9ff); text-decoration: none; cursor: pointer; }
.hm-link:hover { text-decoration: underline; }
.hm-path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.hm-spacer { flex: 1 1 auto; }
.hm-badge { flex: none; padding: 0 6px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1, #2e3240); font-variant-numeric: tabular-nums; white-space: nowrap; }
.hm-badge[data-state="pending"] { color: #d9a13b; border-color: rgba(217,161,59,.5); }
.hm-badge[data-state="ok"] { color: #7cc47f; border-color: rgba(124,196,127,.4); }
.hm-badge[data-state="error"] { color: var(--dsw-alias-state-error-primary, #e5534b); border-color: rgba(229,83,75,.5); }
.hm-error { margin: 0; font-size: 11.5px; line-height: 16px; color: var(--dsw-alias-state-error-primary, #e5534b); }
.hm-error[hidden] { display: none; }
`;
  document.head.appendChild(tag);
  STYLED.add(document);
}

/**
 * @param node - candidate element.
 * @returns true when it sits inside something we must not touch.
 */
function insideSkippedContainer(node) {
  if (node === null || node === undefined) return true;
  // Walk the ancestry for our OWN player first. Every player's caption is an <a href="….mp4"> - exactly
  // the shape this scanner looks for - so the skip must hold even where closest() does not understand
  // arbitrary attribute selectors (a partial/fake DOM, or any future shim). Without this, one scan after
  // a player exists could append a second player for the player's own caption.
  let up = node;
  while (up !== null && up !== undefined) {
    if (typeof up.getAttribute === "function" && up.getAttribute(PLAYER_TAG) !== null) return true;
    up = up.parentNode;
  }
  if (typeof node.closest !== "function") return false;
  try {
    return node.closest(SKIP_CONTAINER) !== null;
  } catch {
    return true;
  }
}

/**
 * Read the media target out of an element, plus the reference text exactly as the
 * agent authored it (the element's own href or text), which the caption shows.
 *
 * @param node - anchor / code span / alt span.
 * @returns `{ target, reference }`, or undefined when the element names no media.
 */
function targetOfElement(node) {
  const tag = String(node.tagName ?? "").toLowerCase();
  const href = typeof node.getAttribute === "function" ? node.getAttribute("href") : null;
  const alt = tag === "img" ? node.getAttribute("alt") : null;
  const text = tag === "img" ? null : (node.textContent ?? "");
  for (const candidate of [href, alt, text]) {
    if (candidate === null || candidate === undefined) continue;
    const target = mediaFromText(candidate);
    if (target !== undefined) return { target, reference: candidate.trim() };
  }
  return undefined;
}

/**
 * Create the player widget for one element. It is appended as a SIBLING of the
 * element (or of its paragraph, for video), and the element it consumed is hidden
 * by the caller — the caption below the player is the single remaining copy of the
 * reference.
 *
 * @param host - the element naming the media.
 * @param target - `mediaFromText` result for that element.
 * @param reference - the reference text as authored (href or element text).
 * @returns the container element and its live state.
 */
function createPlayer(host, target, reference) {
  const doc = host.ownerDocument;
  const origin = typeof window === "undefined" ? "" : (window.location?.origin ?? "");
  const sources = buildSources(target, origin);
  const label = target.path ?? target.url ?? "";
  const authored = reference !== undefined && reference !== "" ? reference : label;

  const container = doc.createElement("div");
  container.setAttribute(PLAYER_TAG, "1");
  container.setAttribute("data-hawk-media-kind", target.kind);
  container.className = "hm-box";

  const frame = doc.createElement("div");
  frame.className = "hm-frame";
  frame.setAttribute("data-kind", target.kind);

  // Three arms, one frame (2026-09-15): <audio> and <video> carry controls, an <img> carries
  // none on purpose — the image arm is the same player box minus the transport, because the point of
  // it is the CAPTION under the picture. The core renderer already draws an image from an absolute
  // path, but with no label, so the reader cannot tell which file they are looking at.
  const isImage = target.kind === "image";
  const media = doc.createElement(isImage ? "img" : target.kind === "audio" ? "audio" : "video");
  media.className = "hm-media";
  media.setAttribute("data-hawk-media-file", label);
  if (isImage) {
    media.setAttribute("decoding", "async");
    media.setAttribute("alt", label);
  } else {
    media.setAttribute("controls", "");
    media.setAttribute("controlslist", "nodownload");
    media.setAttribute("preload", "metadata");
    media.setAttribute("playsinline", "");
    if (target.kind === "video") media.setAttribute("width", "720");
  }
  frame.appendChild(media);
  container.appendChild(frame);

  const bar = doc.createElement("div");
  bar.className = "hm-bar";
  // 2026-09-15: the bottom-left caption is the BLUE CLICKABLE reference, with a globe glyph, and
  // it must show EXACTLY what the agent wrote — the path when it wrote a path, the URL when it wrote a
  // URL — because the line above it is now hidden and the caption is the only copy left. The click
  // target is always something playable (the authored URL, or the served URL behind a path). The
  // scanner skips anything inside [data-hawk-media-player], so this anchor cannot spawn a second player.
  const authoredUrl = /^https?:\/\//i.test(authored) ? authored : "";
  const name = doc.createElement("a");
  name.className = "hm-name hm-link";
  if (authoredUrl === "") name.className = "hm-name hm-link hm-path";
  name.setAttribute("href", authoredUrl !== "" ? authoredUrl : (sources[0]?.url ?? "#"));
  name.setAttribute("target", "_blank");
  name.setAttribute("rel", "noreferrer");
  name.setAttribute("data-hawk-media-ref", authored);
  name.textContent = `\u{1F310} ${authored}`;
  name.title = authored;
  const spacer = doc.createElement("span");
  spacer.className = "hm-spacer";
  const badge = doc.createElement("span");
  badge.className = "hm-badge";
  bar.appendChild(name);
  bar.appendChild(spacer);
  bar.appendChild(badge);
  container.appendChild(bar);

  const error = doc.createElement("p");
  error.className = "hm-error";
  error.hidden = true;
  container.appendChild(error);

  /** @type {HawkPlayerState} */
  const state = {
    sources,
    index: 0,
    switched: false,
    exhausted: false,
    bytes: undefined,
    clockText: "",
    badge,
    error,
    media,
  };
  STATE.set(host, state);

  /**
   * @param status - "pending" | "ok" | "error".
   * @param detail - short right-hand text.
   */
  const paint = (status, detail) => {
    const parts = [detail, state.clockText, state.bytes === undefined ? "" : sizeText(state.bytes)];
    badge.setAttribute("data-state", status);
    badge.textContent = parts.filter(Boolean).join(" · ");
  };

  const labelOf = (index) => {
    const source = state.sources[index];
    if (source === undefined) return "";
    if (source.label === "stream") return "streamed";
    if (source.label === "api-file") return "api/file";
    return "url";
  };

  const showError = (text, detail) => {
    error.hidden = false;
    error.textContent = text;
    paint("error", detail);
  };

  /** Point the element at candidate `state.index`, or report exhaustion. */
  const loadCurrent = () => {
    const source = state.sources[state.index];
    if (source === undefined) {
      showError(
        target.path === undefined
          ? (isImage ? "This image could not be displayed." : "This media could not be played.")
          : "No playable source for this path — is the file still there?",
        "unavailable",
      );
      return;
    }
    error.hidden = true;
    paint("pending", labelOf(state.index));
    media.src = source.url;
    try {
      // An <img> has no load() — guard rather than rely on catching a TypeError.
      if (typeof media.load === "function") media.load();
    } catch {
      // The element is already detached; nothing to recover.
    }
  };

  /**
   * Move to the next candidate source (streamed route -> /api/file). Once the
   * last candidate has failed, `exhausted` latches: a source swap must never
   * trigger another swap, so the failure reaches the reader as a message instead
   * of an endless loop.
   */
  const nextSource = () => {
    const failed = state.sources[state.index];
    if (state.index + 1 >= state.sources.length) {
      state.exhausted = true;
      showError(
        failed?.label === "api-file"
          ? `This ${isImage ? "image" : "clip"} is larger than the harness image limit (20 MiB by default), so /api/file refused it. The streamed route needs a \`dsh web\` restart.`
          : (isImage ? "This image could not be displayed." : "This clip could not be played."),
        failed?.label ?? "error",
      );
      return;
    }
    state.switched = true;
    state.index += 1;
    loadCurrent();
    state.switched = false;
  };

  /** Both arms settle differently: media fires `loadedmetadata`, an <img> fires `load`. */
  const settle = () => {
    state.exhausted = false;
    // An image has no duration; its clock slot carries the pixel size instead, so the badge still
    // says something useful about the file on screen.
    state.clockText = isImage
      ? (media.naturalWidth > 0 ? `${media.naturalWidth}\u00D7${media.naturalHeight}` : "")
      : clock(media.duration);
    paint("ok", labelOf(state.index));
  };
  media.addEventListener(isImage ? "load" : "loadedmetadata", settle);
  media.addEventListener("error", () => {
    if (state.switched || state.exhausted) return;
    nextSource();
  });

  if (sources.length === 0) {
    showError(
      "Relative paths cannot be played — the agent must write an absolute path or an http(s) URL.",
      "no source",
    );
    return container;
  }

  const first = sources[0];
  if (first.label === "stream" && typeof fetch === "function") {
    // Probe once per element: before `dsh web` is restarted the route answers
    // 404, and the player should fall straight through to /api/file rather than
    // sitting on a dead source. The probe also supplies the real size for the badge.
    fetch(first.url, { method: "HEAD" })
      .then((response) => {
        const length = Number(response.headers?.get?.("content-length") ?? "");
        if (Number.isFinite(length) && length > 0) state.bytes = length;
        if (!response.ok) {
          nextSource();
          return;
        }
        loadCurrent();
      })
      .catch(() => {
        nextSource();
      });
  } else {
    loadCurrent();
  }

  return { container, state };
}

/** Marker on a reference/block this enhancer consumed and hid. */
const HIDDEN = "data-hawk-media-hidden";

/**
 * Hide an element the enhancer consumed. `hidden` is the semantic attribute and
 * the marker is what the stylesheet keys on — the shell's markdown CSS sets its
 * own `display` on paragraphs and links, and an equal-specificity rule would
 * otherwise lose to it.
 *
 * @param node - element to hide.
 * @returns true when it was hidden.
 */
function hideElement(node) {
  if (node === null || node === undefined) return false;
  if (typeof node.setAttribute !== "function") return false;
  node.hidden = true;
  node.setAttribute("hidden", "");
  node.setAttribute(HIDDEN, "1");
  return true;
}

/**
 * @param node - element.
 * @returns true when this enhancer already hid it.
 */
function isConsumed(node) {
  if (node === null || node === undefined) return false;
  if (typeof node.getAttribute !== "function") return false;
  if (node.getAttribute(HIDDEN) !== null) return true;
  return node.hidden === true;
}

/**
 * @param node - node to classify.
 * @returns true when the node is nothing but whitespace or light punctuation.
 */
function isBlankTextNode(node) {
  if (node.nodeType !== 3) return false;
  // A text node's content is `nodeValue` (alias `value`), NOT `textContent` — in
  // the DOM `textContent` on a text node happens to look the same, but reading the
  // wrong field made every text node look blank, which is how a paragraph of prose
  // got classified as an empty shell. Strip the shell's leftover element-source
  // strings ("[object HTMLAnchorElement]") too: they are not readable content.
  const raw = node.nodeValue ?? node.value ?? node.textContent ?? "";
  return String(raw).replace(/\[object \w+\]/g, "").replace(/[\s\u00a0]+/g, "") === "";
}

/** Characters that may survive alone in a block once a reference is hidden. */
const LIGHT_PUNCTUATION = /^[\s\u00a0.,;:!?'"“”‘’`*_\-–—()\[\]{}<>/\\|~+=·•…@#&]+$/;

/**
 * @param node - node to classify.
 * @returns true when the node carries no visible content of its own.
 */
function isLightNode(node) {
  if (node === null || node === undefined) return true;
  if (node.nodeType === 3) return isBlankTextNode(node);
  if (isConsumed(node)) return true;
  const tag = String(node.tagName ?? "").toLowerCase();
  if (tag === "br" || tag === "wbr") return true;
  // A string that is still an element's source text (the shell leaves linkified
  // text nodes like "[object HTMLAnchorElement]" behind in some shapes) is not
  // readable content, so strip it before asking whether anything is left.
  const text = typeof node.textContent === "string" ? node.textContent.replace(/\[object \w+\]/g, "") : "";
  return LIGHT_PUNCTUATION.test(text);
}

/**
 * Whether a block should go with the reference it existed for.
 *
 * True when nothing in the block says anything on its own: every node is either
 * the reference being consumed right now, the player that replaced it, a node this
 * enhancer already consumed, or whitespace/punctuation. That covers a bare path on
 * its own line AND a paragraph whose only content was the link.
 *
 * Prose is never hidden. Any surviving word fails the punctuation test, so the
 * verdict request and the shot description stay exactly as the agent wrote them.
 *
 * @param block - the container to test.
 * @param consumed - the reference inside it that is being consumed right now.
 * @param player - the player element inserted in place of that reference.
 * @returns true when the block may be hidden.
 */
function isReferenceOnlyBlock(block, consumed, player) {
  if (block === null || block === undefined) return false;
  if (block === consumed || block === player) return false;
  // Our own player is CONTENT, never a leftover. A block that HOLDS the player we just built is not
  // reference-only, even when that player is the only thing left in it — because hiding such a block
  // hides our own output with it.
  //
  // This is the 2026-09-15 "I still see nothing" bug, measured in the live DOM: for an image (and for a
  // standalone audio line) createPlayer() inserts the frame INSIDE the paragraph it consumed, the block
  // then passed the test below — the player is skipped on purpose — so the paragraph was hidden and the
  // frame went with it. The reference vanished and nothing appeared: frameH 0 / frameW 0 while the image
  // itself had loaded fine (naturalWidth 1860, badge "streamed · 1860×1936 · 3.2 MB"). A video never hit
  // this because its player is inserted OUTSIDE the block.
  //
  // Walked rather than `block.contains(player)` so it holds in the fake DOM too, and in the same style as
  // insideSkippedContainer() above.
  let up = player;
  while (up !== null && up !== undefined) {
    if (up === block) return false;
    up = up.parentNode;
  }
  // Walk the block's OWN nodes, text nodes included. Counting only element
  // children is the trap: in "Here is the clip: <a>clip.mp4</a> — verdict?" the
  // paragraph's prose lives in its own text nodes, so an element-only count sees
  // nothing but the reference and hides a paragraph full of words.
  // childNodes is a live NodeList in a real browser, NEVER an Array — branching
  // on Array.isArray here left `nodes` empty, called every ancestor
  // "reference-only" and hid the whole page up to BODY (2026-09-15 black screen).
  const nodes = Array.from(block.childNodes ?? []);
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node === consumed || node === player) continue;
    if (isConsumed(node)) continue;
    if (isLightNode(node)) continue;
    // Anything left that says something keeps the block alive.
    return false;
  }
  return true;
}

/**
 * Hide a consumed reference, and its block when that block held nothing else.
 *
 * @param node - the reference element that was consumed.
 * @param player - the player element inserted in its place.
 * @returns the block that was hidden, or undefined.
 */
function hideConsumedReference(node, player) {
  // Decide the blocks BEFORE hiding the reference: a block test that ran after it
  // would see a consumed child and conclude the block was empty, which is exactly
  // how a paragraph of prose would get hidden.
  const blocks = [];
  let current = node.parentNode;
  while (current !== null && current !== undefined && current.nodeType === 1) {
    const parent = current.parentNode;
    if (parent === null || parent === undefined || parent.nodeType !== 1) break;
    const verdict = isReferenceOnlyBlock(current, node, player);
    if (!verdict) break;
    blocks.push(current);
    current = parent;
  }
  hideElement(node);
  for (const block of blocks) {
    hideElement(block);
  }
  return blocks[blocks.length - 1];
}

/**
 * Enhance one element iff it names media and has not been handled yet.
 *
 * @param node - anchor / code span / alt span from the scan.
 * @returns true when a player was created.
 */
function enhanceElement(node) {
  if (node === null || node === undefined) return false;
  if (typeof node.tagName !== "string") return false;
  if (insideSkippedContainer(node)) return false;
  if (node.getAttribute(ENHANCED) !== null) return false;
  const found = targetOfElement(node);
  if (found === undefined) return false;
  const { target, reference } = found;

  const parent = node.parentNode;
  if (parent === null) return false;

  const { container } = createPlayer(node, target, reference);
  // Video takes a full-width row: sit the player after the paragraph that carries
  // the path, not inside it. Audio is compact and stays inline.
  const after = target.kind === "video" ? parent : node;
  const holder = target.kind === "video" ? (parent.parentNode ?? parent) : parent;
  if (typeof holder.insertBefore !== "function") return false;
  const next = after.nextSibling;
  if (next === null) holder.appendChild(container);
  else holder.insertBefore(container, next);
  // Marked only after the player is really in the tree — an element marked
  // before a failed insert would never be retried by the observer.
  node.setAttribute(ENHANCED, "1");
  // The player is in place, so the reference it came from can go: it is the same
  // information twice, and the caption is now the link (2026-09-15).
  hideConsumedReference(node, container);
  return true;
}

/**
 * Scan a subtree and enhance every media reference in it.
 *
 * @param root - container node (usually `document.body`).
 * @returns the number of players created.
 */
export function enhance(root) {
  if (root === null || root === undefined) return 0;
  if (typeof root.querySelectorAll !== "function") return 0;
  let created = 0;
  const nodes = root.querySelectorAll(MEDIA_SELECTOR);
  for (const node of nodes) {
    try {
      if (enhanceElement(node)) created += 1;
    } catch {
      // One malformed node must never abort the whole scan.
    }
  }
  return created;
}

/**
 * Start the enhancer: one observer on the document, coalesced per animation
 * frame. Idempotent — a second call for the same document is ignored, which
 * matters because the client module can be reloaded by HMR.
 *
 * @returns a disposer that removes the observer.
 */
export function startEnhancer() {
  if (typeof document === "undefined" || document === null) return () => {};
  if (OBSERVING.has(document)) return () => {};
  const body = document.body;
  if (body === null || body === undefined) return () => {};
  if (typeof body.getAttribute !== "function" || typeof body.setAttribute !== "function") return () => {};
  OBSERVING.add(document);
  body.setAttribute("data-hawk-media-observing", "1");

  let queued = false;
  let restart = false;
  const run = () => {
    queued = false;
    const again = restart;
    restart = false;
    enhance(document.body);
    if (again) schedule();
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else if (typeof setTimeout === "function") setTimeout(run, 50);
    else run();
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type !== "childList") continue;
      // A removal can prune a message whose player is still in place: re-scan.
      if (record.removedNodes.length > 0) restart = true;
      if (record.addedNodes.length > 0) {
        for (const added of record.addedNodes) {
          if (added.nodeType === 1) {
            schedule();
            return;
          }
        }
      }
    }
  });
  observer.observe(body, { childList: true, subtree: true });

  schedule();
  return () => {
    observer.disconnect();
    OBSERVING.delete(document);
    body.removeAttribute?.("data-hawk-media-observing");
  };
}

/** Exposed for the test harness: the selector the scanner walks. */
export const __scanSelector = MEDIA_SELECTOR;
/** Exposed for the test harness: read the live state of an enhanced element. */
export const __stateOf = (node) => STATE.get(node);
