/**
 * Composer skills dropdown — the most-used composer feature here, rebuilt as a real
 * slot occupant instead of a hand patch inside the conversation bundle.
 *
 * History: a 2026-09-07 hand patch added this to the installed
 * `dsh-client-ui-conversation/lib/client.js`. That patch could not survive an
 * install, and it did not: the 0.1.5 upgrade wiped it (preserved with its diff
 * in a snapshot dir). This is the durable replacement.
 *
 * Why it can be durable now: 0.1.5's composer declares the session-scope list
 * seat `conversation.input.left`, and the conversation wiring publishes the
 * public input face to every session-scope slot occupant
 * (`ctx.uiSession.provide({ props: ['inputActions'] })`), whose `setDraft(text)`
 * is exactly what the old patch used. Being a plugin occupant, this survives
 * every harness upgrade — and it deliberately imports nothing from the platform
 * beyond react: the old patch's trigger leaned on the conversation bundle's own
 * CSS-module class names, which is precisely the kind of dependency that broke
 * the user-bubble override in 0.1.5 (that module is gone).
 *
 * Storage is unchanged on purpose: localStorage key `dsh.composer.skills`, the
 * same JSON shape, the same six seed defaults and the same
 * "Name = prompt template" editor format — so skills saved before the upgrade
 * are still there.
 */

import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

/** localStorage key — unchanged from the 2026-09-07 patch so saved skills survive. */
const COMPOSER_SKILLS_KEY = 'dsh.composer.skills'

/** Seed defaults: examples of the mechanism, replaced by whatever you save. */
const COMPOSER_SKILLS_DEFAULT: readonly ComposerSkill[] = [
  { id: 'explain-error', name: 'Explain this error', prompt: 'Explain this error and the shortest path to a fix: ' },
  { id: 'summarize-diff', name: 'Summarize the diff', prompt: 'Summarize the staged diff and flag anything risky' },
  { id: 'review-tests', name: 'Review the tests', prompt: 'Review the tests for this change and name the gaps' },
  { id: 'write-commit', name: 'Write the commit message', prompt: 'Write the commit message for the staged changes' },
]

/** One prompt template. */
interface ComposerSkill {
  readonly id: string
  readonly name: string
  readonly prompt: string
}

/** Props the session-scope seat provides (only what this component uses). */
interface ComposerSkillsProps {
  /** The public input action face; absent only outside a session scope. */
  readonly inputActions?: {
    setDraft(text: string): void
  }
  /** Session-scope hooks published alongside the actions (input state). */
  readonly hooks?: {
    readonly input?: {
      getSnapshot?: () => { readonly phase?: string }
    }
  }
}

/** Read the saved skills; falls back to the defaults for missing/garbage data. */
function loadComposerSkills(): ComposerSkill[] {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(COMPOSER_SKILLS_KEY)
  } catch {
    // Private mode / storage disabled: defaults only.
  }
  if (typeof raw === 'string' && raw !== '') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return parsed
          .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
          .filter(entry => typeof entry.name === 'string')
          .map(entry => ({
            id: typeof entry.id === 'string' ? entry.id : String(entry.name),
            name: String(entry.name),
            prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
          }))
      }
    } catch {
      // Corrupt value: keep the defaults rather than throwing away the feature.
    }
  }
  return [...COMPOSER_SKILLS_DEFAULT]
}

/** Persist the skills; a storage failure never breaks the composer. */
function saveComposerSkills(skills: readonly ComposerSkill[]): void {
  try {
    window.localStorage.setItem(COMPOSER_SKILLS_KEY, JSON.stringify(skills))
  } catch {
    // Ignore: the in-memory list still works for this session.
  }
}

/** `Name = prompt` per line, the editor's wire format. */
function serializeComposerSkills(skills: readonly ComposerSkill[]): string {
  return skills.map(skill => `${skill.name} = ${skill.prompt}`).join('\n')
}

/** Parse the editor's wire format back into skills (blank lines and dupes handled). */
function parseComposerSkills(text: string): ComposerSkill[] {
  const out: ComposerSkill[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const eq = trimmed.indexOf('=')
    const name = (eq === -1 ? trimmed : trimmed.slice(0, eq)).trim()
    const prompt = (eq === -1 ? '' : trimmed.slice(eq + 1)).trim()
    if (name === '') continue
    const lower = name.toLowerCase()
    const id = name.replace(/\s+/g, '-').toLowerCase() + (seen.has(lower) ? `-${out.length}` : '')
    seen.add(lower)
    out.push({ id, name, prompt })
  }
  return out
}

/** Current input phase: anything but 'plain' means the composer is mid-flight. */
function inputPhaseOf(props: ComposerSkillsProps): string {
  try {
    return props.hooks?.input?.getSnapshot?.()?.phase ?? 'plain'
  } catch {
    return 'plain'
  }
}

/** The `conversation.input.left` occupant: a Skills dropdown above the composer. */
export function ComposerSkills(props: ComposerSkillsProps): ReactNode {
  const [skills, setSkills] = useState<ComposerSkill[]>(loadComposerSkills)
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorText, setEditorText] = useState('')
  const root = useRef<HTMLDivElement | null>(null)
  const trigger = useRef<HTMLButtonElement | null>(null)

  const actions = props.inputActions
  const ready = actions !== undefined

  /**
   * Anchor the menu above the trigger with fixed coordinates. The composer bar
   * clips its own children, so an absolutely positioned menu would be cut off at
   * the bottom of the viewport — and `position: fixed` keeps this component
   * dependency-free (no portal, no react-dom import).
   */
  const placeMenu = useCallback((): void => {
    const rect = trigger.current?.getBoundingClientRect()
    if (rect === undefined) return
    setMenuPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 })
  }, [])

  // Click-outside and Escape close the menu, like the shell's own menus.
  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent): void => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    const onMove = (): void => placeMenu()
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [menuOpen, placeMenu])

  const toggleMenu = useCallback((): void => {
    if (menuOpen) {
      setMenuOpen(false)
      return
    }
    placeMenu()
    setMenuOpen(true)
  }, [menuOpen, placeMenu])

  /** Write one skill's prompt into the composer draft (the old patch's setDraft). */
  const applySkill = useCallback((skill: ComposerSkill): void => {
    setMenuOpen(false)
    if (actions === undefined || skill.prompt === '') return
    // Refuse while the composer is mid-flight, as the old patch did with machineBusy.
    if (inputPhaseOf(props) !== 'plain') return
    actions.setDraft(skill.prompt)
  }, [actions, props])

  const openEditor = useCallback((): void => {
    setMenuOpen(false)
    setEditorText(serializeComposerSkills(skills))
    setEditorOpen(true)
  }, [skills])

  const saveEditor = useCallback((): void => {
    const next = parseComposerSkills(editorText)
    setSkills(next)
    saveComposerSkills(next)
    setEditorOpen(false)
  }, [editorText])

  return h('div', { className: 'hhq-sk', ref: root },
    h('button', {
      type: 'button',
      ref: trigger,
      className: `hhq-sk-trigger${menuOpen ? ' hhq-sk-trigger-open' : ''}`,
      'aria-label': 'Skills',
      'aria-haspopup': 'menu',
      'aria-expanded': menuOpen,
      disabled: !ready,
      title: ready ? 'Insert a saved prompt template' : 'Skills unavailable in this context',
      onClick: toggleMenu,
    },
      h('span', { className: 'hhq-sk-bolt', 'aria-hidden': 'true' }, '⚡'),
      h('span', { className: 'hhq-sk-label' }, 'Skills…'),
      h('span', { className: 'hhq-sk-chevron', 'aria-hidden': 'true' }, '▾')),

    menuOpen && menuPos !== null
      ? h('div', {
          className: 'hhq-sk-menu',
          role: 'menu',
          style: { left: `${menuPos.left}px`, bottom: `${menuPos.bottom}px` },
        },
          skills.length === 0
            ? h('div', { className: 'hhq-sk-empty' }, 'No skills yet — use Manage skills…')
            : skills.map(skill => h('button', {
                key: skill.id,
                type: 'button',
                role: 'menuitem',
                className: 'hhq-sk-item',
                title: skill.prompt,
                onClick: () => applySkill(skill),
              },
                h('span', { className: 'hhq-sk-item-name' }, skill.name),
                h('span', { className: 'hhq-sk-item-prompt' }, skill.prompt))),
          h('div', { className: 'hhq-sk-sep' }),
          h('button', {
            type: 'button',
            role: 'menuitem',
            className: 'hhq-sk-item hhq-sk-item-manage',
            onClick: openEditor,
          }, 'Manage skills…'))
      : null,

    editorOpen
      ? h('div', { className: 'hhq-sk-overlay', onClick: () => setEditorOpen(false) },
          h('div', {
            className: 'hhq-sk-modal',
            role: 'dialog',
            'aria-label': 'Manage skills',
            onClick: (event: MouseEvent) => event.stopPropagation(),
          },
            h('div', { className: 'hhq-sk-modal-title' }, 'Manage skills'),
            h('div', { className: 'hhq-sk-modal-hint' },
              'One per line: Name = prompt template · use {subject} as a fill-in'),
            h('textarea', {
              className: 'hhq-sk-textarea',
              value: editorText,
              spellCheck: false,
              onChange: (event: { target: { value: string } }) => setEditorText(event.target.value),
            }),
            h('div', { className: 'hhq-sk-actions' },
              h('button', {
                type: 'button',
                className: 'hhq-sk-btn',
                onClick: () => setEditorOpen(false),
              }, 'Cancel'),
              h('button', {
                type: 'button',
                className: 'hhq-sk-btn hhq-sk-btn-primary',
                onClick: saveEditor,
              }, 'Save'))))
      : null)
}
