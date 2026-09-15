/**
 * hawk-media — constants that BOTH halves must agree on.
 *
 * The browser half builds the URL; the host half serves it. A drift here is a
 * 404 in the chat, so the list lives in one file and the test harness asserts
 * that both halves match.
 */

/** The route the host half mounts and the browser half streams from. */
export const MEDIA_ROUTE = "/api/hawk-media";

/** The built-in authenticated file route the chat already uses for images. */
export const API_FILE_ROUTE = "/api/file";

/** Video extensions. */
export const VIDEO_EXTENSIONS = [
  "mp4", "m4v", "webm", "mov", "ogv", "mkv", "mpg", "mpeg", "avi",
];

/** Audio extensions — the same frame, an `<audio>` element. */
export const AUDIO_EXTENSIONS = [
  "mp3", "m4a", "wav", "oga", "ogg", "opus", "flac", "aac",
];

/**
 * Image extensions — the third arm (2026-09-15): "resimlerinde video/müzik gibi çalışmasını
 * istiyorum … birebir aynı mantık olacak sadece player'a gerek yok."
 *
 * An image needs no controls, so this arm renders an `<img>` inside the SAME frame and keeps the SAME
 * bottom-left blue clickable caption. That caption is the whole point: the core renderer already turns
 * an absolute path into an image, but it leaves it without a label, so the reader cannot tell which
 * file they are looking at — and the agent stops having to copy files into ~/.dsh/screens to show one.
 */
export const IMAGE_EXTENSIONS = [
  "png", "jpg", "jpeg", "webp", "gif", "avif", "bmp",
];

/** Every extension either half understands. */
export const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...IMAGE_EXTENSIONS]
  .map((extension) => `.${extension}`);

/** Extension -> MIME type. A wrong type makes a browser refuse to play. */
export const MEDIA_TYPES = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mkv: "video/x-matroska",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
};

/** Host route MIME table: the same map, keyed by dotted extension. */
export const MEDIA_CONTENT_TYPES = Object.fromEntries(
  Object.entries(MEDIA_TYPES).map(([extension, type]) => [`.${extension}`, type]),
);

/** Default ceiling on the streaming route, so one absurd file cannot be pulled in a loop. */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** Chunk handed to `fs.createReadStream`. */
export const STREAM_CHUNK_BYTES = 1024 * 1024;
