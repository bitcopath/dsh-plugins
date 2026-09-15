/**
 * Host half of the hawk-media plugin.
 *
 * TWO JOBS
 *   1. (unchanged since 2026-09-14) exist as a valid cordis plugin so the bundle
 *      row mounts cleanly on the node side, while the browser half adds the
 *      Sidebar document-preview type for video/audio.
 *   2. (new, 2026-09-15) serve MEDIA BYTES to the browser half's in-chat player.
 *
 * `name` stays exactly as it was ("dsh-client-ui-hawk-media", the package
 * specifier the loader resolves) — only `apply` grew.
 *
 * WHY A ROUTE IS REQUIRED — measured in the installed packages, not guessed
 *   The chat's built-in inline-image mechanism resolves an absolute path to
 *   `GET /api/file?path=…` (compiled at
 *   node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js:2961,
 *   `localPathMediaUrl`; source packages/client/ui-chat/src/client/chat/AssistantMarkdown.ts).
 *   That route is registered by `dsh-api-session-controller`
 *   (lib/index.js:2369-2374) with
 *   `maxBytes = ctx.attachments.imageLimits.maxImageBytes`, which resolves to
 *   `DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024`
 *   (dsh-attachment-local/lib/index.js:888; nothing in ~/.dsh/settings.yaml or
 *   ~/.dsh/profiles/web overrides it). The handler then calls
 *   `fs.readBytes(target, signal, maxBytes)` and returns the whole buffer as one
 *   `Response` — so a file over 20 MiB is a 413, and even an allowed file is
 *   fully buffered with NO `Range` support (no seeking, whole file in memory
 *   before the first frame).
 *
 *   Real clips from a rendering pipeline run 4-90 MB, so /api/file cannot play most
 *   of them and never plays one well.
 *   Hence the route below: streamed, `Range`-capable, HEAD-probeable, and
 *   independent of the image attachment limit.
 *
 * ROUTES (authenticated by the same connection check the built-in /api routes
 * use, through `connection.requestRejection`)
 *   HEAD /api/hawk-media?path=<abs path>   -> 200 + content-length/type, or 4xx
 *   GET  /api/hawk-media?path=<abs path>   -> 200 streamed (accept-ranges: bytes)
 *   GET  /api/hawk-media?path=<abs path>   -> 206 partial when `Range: bytes=…`
 *
 * Only allowlisted media extensions are served, the path must be absolute and
 * free of NUL bytes — this is not a general file-disclosure route.
 *
 * NOTE: the host half is a SERVER-side change: the running `dsh web` process must
 * be restarted before this route exists (the operator's call). Until then the browser half
 * degrades to /api/file and keeps working for clips under 20 MiB. A change to the
 * client half alone needs only a page refresh.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  MEDIA_CONTENT_TYPES,
  MEDIA_EXTENSIONS,
  MEDIA_ROUTE,
  STREAM_CHUNK_BYTES,
} from "./shared.js";

/** Cordis plugin name — unchanged; only `apply` grew. */
export const name = "dsh-client-ui-hawk-media";

/** Required services: the browser HTTP carrier and the connection authenticator. */
export const inject = ["webServer", "connection"];

/**
 * @param filePath - candidate path.
 * @returns the lowercased extension with its dot, or "".
 */
function extensionOf(filePath) {
  if (typeof filePath !== "string") return "";
  const clean = filePath.split("?")[0].split("#")[0];
  return extname(clean).toLowerCase();
}

/**
 * Parse one `Range: bytes=start-end` header against a known size.
 * Handles the three real forms (`a-b`, `a-`, `-n`) and rejects what cannot be
 * satisfied — an unsatisfiable range gets a 416, never a silent full body.
 *
 * @param header - the raw header value, or null.
 * @param size - total file size in bytes.
 * @returns `{ start, end }` inclusive byte offsets, `"unsatisfiable"`, or undefined (no range asked).
 */
export function parseRange(header, size) {
  if (typeof header !== "string" || header.length === 0) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return undefined;
  let start;
  let end;
  if (rawStart === "") {
    // Suffix form: the last N bytes.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "unsatisfiable";
  if (start > end || start >= size) return "unsatisfiable";
  return { start, end: Math.min(end, size - 1) };
}

/**
 * @param res - node response.
 * @param status - HTTP status code.
 * @param text - plain-text body.
 */
function sendText(res, status, text) {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(text);
}

/**
 * Build the route handler.
 *
 * @param ctx - host plugin context carrying `connection`.
 * @param maxBytes - resolved size ceiling.
 * @returns an (req, res) handler owned by `webServer.register`.
 */
export function createMediaHandler(ctx, maxBytes = DEFAULT_MAX_BYTES) {
  return async function handleMediaRequest(req, res) {
    // The same authorization the built-in /api routes apply. A rejection is final.
    const rejection = ctx.connection?.requestRejection?.(req);
    if (rejection !== undefined) {
      sendText(res, rejection, rejection === 401 ? "unauthorized" : "forbidden");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("allow", "GET, HEAD");
      res.end();
      return;
    }

    const url = new URL(String(req.url ?? "/"), "http://dsh.invalid");
    const requested = url.searchParams.get("path");
    if (requested === null || requested.length === 0) {
      sendText(res, 400, "missing path");
      return;
    }
    if (requested.includes("\0") || !isAbsolute(requested)) {
      sendText(res, 400, "absolute path required");
      return;
    }
    const extension = extensionOf(requested);
    if (!MEDIA_EXTENSIONS.includes(extension)) {
      sendText(res, 415, "not a media file");
      return;
    }

    let info;
    try {
      info = await stat(requested);
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error)?.code;
      sendText(res, code === "ENOENT" ? 404 : 403, code ?? "stat failed");
      return;
    }
    if (!info.isFile()) {
      sendText(res, 403, "not a regular file");
      return;
    }
    if (info.size > maxBytes) {
      sendText(res, 413, "file exceeds byte limit");
      return;
    }

    const contentType = MEDIA_CONTENT_TYPES[extension] ?? "application/octet-stream";
    // `private`: the browser caching these bytes is fine, a shared cache is not.
    const baseHeaders = {
      "content-type": contentType,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    };

    const range = parseRange(req.headers?.range, info.size);
    if (range === "unsatisfiable") {
      res.writeHead(416, { ...baseHeaders, "content-range": `bytes */${info.size}` });
      res.end();
      return;
    }

    const start = range === undefined ? 0 : range.start;
    const end = range === undefined ? info.size - 1 : range.end;
    const length = info.size === 0 ? 0 : end - start + 1;

    res.writeHead(range === undefined ? 200 : 206, {
      ...baseHeaders,
      "content-length": String(length),
      ...(range === undefined ? {} : { "content-range": `bytes ${start}-${end}/${info.size}` }),
    });

    if (req.method === "HEAD" || length === 0) {
      res.end();
      return;
    }

    const stream = createReadStream(requested, {
      start,
      end,
      highWaterMark: STREAM_CHUNK_BYTES,
    });
    const close = () => {
      stream.destroy();
    };
    // A closed socket (tab closed, a new seek) must not leave the read running.
    res.on("close", close);
    stream.on("error", () => {
      res.destroy();
    });
    stream.on("end", () => {
      res.off("close", close);
    });
    stream.pipe(res);
  };
}

/**
 * Mount the streaming route.
 *
 * @param ctx - host plugin context carrying the web carrier.
 */
export function apply(ctx) {
  /** Register the route in whichever web context we were handed. */
  const mount = (webCtx) => {
    const handler = createMediaHandler(webCtx);
    webCtx.effect(
      () => webCtx.webServer.register({ kind: "prefix", path: MEDIA_ROUTE, handler }),
      "hawk-media: streamed media route",
    );
  };
  // Declaration-aware, with a direct fallback: without the web carrier there is
  // nothing to mount, and the browser half keeps working through /api/file for
  // small clips either way. `inject(["webServer", …])` at the plugin level means
  // this normally runs with the service already present.
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], mount);
    return;
  }
  if (ctx.webServer !== undefined) mount(ctx);
}
