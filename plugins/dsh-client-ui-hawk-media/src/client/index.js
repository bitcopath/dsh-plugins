/**
 * hawk-media — the browser half's module entry.
 *
 * ONE contribution now: THE IN-CHAT PLAYER (2026-09-15). A media reference in a
 * message — an absolute path written as inline code, a link, or a bare `http(s)`
 * URL — becomes a native player under that line, and the reference it consumed is
 * hidden so the reader sees one player with one clickable caption instead of three
 * copies of the same link. See ./chat-video.js.
 *
 * Applied as a plain document-level effect rather than a slot occupant: the slots
 * that could show media inside a message are SINGLE slots the shipped attachment
 * plugin already occupies, so registering would shadow the inline image gallery
 * instead of adding video beside it.
 *
 * THE SIDEBAR PREVIEW IS GONE (2026-09-15: *"Remove the right side bar video
 * plugin as well if it is duplicate and it will not be used so."*). Until this
 * change the module also registered a `documentPreviews` type for video/audio plus
 * a keyed body in the `sidebar.right.tab.document` slot, so any media path opened
 * from the Files tab played in the right sidebar. The chat is the delivery path
 * now, that pane was a second route to the same bytes, and a duplicate route is a
 * second thing to keep working. The whole sidebar arm is therefore removed —
 * `ctx.documentPreviews` is no longer touched and neither is that slot, and both
 * left the `inject` list, so nothing dangling is declared either.
 *
 * React is still taken from the shell's static module table (the bundle's factory
 * footer calls `createClient(require("react"))`) so the module keeps the same
 * load contract it had; it is simply unused until a UI piece needs it again.
 *
 * The host half (src/host.js) serves the bytes: `/api/hawk-media` streams with
 * `Range` support, because the built-in `/api/file` route refuses anything over
 * the 20 MiB image limit and has no range support at all.
 */

import { startEnhancer, injectCss, enhance } from "./chat-video.js";

/** Locale namespace contributed by this module. */
const NAMESPACE = "hawkMedia";

/**
 * Build the client plugin.
 *
 * @param react - the platform React module (unused today; kept so the bundle's
 *   `createClient(require("react"))` footer keeps working).
 * @returns the cordis plugin (apply plus the services it declares).
 */
export function createClient(react) {
  void react;

  /**
   * Mount the in-chat player.
   *
   * @param ctx - client root context carrying the locale service.
   */
  function apply(ctx) {
    ctx.effect(
      () =>
        ctx.locale.register(NAMESPACE, {
          en: { title: "Media player", loading: "Loading media…", failed: "This media could not be played.", unsupported: "Unsupported media file." },
          tr: { title: "Medya oynatıcı", loading: "Medya yükleniyor…", failed: "Bu medya oynatılamadı.", unsupported: "Desteklenmeyen medya dosyası." },
          zh: { title: "媒体播放器", loading: "正在加载媒体…", failed: "无法播放此媒体。", unsupported: "不支持的媒体文件。" },
        }),
      "hawk-media: dictionaries",
    );

    // The in-chat player: additive, document-level, no slot contract to shadow.
    ctx.effect(() => {
      injectCss();
      const stop = startEnhancer();
      // A quick way for the human to see whether the enhancer is alive at all:
      //   console:  __hawkMedia.count()   __hawkMedia.scan()
      if (typeof window !== "undefined") {
        /** Debug handle: `__hawkMedia.count()` / `.scan()` from the console. */
        const globals = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
        globals.__hawkMedia = {
          version: "2026-09-15",
          scan: () => enhance(document.body),
          count: () => document.body?.querySelectorAll("[data-hawk-media-player]").length ?? 0,
          stop,
        };
      }
      return stop;
    }, "hawk-media: in-chat player");
  }

  return { apply, inject: ["locale"] };
}
