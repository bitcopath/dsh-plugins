/**
 * hawk-hq browser half styling: one hand-rolled stylesheet (zero runtime
 * dependencies, no chart libs) injected as a single <style> tag at module
 * factory execution, deduped by data-plugin-css. Colors track the shell's
 * dark theme through its --dsw-* CSS variables.
 */

export const CSS_TEXT = `
.hhq-page { box-sizing: border-box; display: flex; flex-direction: column; gap: 14px; width: 100%; min-width: 0; font-family: inherit; }
.hhq-page *, .hhq-page *::before, .hhq-page *::after { box-sizing: border-box; }
.hhq-page h3 { margin: 0; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary, #b8bcc8); letter-spacing: .02em; }
.hhq-dim { color: var(--dsw-alias-label-tertiary, #8a8f9e); font-size: 12px; }
.hhq-error { color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 12px; }
.hhq-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
.hhq-card { border: 1px solid var(--dsw-alias-border-l1, #2e3240); background: var(--dsw-specific-tip, #161922); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.hhq-card-title { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-caption, #8a8f9e); letter-spacing: .05em; text-transform: uppercase; }
.hhq-card-label { color: inherit; }
.hhq-card-link { color: var(--dsw-alias-primary, #7fade0); text-decoration: none; display: inline-flex; align-items: center; line-height: 0; }
.hhq-card-link .hhq-link-svg { display: block; }
.hhq-card-link:hover { color: var(--dsw-alias-state-info-primary, #7fade0); }
.hhq-card-link:focus-visible { outline: 1px solid currentColor; border-radius: 2px; }
.hhq-card-value { font-size: 20px; font-weight: 650; color: var(--dsw-alias-label-primary, #e6e8ee); font-variant-numeric: tabular-nums; line-height: 1.15; }
.hhq-card-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f9e); font-variant-numeric: tabular-nums; }
.hhq-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 12px; font-variant-numeric: tabular-nums; }
.hhq-row .hhq-k { color: var(--dsw-alias-label-tertiary, #8a8f9e); }
.hhq-row .hhq-v { color: var(--dsw-alias-label-primary, #e6e8ee); text-align: right; }
.hhq-bar { height: 6px; border-radius: 3px; background: var(--dsw-alias-interactive-bg-hover, #232838); overflow: hidden; }
.hhq-bar-fill { height: 100%; border-radius: 3px; background: #4f8ef7; transition: width .4s ease; }
.hhq-bar-fill.hhq-warn { background: #d9a13b; }
.hhq-bar-fill.hhq-crit { background: var(--dsw-alias-state-error-primary, #e5534b); }
.hhq-badge { display: inline-block; padding: 1px 7px; border-radius: 8px; font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; line-height: 16px; }
.hhq-badge-high { background: rgba(229, 83, 75, .16); color: #f08080; }
.hhq-badge-medium { background: rgba(217, 161, 59, .16); color: #e0b45c; }
.hhq-badge-low, .hhq-badge-info { background: rgba(79, 142, 247, .14); color: #7fade0; }
.hhq-badge-ok { background: rgba(87, 171, 90, .16); color: #7cc47f; }
.hhq-log { margin: 0; padding: 10px 12px; max-height: 260px; overflow: auto; border: 1px solid var(--dsw-alias-border-l1, #2e3240); border-radius: 10px; background: var(--dsw-specific-tip, #12151d); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.55; color: var(--dsw-alias-label-primary-dimmed, #aab0bf); white-space: pre-wrap; word-break: break-all; }
.hhq-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.hhq-item { border: 1px solid var(--dsw-alias-border-l1, #2e3240); background: var(--dsw-specific-tip, #161922); border-radius: 10px; padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; }
.hhq-item-head { display: flex; align-items: center; gap: 8px; }
.hhq-item-ts { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f9e); font-variant-numeric: tabular-nums; white-space: nowrap; }
.hhq-item-msg { font-size: 12.5px; color: var(--dsw-alias-label-primary, #e6e8ee); line-height: 1.45; word-break: break-word; }
.hhq-panel { border: 1px solid var(--dsw-alias-border-l1, #2e3240); background: var(--dsw-specific-tip, #161922); border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.hhq-conn { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8a8f9e); }
.hhq-conn.hhq-live { color: #7cc47f; }
.hhq-btn { cursor: pointer; background: transparent; border: 1px solid var(--dsw-alias-border-l1, #2e3240); color: var(--dsw-alias-label-secondary, #b8bcc8); border-radius: 6px; font-size: 11px; height: 22px; padding: 0 10px; }
.hhq-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #232838); }
.hhq-headrow { display: flex; align-items: center; gap: 10px; }
.hhq-headrow h3 { flex: 1; }
.hhq-chart { width: 100%; height: auto; display: block; }
/* Sidebar foot widget (sidebar.footer.action) */
.hhq-side { box-sizing: border-box; width: 100%; min-width: 0; display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--dsw-alias-border-l1, #2e3240); background: var(--dsw-specific-tip, #161922); border-radius: 10px; padding: 8px 10px; margin: 0 0 8px; font-size: 12px; font-variant-numeric: tabular-nums; }
.hhq-side-head { display: flex; align-items: center; gap: 8px; }
.hhq-side-label { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-caption, #8a8f9e); letter-spacing: .05em; }
.hhq-side-temp { font-size: 15px; font-weight: 650; color: var(--dsw-alias-label-primary, #e6e8ee); }
.hhq-side-temp.hhq-side-warn { color: #d9a13b; }
.hhq-side-temp.hhq-side-crit { color: var(--dsw-alias-state-error-primary, #e5534b); }
.hhq-side-model { flex: 1; min-width: 0; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #b8bcc8); font-size: 11px; }
.hhq-side-model.hhq-side-dim { color: var(--dsw-alias-label-tertiary, #8a8f9e); }
.hhq-side-meta { display: flex; justify-content: space-between; gap: 8px; color: var(--dsw-alias-label-tertiary, #8a8f9e); font-size: 11px; white-space: nowrap; }
.hhq-side-dim { color: var(--dsw-alias-label-tertiary, #8a8f9e); font-size: 11px; }
.hhq-side .hhq-bar-fill.hhq-side-warn { background: #d9a13b; }
.hhq-side .hhq-bar-fill.hhq-side-crit { background: var(--dsw-alias-state-error-primary, #e5534b); }
.hhq-side-dot { width: 10px; height: 10px; border-radius: 50%; background: #57ab5a; display: inline-block; }
.hhq-side-dot.hhq-side-warn { background: #d9a13b; }
.hhq-side-dot.hhq-side-crit { background: var(--dsw-alias-state-error-primary, #e5534b); }
.hhq-quota-warn { color: #d9a13b !important; }
.hhq-quota-crit { color: var(--dsw-alias-state-error-primary, #e5534b) !important; }
/* DSH shell overrides (out-of-tree customization):
   - User speech bubbles span the full chat width instead of the default
     min(chat-width * .702, 82%) right-aligned pill, and the composer card
     widens with them (kept on purpose).
   Re-pointed for 0.1.5 on 2026-09-13: the conversation CSS-module prefix
   changed from gdEzaW_ to Sixlwa_ — the user turn moved into the new
   dsh-client-ui-chat package. Two mechanisms, on purpose:
   1. the variable hook: 0.1.5 computes its chat width from
      --dsh-chat-user-width (upstream's own fallback seam), so setting it here
      survives class-hash churn;
   2. the class override, needed because the 82% cap is hard-coded in the rule
      and only a class-level max-width can beat it. This one IS hash-fragile:
      scripts/verify.sh checks that the target prefix still exists in the served
      bundle, so a future rename fails loudly instead of silently.
   !important is deliberate, not laziness: this stylesheet is injected when our
   client module factory runs, which is BEFORE the shell injects its own module
   CSS — so at equal specificity the shell always wins. Measured 2026-09-13: an
   equally-specific rule left the brand row at its 60px default. */
:root { --dsh-chat-user-width: 100%; }
.Sixlwa_userRow { width: 100% !important; }
.Sixlwa_userStack { width: 100% !important; max-width: 100% !important; }
/* Sidebar harness-version badge — the sidebar.version seat above New
   Session (grown by scripts/apply-dsh-ui-fixes.sh). Green = this install is
   the newest published version; bold red = a newer version is published;
   neutral grey = the check is pending or failed (never a green lie). */
.hhq-ver { box-sizing: border-box; display: flex; align-items: center; gap: 5px; margin: 2px 2px 2px; padding: 0 4px; min-height: 16px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 16px; letter-spacing: .02em; white-space: nowrap; overflow: hidden; cursor: default; }
/* Sidebar head spacing: the
   expanded brand row is 60px tall with the wordmark centred, which left ~18px of
   dead space under it that read as a gap between the brand and the version line.
   Trimmed here instead of in the seat patch, so the sidebar geometry stays in one
   place. Hash-fragile like the bubble override — scripts/verify.sh fails loudly
   if hHd-Xa_logoRow ever disappears.
   The :not(.hHd-Xa_collapsed) guard and !important are both load-bearing: our
   stylesheet is injected before the shell's, and the shell's collapsed-rail rule
   is equally specific, so a plain rule did nothing (measured 2026-09-13) and an
   unguarded !important would have deformed the 56px rail. */
.hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_logoRow { height: 42px !important; margin-bottom: 2px !important; padding: 6px 0 0 4px !important; }
.hhq-ver-label { color: var(--dsw-alias-label-tertiary, #8a8f9e); font-size: 9px; font-weight: 700; letter-spacing: .1em; }
.hhq-ver-current { color: var(--dsw-alias-label-primary, #e6e8ee); font-variant-numeric: tabular-nums; }
.hhq-ver-current.hhq-ver-ok { color: #7cc47f; }
.hhq-ver-current.hhq-ver-unknown { color: var(--dsw-alias-label-tertiary, #8a8f9e); font-weight: 500; }
.hhq-ver-arrow { color: var(--dsw-alias-label-tertiary, #8a8f9e); }
.hhq-ver-new { color: #e5534b; font-weight: 800; font-variant-numeric: tabular-nums; }
/* Composer skills dropdown (conversation.input.left). Hand-rolled on purpose:
   the 2026-09-07 hand patch leaned on the conversation bundle's own CSS-module
   class names, and those hashes change between releases. Everything here is
   our own class, themed through the shell's --dsw-* variables. */
.hhq-sk { position: relative; display: inline-flex; align-items: center; }
.hhq-sk-trigger { box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px 0 6px; border: 1px solid transparent; border-radius: 12px; background: transparent; color: var(--dsw-alias-label-secondary, #b8bcc8); font-family: inherit; font-size: 12px; line-height: 22px; white-space: nowrap; }
.hhq-sk-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, #232838); color: var(--dsw-alias-label-primary, #e6e8ee); }
.hhq-sk-trigger-open { background: var(--dsw-alias-interactive-bg-hover, #232838); color: var(--dsw-alias-label-primary, #e6e8ee); border-color: var(--dsw-alias-border-l2, #2e3240); }
.hhq-sk-trigger:disabled { opacity: .5; cursor: default; }
.hhq-sk-bolt { font-size: 12px; line-height: 1; }
.hhq-sk-label { font-weight: 500; }
.hhq-sk-chevron { font-size: 9px; opacity: .7; }
.hhq-sk-menu { position: fixed; z-index: 9000; min-width: 300px; max-width: min(460px, calc(100vw - 24px)); max-height: 320px; overflow-y: auto; padding: 6px; border: 1px solid var(--dsw-alias-border-l1, #2e3240); border-radius: 12px; background: var(--dsw-specific-input-major, #161922); box-shadow: var(--dsw-shadow-lv2, 0 10px 30px rgba(0,0,0,.45)); display: flex; flex-direction: column; gap: 2px; }
.hhq-sk-item { cursor: pointer; display: flex; flex-direction: column; gap: 1px; width: 100%; text-align: left; padding: 6px 9px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary, #e6e8ee); font-family: inherit; font-size: 12.5px; line-height: 17px; }
.hhq-sk-item:hover { background: var(--dsw-alias-interactive-bg-hover, #232838); }
.hhq-sk-item-name { font-weight: 500; }
.hhq-sk-item-prompt { color: var(--dsw-alias-label-tertiary, #8a8f9e); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hhq-sk-item-manage { color: var(--dsw-alias-label-secondary, #b8bcc8); font-weight: 500; }
.hhq-sk-sep { height: 1px; margin: 3px 6px; background: var(--dsw-alias-border-l1, #2e3240); }
.hhq-sk-empty { padding: 8px 9px; color: var(--dsw-alias-label-tertiary, #8a8f9e); font-size: 12px; }
.hhq-sk-overlay { position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,.45); }
.hhq-sk-modal { position: fixed; z-index: 10000; left: 50%; top: 50%; transform: translate(-50%,-50%); box-sizing: border-box; width: min(520px, calc(100% - 32px)); padding: 16px; border: 1px solid var(--dsw-alias-border-l2, #2e3240); border-radius: 14px; background: var(--dsw-specific-input-major, #161922); color: var(--dsw-alias-label-primary, #e6e8ee); box-shadow: var(--dsw-shadow-lv2, 0 20px 60px rgba(0,0,0,.5)); font-family: inherit; }
.hhq-sk-modal-title { font-size: 15px; font-weight: 600; line-height: 22px; margin-bottom: 6px; }
.hhq-sk-modal-hint { color: var(--dsw-alias-label-tertiary, #8a8f9e); font-size: 12px; line-height: 18px; margin-bottom: 10px; }
.hhq-sk-textarea { box-sizing: border-box; width: 100%; min-height: 180px; resize: vertical; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l2, #2e3240); border-radius: 8px; background: var(--dsw-alias-bg-base, #0f1116); color: var(--dsw-alias-label-primary, #e6e8ee); outline: none; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; line-height: 19px; }
.hhq-sk-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.hhq-sk-btn { cursor: pointer; border: none; border-radius: 8px; padding: 6px 16px; font-family: inherit; font-size: 13px; font-weight: 500; line-height: 20px; color: var(--dsw-alias-label-secondary, #b8bcc8); background: var(--dsw-alias-interactive-bg-hover, #232838); }
.hhq-sk-btn:hover { color: var(--dsw-alias-label-primary, #e6e8ee); }
.hhq-sk-btn-primary { color: #fff; background: var(--dsw-alias-button-info-fill, #4f8ef7); }
.hhq-sk-btn-primary:hover { color: #fff; filter: brightness(1.08); }
/* ComfyUI sidebar panel — stacked above the GPU readout inside the same
   sidebar.footer.action occupant. Rendered only while the engine is up and
   something is resident, so an idle machine shows none of these rules. */
.hhq-comfy {
  margin-bottom: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
}
.hhq-comfy-models {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 4px 0 2px;
}
.hhq-comfy-chip {
  font-size: 10px;
  line-height: 1.5;
  padding: 1px 6px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
  color: var(--dsw-alias-text-secondary, #b8bcc2);
  white-space: nowrap;
}
.hhq-chip-video { border-color: #7c5cff; color: #c3b4ff; }
.hhq-chip-image { border-color: #2f9e6b; color: #9ee0c0; }
.hhq-chip-audio { border-color: #c98a1f; color: #f0d091; }
.hhq-chip-text  { border-color: #4a7fb5; color: #a9cbea; }
.hhq-chip-vae   { border-color: #6b7076; color: #b8bcc2; }
.hhq-comfy-wf {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
  opacity: .7;
}

/* ── Hawk Radio: compact rail card + its modal ──────────────────────────────
   The rail card is deliberately two rows: the owner's rule is that the sidebar
   keeps the smallest thing that is still a radio, and everything else lives in
   the modal behind the gear. */
.hhq-side-collapsed { display: inline-flex; align-items: center; gap: 6px; }
.hhq-radio { gap: 4px; }
.hhq-radio-dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  font-size: 11px;
  color: var(--dsw-alias-text-tertiary, #8b9099);
}
.hhq-radio-dot-on { color: #6fd08c; }
.hhq-radio-top { display: flex; align-items: center; gap: 8px; }
.hhq-radio-play {
  flex: 0 0 28px;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
  background: var(--dsw-alias-bg-secondary, #23262c);
  color: var(--dsw-alias-text-primary, #e6e8ea);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}
.hhq-radio-play-on { background: #1f3a57; border-color: #2f5a83; color: #cfe6ff; }
.hhq-radio-tower {
  flex: 0 0 30px;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  border: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
  background: var(--dsw-alias-bg-secondary, #23262c);
  color: var(--dsw-alias-text-tertiary, #8b9099);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  filter: grayscale(1) opacity(.65);
}
.hhq-radio-tower-on {
  filter: none;
  border-color: #3d8a63;
  background: #16301f;
  box-shadow: 0 0 0 0 rgba(111, 208, 140, .45);
  animation: hhq-onair 2s ease-out infinite;
}
@keyframes hhq-onair {
  0%   { box-shadow: 0 0 0 0 rgba(111, 208, 140, .45); }
  70%  { box-shadow: 0 0 0 8px rgba(111, 208, 140, 0); }
  100% { box-shadow: 0 0 0 0 rgba(111, 208, 140, 0); }
}
.hhq-radio-tower-locked {
  cursor: not-allowed;
  filter: grayscale(1) opacity(.5);
  animation: none;
  font-size: 12px;
}
.hhq-radio-share { margin-top: 12px; padding-top: 10px; border-top: 1px dashed #2c313a; }
.hhq-radio-share-input {
  width: 100%;
  margin: 6px 0 8px;
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
  background: var(--dsw-specific-input-major, #161922);
  color: #9cc7ff;
  font-size: 11.5px;
}
.hhq-radio-title { flex: 1; min-width: 0; }
.hhq-radio-title b {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hhq-radio-title span {
  display: block;
  font-size: 10px;
  color: var(--dsw-alias-text-tertiary, #8b9099);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hhq-radio-gear {
  flex: 0 0 22px;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
  background: transparent;
  color: var(--dsw-alias-text-tertiary, #8b9099);
  font-size: 11px;
  cursor: pointer;
}
.hhq-radio-gear:hover { color: var(--dsw-alias-text-primary, #e6e8ea); }
.hhq-radio-bar {
  height: 4px;
  border-radius: 99px;
  background: var(--dsw-alias-bg-secondary, #2c313a);
  overflow: hidden;
}
.hhq-radio-bar > i { display: block; height: 100%; background: #4a9eff; }
.hhq-radio-bar-lg { height: 8px; }
.hhq-radio-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 10px;
  color: var(--dsw-alias-text-tertiary, #8b9099);
}
.hhq-radio-ok { color: #6fd08c; }
.hhq-radio-down { color: #e2914a; }
.hhq-radio-busy { color: #9cc7ff; }
.hhq-radio-stars-mini { color: #f5b942; letter-spacing: 1px; }
.hhq-radio-error {
  font-size: 10px;
  color: #ff9aa2;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* the modal */
.hhq-radio-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, .5);
  display: flex;
  align-items: center;
  justify-content: center;
}
.hhq-radio-modal {
  /* Owner, 2026-09-17: the first version was cramped -- a modal has the whole viewport to use,
     so it takes most of it and gives the two columns room to breathe. */
  width: min(1180px, calc(100vw - 40px));
  min-height: min(660px, calc(100vh - 72px));
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  border: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
  border-radius: 14px;
  background: var(--dsw-alias-bg-primary, #16181d);
  color: var(--dsw-alias-text-primary, #e6e8ea);
  box-shadow: 0 24px 70px rgba(0, 0, 0, .6);
}
.hhq-radio-modal-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
}
.hhq-radio-brand { font-size: 11px; letter-spacing: .14em; color: var(--dsw-alias-text-tertiary, #8b9099); }
.hhq-radio-x {
  margin-left: auto;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
  background: transparent;
  color: var(--dsw-alias-text-tertiary, #8b9099);
  cursor: pointer;
}
.hhq-radio-models {
  display: flex;
  gap: 10px;
  padding: 12px 14px 0;
}
.hhq-radio-models .hhq-radio-sel { flex: 1; }
.hhq-radio-grid { display: flex; gap: 22px; padding: 18px; }
.hhq-radio-col { flex: 1.15; min-width: 0; }
.hhq-radio-col-right { flex: 1; border-left: 1px solid var(--dsw-alias-border-secondary, #3a3f45); padding-left: 16px; }
.hhq-radio-now { font-size: 26px; font-weight: 700; line-height: 1.15; }
.hhq-radio-sub { font-size: 11.5px; color: var(--dsw-alias-text-tertiary, #8b9099); margin-top: 3px; }
.hhq-radio-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; }
.hhq-radio-tag, .hhq-radio-tag-st {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
  color: var(--dsw-alias-text-secondary, #b8bcc2);
}
.hhq-radio-tag-st { border-color: #5b4bb5; color: #c4b5fd; }
.hhq-radio-times {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--dsw-alias-text-tertiary, #8b9099);
  margin-top: 4px;
}
.hhq-radio-transport { display: flex; gap: 8px; margin-top: 16px; }
.hhq-radio-btn {
  flex: 1;
  padding: 11px 0;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
  background: var(--dsw-alias-bg-secondary, #23262c);
  color: var(--dsw-alias-text-primary, #e6e8ea);
  font-size: 13px;
  cursor: pointer;
}
.hhq-radio-btn:disabled { opacity: .45; cursor: default; }
.hhq-radio-btn-play { flex: 2; background: #1f3a57; border-color: #2f5a83; color: #cfe6ff; }
.hhq-radio-btn-stop { color: #ffb4b8; border-color: #5a2d31; background: #2c1e21; font-size: 12px; }
.hhq-radio-btn-go { flex: 1.2; background: #23406b; border-color: #35618f; color: #d6e9ff; }
.hhq-radio-rate { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.hhq-radio-lab { font-size: 10.5px; color: var(--dsw-alias-text-tertiary, #8b9099); }
.hhq-radio-stars { display: inline-flex; }
.hhq-radio-star {
  border: none;
  background: transparent;
  color: #4b5057;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  padding: 0 1px;
}
.hhq-radio-star.on { color: #f5b942; }
.hhq-radio-chip {
  font-size: 10.5px;
  padding: 3px 7px;
  border-radius: 6px;
  border: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
  background: transparent;
  color: var(--dsw-alias-text-secondary, #b8bcc2);
  cursor: pointer;
}
.hhq-radio-chip-bad { color: #ffb4b8; border-color: #5a2d31; }
.hhq-radio-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
.hhq-radio-sel {
  flex: 1.3;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--dsw-alias-text-tertiary, #8b9099);
}
.hhq-radio-sel select {
  flex: 1;
  padding: 5px 6px;
  border-radius: 7px;
  border: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
  background: var(--dsw-alias-bg-secondary, #23262c);
  color: var(--dsw-alias-text-primary, #e6e8ea);
  font-size: 11.5px;
}
.hhq-radio-hint { font-size: 10px; color: var(--dsw-alias-text-tertiary, #8b9099); margin-top: 6px; }
.hhq-radio-lyrics { margin-top: 12px; font-size: 11px; color: var(--dsw-alias-text-secondary, #b8bcc2); }
.hhq-radio-lyrics pre { white-space: pre-wrap; font-size: 11px; opacity: .85; margin: 6px 0 0; }
.hhq-radio-qi, .hhq-radio-hrow, .hhq-radio-act {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11.5px;
  padding: 3px 0;
  color: var(--dsw-alias-text-secondary, #b8bcc2);
}
.hhq-radio-n { width: 14px; text-align: right; color: var(--dsw-alias-text-tertiary, #8b9099); }
.hhq-radio-qi-t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hhq-radio-qi-d { color: var(--dsw-alias-text-tertiary, #8b9099); }
.hhq-radio-hrow-s { color: #f5b942; letter-spacing: 1px; }
.hhq-radio-act { justify-content: space-between; border-top: 1px dashed var(--dsw-alias-border-secondary, #3a3f45); }
.hhq-radio-foot {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-top: 1px solid var(--dsw-alias-border-secondary, #3a3f45);
  font-size: 10.5px;
  color: var(--dsw-alias-text-tertiary, #8b9099);
}
`

/** Inject the stylesheet once (deduped by data-plugin-css). */
export function injectCss(): void {
  const tagId = 'dsh-client-ui-hawk-hq/hawk-hq.css'
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-client-ui-hawk-hq'
  tag.dataset.pluginCss = tagId
  tag.textContent = CSS_TEXT
  document.head.appendChild(tag)
}
