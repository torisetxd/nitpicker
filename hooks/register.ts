import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { NitpickerRun } from '../types'

const AGENT = 'nitpicker:reviewer'
const MARK = 'nitpicks from the reviewer'
const DEFAULT_ROUNDS = 3

const run = atom(
  { plugin: 'nitpicker', key: 'run' } as const,
  { round: 0, isDirty: false, history: [], reviewers: [] } as NitpickerRun,
  { shape: 'run-1' },
)

const REVIEWER_PROMPT = `You are the nitpicker: a picky, hands-on QA tester. Another agent (the builder) just told the owner it finished a change. You test the real, running app the way the owner would, then report every flaw you notice, big or small. You never fix anything yourself.

# How you work

1. Orient. Your first message has the owner's recent requests and the builder's report. Look at what changed: \`git status\`, \`git diff --stat\`, \`git log --oneline -15\` (when it is a git repo). Read the project's CLAUDE.md, README and any run notes to learn how to build and launch it. If a skill exists for running this project, use it. Check your agent memory for notes from earlier runs on this project (how to launch it, what the reference is, what the owner cares about).

2. Find the reference. Most work is measured against something: the previous version in git, an original app being ported or recreated ("like discord", "parity with the old ui"), a design or a spec. Work out what it is. When it is an earlier version in git, check it out into a separate worktree under /tmp (\`git worktree add /tmp/nitpick-ref <rev>\`), run it beside the new one, and remove the worktree when you are done. Never touch the builder's working tree.

3. Run it for real, and use it. Build and start the app in the background with output to a log (\`cmd > /tmp/nitpick/app.log 2>&1 & echo $! > /tmp/nitpick/app.pid\`), put \`timeout\` on anything that might hang, and kill only the PIDs you started. Then look at it:
   - web apps: drive a headless browser (Playwright through uv or npx, or browser tools if you have them): click, hover, scroll, type, resize, screenshot.
   - desktop GUI apps: screenshot with whatever exists (grim, spectacle -bno, gnome-screenshot, import -window root, xwd), drive input with xdotool, ydotool or wtype when available, or computer-use tools if you have them.
   - CLIs and TUIs: run them in tmux and capture the pane.
   - things you cannot see (a server, a mod with no client at hand): use logs, a test client, or the code, and say plainly what you could not verify.
   Open every screenshot with Read and actually look at it. Compare reference against new, and before against after. Exercise what the change touched and the neighbours a regression would hit.

4. Nitpick. Look hard at:
   - parity: anything the reference has that the new version lacks or does differently (features, settings screens, layout, colors, icons, wording, shortcuts).
   - interaction states: hover, focus, pressed, disabled, selected; hover colors; transitions and animations; cursors; tooltip placement and centering.
   - layout: margins, padding, alignment, centering, consistent spacing, overflow, clipping, wrapping, resizing, scrollbars, wasted space.
   - feel: smooth scrolling, jank or stutter while loading images or new content, blocking work on the UI thread, flashes of empty content, slow startup.
   - behaviour: broken flows, wrong grouping or ordering, edge cases (empty, very long, many items, errors, offline), state lost between views, things that used to work and no longer do, memory and resource handling.
   - polish: missing affordances (a drag area for a custom title bar, close buttons, keyboard navigation), inconsistent styles, leftover placeholders, console errors and warnings.
   When code explains a symptom you saw (a synchronous decode behind a stutter), mention it after the symptom.

5. Clean up. Kill every process you started, remove worktrees, delete scratch files. Keep only the screenshots your report points at, under /tmp/nitpick/.

6. Save to your agent memory anything that will make the next run on this project faster: how to launch and screenshot it, where the reference lives, what the owner keeps caring about.

# Rules

- Never modify the project: no edits to its files, no commits, stashes, checkouts, resets or cleans in its repository. Scratch work goes under /tmp/nitpick/. Your agent memory folder is the one exception.
- Respect the owner's global instructions (CLAUDE.md), e.g. never kill their gradle daemon, never pkill -f a plain pattern.
- Report what you saw or confirmed, not guesses. Mark a hunch with a question mark, as in "stutters when loading images (make async?)".
- When earlier nitpicks are given, check each one: leave out what is fixed, re-raise what is not as "still: ...".
- No praise, no summary of what works, no preamble.

# Your final message

It is pasted to the builder exactly as you write it, so it holds only this:

- When nothing is worth changing: one line starting with LGTM, optionally saying what you checked.
- Otherwise a numbered list, one short line per item, lowercase, plain and direct, in the voice of a picky owner, most important first. For example:
  1. ui parity in the settings modal is effectively non existent
  2. hover does not show up in settings
  3. highlighted mention messages are blue instead of yellow like the reference
  4. margins are very weirdly done (see /tmp/nitpick/margins.png)
  5. add smooth scrolling when clicking on replies
  6. stutters when loading images / new messages (make async?)
  7. jump to latest isnt centered
  Put a screenshot path after an item when it helps. After the list you may add one line "not checked: ..." naming what you could not verify.`

const MUTATING_BASH =
  /\bsed\s+(?:-\w+\s+)*-\w*i|\bperl\s+-\w*i|\btee\s|\bpatch\s|\bgit\s+(?:commit|apply|am|merge|rebase|cherry-pick|checkout|restore|reset|stash\s+pop)\b/
const REDIRECT = /(?:^|[^0-9&>])>>?\s*([^\s;&|<>]+)/g
const SCRATCH_TARGET = /^(?:\/dev\/|\/tmp\/|\/proc\/|&)|\.(?:log|pid|out|txt)$|^[^./]+$/
const REVIEWER_GIT =
  /\bgit\b[^|;&\n]*\b(?:stash|checkout|switch|reset|restore|clean|commit|rebase|merge|apply|am|cherry-pick|push|pull|rm|mv)\b/

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n[... cut ${text.length - max} characters]` : text

function bashWrites(command: string): boolean {
  if (MUTATING_BASH.test(command)) return true
  for (const match of command.matchAll(REDIRECT)) {
    if (!SCRATCH_TARGET.test(match[1] ?? '')) return true
  }
  return false
}

function isInsideProject(path: string, root: string): boolean {
  const abs = path.startsWith('/') ? path : `${root}/${path}`
  const isInside = abs === root || abs.startsWith(`${root}/`)
  return isInside && !abs.startsWith(`${root}/.claude/`)
}

type Settings = { isOn: boolean; maxRounds: number; mode: 'auto' | 'ask' }

async function settings($: EngineInterface): Promise<Settings> {
  const root = await $.session.root()
  const projects = ((await $.store.get('projects')) ?? {}) as Record<string, boolean>
  const maxRounds = Number((await $.store.get('maxRounds')) ?? DEFAULT_ROUNDS)
  const mode = (await $.store.get('mode')) === 'ask' ? 'ask' : 'auto'
  return { isOn: projects[root] === true, maxRounds, mode }
}

async function setOn($: EngineInterface, isOn: boolean) {
  const root = await $.session.root()
  const projects = ((await $.store.get('projects')) ?? {}) as Record<string, boolean>
  await $.store.set('projects', { ...projects, [root]: isOn })
}

async function ownerRequests($: EngineInterface): Promise<string[]> {
  const messages = await $.session.messages()
  return messages
    .filter(
      m =>
        m.role === 'user' &&
        !m.toolResults?.length &&
        m.text.trim() !== '' &&
        !m.text.trimStart().startsWith('<') &&
        !m.text.includes(MARK),
    )
    .map(m => clip(m.text.trim(), 3000))
    .slice(-8)
}

async function lastAssistantText($: EngineInterface): Promise<string> {
  const messages = await $.session.messages()
  return messages.findLast(m => m.role === 'assistant' && m.text.trim() !== '')?.text ?? ''
}

async function startReview(
  $: EngineInterface,
  builderReport: string,
  focus?: string,
): Promise<string> {
  const state = await read($, run)
  if (state.pending !== undefined) return 'a review is already running'

  const { maxRounds } = await settings($)
  const round = state.round + 1
  const root = await $.session.root()
  const cwd = await $.session.cwd()
  const asks = await ownerRequests($)

  const sections = [
    `Review round ${round} of ${maxRounds}. Project root: ${root}. Working directory: ${cwd}.`,
    `## What the owner asked for (their recent messages, oldest first)\n\n${
      asks.length ? asks.map(a => `<request>\n${a}\n</request>`).join('\n\n') : '(none found)'
    }`,
    `## The builder's report of what it just did\n\n${clip(builderReport.trim() || '(empty)', 8000)}`,
  ]
  if (state.history.length) {
    sections.push(
      `## Earlier nitpicks (oldest first; may be from earlier work). Check each: drop what is fixed, re-raise what is not as "still: ..."\n\n${state.history
        .map((h, i) => `<round n="${i + 1}">\n${clip(h, 4000)}\n</round>`)
        .join('\n\n')}`,
    )
  }
  if (focus) sections.push(`## Extra focus from the owner\n\n${focus}`)
  sections.push('Test the app now and report as your instructions say.')

  const spawned = await $.agent.spawn({
    subagentType: AGENT,
    description: `nitpick round ${round}`,
    prompt: sections.join('\n\n'),
  })
  if (spawned.deny !== undefined || spawned.agentId === undefined) {
    return `could not start the reviewer: ${spawned.deny ?? 'no agent id'}`
  }

  const agentId = spawned.agentId
  await update($, run, s => ({
    ...s,
    round,
    pending: agentId,
    isDirty: false,
    reviewers: s.reviewers.includes(agentId) ? s.reviewers : [...s.reviewers, agentId].slice(-50),
  }))
  $.ui.status(`nitpicker: testing (round ${round}/${maxRounds})`)
  $.ui.toast(`nitpicker: reviewer is testing the change (round ${round}/${maxRounds})`)
  return `reviewer started (round ${round}/${maxRounds})`
}

async function deliver($: EngineInterface, report: string, round: number) {
  const { maxRounds, mode } = await settings($)

  if (/^\s*lgtm\b/i.test(report)) {
    await update($, run, s => ({ ...s, history: [] }))
    $.ui.log(`nitpicker (round ${round}): ${clip(report.trim(), 1500)}`)
    $.ui.toast('nitpicker: LGTM, nothing to nitpick')
    return
  }

  await update($, run, s => ({ ...s, history: [...s.history, report.trim()].slice(-3) }))

  if (mode === 'ask') {
    const box = await $.prompt.read()
    await $.prompt.fill({ text: report.trim(), mode: box.text.trim() ? 'append' : 'replace' })
    $.ui.toast('nitpicker: nitpicks are in the prompt box; edit and send them')
    return
  }

  const isLast = round >= maxRounds
  const text = [
    `${MARK} (round ${round}/${maxRounds}), after testing the running app:`,
    report.trim(),
    `fix what's real. if an item is wrong, intended, or out of scope, say so in a line instead of changing it. finish normally when done${
      isLast ? '; this was the last automatic review round.' : '; the reviewer checks again afterwards.'
    }`,
  ].join('\n\n')
  await $.prompt.submit({ text })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'nitpick',
      description: 'Reviewer agent that tests the app after each change and nitpicks it',
      argumentHint: 'on | off | now [focus] | rounds <n> | mode auto|ask | reset',
    })
    try {
      await $.agent.register({
        name: 'reviewer',
        description:
          'Picky hands-on QA tester: runs the app after a change, compares it with the reference or previous version, and returns a terse numbered list of nitpicks (parity, hover and transitions, margins, stutter, regressions). Never edits the project.',
        prompt: REVIEWER_PROMPT,
        model: 'inherit',
        disallowedTools: ['Agent'],
        memory: 'local',
      })
    } catch (error) {
      $.ui.log(`nitpicker: could not register the reviewer agent: ${String(error)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'nitpick' }, async ($, e) => {
    const [verb = 'status', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ').trim()

    switch (verb.toLowerCase()) {
      case 'on':
        await setOn($, true)
        return { text: `nitpicker on for ${await $.session.root()}: a reviewer tests the app after each turn that changes files.` }
      case 'off':
        await setOn($, false)
        return { text: `nitpicker off for ${await $.session.root()}.` }
      case 'now': {
        await update($, run, s => ({ ...s, round: 0 }))
        const said = await startReview($, await lastAssistantText($), arg || undefined)
        return { text: `nitpicker: ${said}.` }
      }
      case 'rounds': {
        const n = Number.parseInt(arg, 10)
        if (!Number.isInteger(n) || n < 1 || n > 20) return { text: 'usage: /nitpick rounds <1-20>' }
        await $.store.set('maxRounds', n)
        return { text: `nitpicker: up to ${n} automatic review rounds per prompt.` }
      }
      case 'mode': {
        if (arg !== 'auto' && arg !== 'ask') return { text: 'usage: /nitpick mode auto|ask' }
        await $.store.set('mode', arg)
        return {
          text:
            arg === 'auto'
              ? 'nitpicker: nitpicks go straight to the main agent.'
              : 'nitpicker: nitpicks land in your prompt box to edit and send.',
        }
      }
      case 'reset':
        await update($, run, s => ({ ...s, round: 0, history: [], pending: undefined, isDirty: false }))
        $.ui.status(undefined)
        return { text: 'nitpicker: rounds and earlier nitpicks cleared.' }
      default: {
        const s = await settings($)
        const state = await read($, run)
        return {
          text: [
            `nitpicker is ${s.isOn ? 'on' : 'off'} for ${await $.session.root()}`,
            `mode ${s.mode}, up to ${s.maxRounds} rounds, round ${state.round} so far`,
            state.pending ? 'a review is running' : 'no review running',
            'usage: /nitpick on | off | now [focus] | rounds <n> | mode auto|ask | reset',
          ].join('\n'),
        }
      }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const state = await read($, run)
    if (
      e.origin.kind === 'task-notification' &&
      state.reviewers.some(id => e.text.includes(id))
    ) {
      return { drop: 'nitpicker delivers its reviewer reports itself' }
    }
    if (e.origin.kind === 'composer' || e.origin.kind === 'bridge') {
      if (state.pending !== undefined) {
        $.ui.status(undefined)
        $.ui.toast('nitpicker: you sent a new prompt, the running review will be shown but not sent')
      }
      await update($, run, s => ({ ...s, round: 0, pending: undefined }))
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    const agentId = started.agentId
    if (e.subagentType === AGENT && agentId !== undefined) {
      await update($, run, s =>
        s.reviewers.includes(agentId) ? s : { ...s, reviewers: [...s.reviewers, agentId].slice(-50) },
      )
    }
    return started
  })

  on('tool.call', async ($, e, next) => {
    const state = await read($, run)
    const isReviewer = e.agentId !== undefined && state.reviewers.includes(e.agentId)

    if (isReviewer) {
      const root = await $.session.root()
      if (e.tool === 'Edit' || e.tool === 'Write') {
        if (isInsideProject(e.file_path, root)) {
          return { deny: 'nitpicker: the reviewer reports problems, it does not edit the project.' }
        }
      } else if (e.tool === 'NotebookEdit') {
        if (isInsideProject(e.notebook_path, root)) {
          return { deny: 'nitpicker: the reviewer reports problems, it does not edit the project.' }
        }
      } else if (e.tool === 'Bash' && REVIEWER_GIT.test(e.command)) {
        return {
          deny: 'nitpicker: the reviewer must not change the repository; use `git worktree add /tmp/nitpick-ref <rev>` to look at another version.',
        }
      }
      return next(e)
    }

    const isWrite =
      e.tool === 'Edit' ||
      e.tool === 'Write' ||
      e.tool === 'NotebookEdit' ||
      (e.tool === 'Bash' && bashWrites(e.command))
    if (isWrite && !state.isDirty) await update($, run, s => ({ ...s, isDirty: true }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const state = await read($, run)

    if (e.agentId !== undefined) {
      if (!state.reviewers.includes(e.agentId)) return result
      const isCurrent = state.pending === e.agentId
      if (isCurrent) {
        $.ui.status(undefined)
        await update($, run, s => ({ ...s, pending: undefined }))
      }
      if (e.reason !== 'answer' || e.answer.trim() === '') {
        if (isCurrent) $.ui.toast(`nitpicker: the reviewer stopped without a report (${e.reason})`)
        return result
      }
      if (isCurrent) await deliver($, e.answer, state.round)
      else $.ui.log(`nitpicker: review not sent (you moved on):\n${clip(e.answer.trim(), 1800)}`)
      return result
    }

    if (!state.isDirty) return result
    await update($, run, s => ({ ...s, isDirty: false }))
    if (e.reason !== 'answer' || state.pending !== undefined) return result
    const { isOn, maxRounds } = await settings($)
    if (!isOn) return result
    if (state.round >= maxRounds) {
      $.ui.toast(`nitpicker: ${maxRounds} review rounds done; /nitpick now for another`)
      return result
    }
    const said = await startReview($, e.answer)
    if (said.startsWith('could not')) $.ui.toast(`nitpicker: ${said}`)
    return result
  })
}
