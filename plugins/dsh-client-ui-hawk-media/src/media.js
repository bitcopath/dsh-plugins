/**
 * hawk-media — pure helpers shared by the in-chat player and the test harness.
 *
 * Nothing here touches the DOM, React, or the network, so `test/chat-video.test.mjs`
 * can exercise every rule under plain Node.
 *
 * The rules exist because the chat markdown renderer gives NO media treatment to
 * anything but images: the only URL a message body can produce is a link
 * (`/api/file?path=…` for images — see client.js line 2961), and a `<video>` tag
 * authored in markdown is dropped, since the markdown pipeline has no raw-HTML
 * step. So the player is driven by the *text* of a link, an inline-code path, or
 * a failed-image alt span — which is exactly what an agent writes when it names a
 * rendered file.
 */

import {
  API_FILE_ROUTE,
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  MEDIA_ROUTE,
  MEDIA_TYPES,
  VIDEO_EXTENSIONS,
} from "./shared.js";

export {
  API_FILE_ROUTE,
  AUDIO_EXTENSIONS,
  IMAGE_EXTENSIONS,
  MEDIA_EXTENSIONS,
  MEDIA_ROUTE,
  MEDIA_TYPES,
  VIDEO_EXTENSIONS,
};

/**
 * @param value - any path-ish string, including a full URL.
 * @returns the lowercased extension without its dot, or "".
 */
export function extensionOf(value) {
  if (typeof value !== "string") return "";
  let candidate = value;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      // The chat's own media link carries the real path in `?path=`; a plain URL
      // carries it in the pathname. The host's dots (127.0.0.1:3081) must never
      // be read as an extension, so neither branch looks at the authority.
      candidate = parsed.searchParams.get("path") ?? parsed.pathname;
    } catch {
      const afterAuthority = candidate.slice(candidate.indexOf("//") + 2);
      candidate = afterAuthority.slice(afterAuthority.indexOf("/") + 1);
    }
  }
  const clean = candidate.split("?")[0].split("#")[0];
  const dot = clean.lastIndexOf(".");
  if (dot < 0) return "";
  return clean.slice(dot + 1).toLowerCase();
}

/**
 * @param extension - extension with or without its dot.
 * @returns "video" | "audio" | undefined.
 */
export function kindOfExtension(extension) {
  if (typeof extension !== "string" || extension.length === 0) return undefined;
  const clean = extension.startsWith(".") ? extension.slice(1) : extension;
  if (VIDEO_EXTENSIONS.includes(clean)) return "video";
  if (AUDIO_EXTENSIONS.includes(clean)) return "audio";
  if (IMAGE_EXTENSIONS.includes(clean)) return "image";
  return undefined;
}

const URL_PREFIX = /^https?:\/\//i;
const FILE_URL_PREFIX = /^file:\/\//i;
/**
 * Characters that mean the candidate is prose, code, or a template, not a bare
 * path. `?` is deliberately absent: the chat's own image URLs
 * (`/api/file?path=…`) are handled by the http branch above, and a bare
 * filesystem path never legitimately carries one.
 */
const REJECTED = /[\s<>"'`()\[\]{}|\\^*,;=]/;

/**
 * Extract the media target out of whatever the message rendered.
 *
 * Accepts, in this order:
 *   1. an `http(s)://…/clip.mp4` URL (used verbatim — a real server URL),
 *   2. a `file:///abs/clip.mp4` URL (converted to its path),
 *   3. an absolute POSIX path `/abs/clip.mp4` (the shape the agent normally writes),
 *   4. a `~/clip.mp4` home path, resolved once a home directory is known.
 *
 * Returns undefined for relative paths on purpose: the host route requires an
 * absolute path, and guessing a workspace root would silently play the wrong
 * file. A relative guess is not a feature.
 *
 * @param {string} raw - link href, element text, or any candidate string.
 * @param {string} [home] - absolute home directory, used to expand `~/`.
 * @returns `{ extension, kind, path, url }` or undefined.
 */
export function mediaFromText(raw, home) {
  if (typeof raw !== "string") return undefined;
  let text = raw.trim();
  if (text.length === 0) return undefined;
  // Strip a markdown-ish wrapper and any surrounding quotes/backticks.
  text = text.replace(/^`+|`+$/g, "").replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");

  let url;
  let path;
  let extension;

  if (URL_PREFIX.test(text)) {
    // A real URL. The pathname decides the extension (a `?query#fragment` tail
    // must not hide it), and the URL is used verbatim up to that extension — so
    // the chat's own authenticated `/api/file?path=…` link keeps its query.
    extension = extensionOf(text);
    if (kindOfExtension(extension) === undefined) return undefined;
    const cut = text.toLowerCase().indexOf("." + extension);
    url = text.slice(0, cut + extension.length + 1);
    path = undefined;
  } else if (FILE_URL_PREFIX.test(text)) {
    extension = extensionOf(text);
    if (kindOfExtension(extension) === undefined) return undefined;
    try {
      path = decodeURIComponent(new URL(text).pathname);
    } catch {
      return undefined;
    }
    if (path.length === 0) return undefined;
  } else {
    if (REJECTED.test(text)) return undefined;
    if (text.startsWith("~/")) {
      if (typeof home !== "string" || home.length === 0) return undefined;
      text = home.replace(/\/+$/, "") + text.slice(1);
    }
    if (!text.startsWith("/")) return undefined;
    extension = extensionOf(text);
    if (kindOfExtension(extension) === undefined) return undefined;
    path = text;
  }

  const kind = kindOfExtension(extension);
  return { extension, kind, path, url };
}

/**
 * Build the candidate source list, best first.
 *
 * The host route is first: streamed, Range-capable, no image byte cap. `/api/file`
 * is the fallback for the window before `dsh web` is restarted (the route only
 * exists after a server restart) and for small clips if the route 404s.
 *
 * @param target - a `mediaFromText` result.
 * @param origin - `window.location.origin` at render time; without a usable
 *   origin only an absolute `http(s)` URL can be played.
 * @returns ordered `{ url, label }` candidates (may be empty).
 */
export function buildSources(target, origin) {
  const sources = [];
  if (target === undefined) return sources;
  if (typeof target.url === "string") {
    sources.push({ url: target.url, label: "url" });
    return sources;
  }
  if (typeof target.path !== "string") return sources;
  if (typeof origin !== "string" || !URL_PREFIX.test(origin)) return sources;
  const encoded = encodeURIComponent(target.path);
  sources.push({ url: `${origin}${MEDIA_ROUTE}?path=${encoded}`, label: "stream" });
  sources.push({ url: `${origin}${API_FILE_ROUTE}?path=${encoded}`, label: "api-file" });
  return sources;
}

/**
 * @param seconds - media duration in seconds.
 * @returns `m:ss` (or `h:mm:ss` for long recordings), or "" when unknown.
 */
export function clock(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

/** @param path - a path. @returns its basename. */
export function basenameOf(path) {
  if (typeof path !== "string" || path.length === 0) return "";
  const clean = path.split("?")[0].split("#")[0].replace(/\/+$/, "");
  return clean.slice(clean.lastIndexOf("/") + 1);
}

/** @param bytes - a byte count. @returns a short human size. */
export function sizeText(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
