import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const PANE: RenderPropsOf['Pane'] = {
  title: 'BugFlix',
  isFocused: false,
  bodyColumns: 44,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const SURFACES = ['terminal', 'desktop'] as const

// The engine beneath the mod: a store, a clock, and a surface that places
// every pane it is asked to open.
function world(on: On, saved?: Record<string, unknown>) {
  mock.store(on, saved)
  mock.env(on, {})
  const clock = mock.clock(on, { now: 1_000 })
  const panes = new Set<string>()
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    panes.add(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', ($, e) => {
    panes.delete(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: [...panes].map(id => ({ id, title: 'BugFlix', isShown: true, isFocused: false, isPlaced: true })),
  }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return { clock, panes, statuses, toasts }
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

// A command as the person types it at the prompt.
function typed(command: string, args: string) {
  return {
    command,
    args,
    origin: { kind: 'composer' as const },
    presentation: { isFullscreen: true, columns: 160 },
  }
}

function done(turnId: string) {
  return { answer: 'Done.', durationMs: 4_000, isAborted: false, turnId, reason: 'answer' } as const
}

describe('the pane follows Claude', () => {
  test('pops up when a turn starts and closes when it ends', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    expect(w.panes.size).toBe(0)

    await $.turn.start({ text: 'fix the flaky test', turnId: 't1' })
    await w.clock.settle()
    expect(w.panes.has('bugflix')).toBe(true)

    await $.turn.complete(done('t1'))
    expect(w.panes.has('bugflix')).toBe(false)
  })

  test("a subagent's turn opens nothing", async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'search the repo', turnId: 's1', agentId: 'agent-1' })
    await w.clock.settle()
    expect(w.panes.size).toBe(0)
  })

  test('off keeps it shut, on brings it back', async ($, on) => {
    const w = world(on)
    await $.session.start(START)

    const off = await $.command.run(typed('bugflix', 'off'))
    expect(off.text).toMatch(/off/)
    await $.turn.start({ text: 'refactor', turnId: 't1' })
    await w.clock.settle()
    expect(w.panes.size).toBe(0)
    await $.turn.complete(done('t1'))

    await $.command.run(typed('bf', 'on'))
    expect(w.panes.has('bugflix')).toBe(true)
    await $.turn.start({ text: 'refactor more', turnId: 't2' })
    await w.clock.settle()
    await $.turn.complete(done('t2'))
    expect(w.panes.size).toBe(0)
  })

  test('/bugflix with no option toggles the pane', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.command.run(typed('bugflix', ''))
    expect(w.panes.has('bugflix')).toBe(true)
    await $.command.run(typed('bugflix', ''))
    expect(w.panes.has('bugflix')).toBe(false)
  })
})

describe('playing in the pane', () => {
  test('answers by click, reveals, and deals the next card', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    for (const surface of SURFACES) {
      await $.turn.start({ text: 'build it', turnId: `t-${surface}` })
      await w.clock.settle()

      const ui = await $.ui.mount({ plugin: 'bugflix', surface, component: 'Pane', requestId: 'bugflix', props: PANE })
      const keys = (await ui.findAll({ type: 'Button' })).map(button => button.key)
      expect(keys).toEqual(expect.arrayContaining(['answer-1', 'answer-2', 'answer-3', 'answer-4', 'off']))

      await ui.press({ key: 'answer-1' })
      expect(await ui.find({ key: 'next' })).toBeDefined()
      expect(await ui.find({ key: 'answer-1' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /^(✅|❌)/ })).toBeDefined()

      await ui.press({ key: 'next' })
      expect(await ui.find({ key: 'answer-1' })).toBeDefined()

      await $.turn.complete(done(`t-${surface}`))
      await ui.unmount()
    }
  })

  test('answers by command while the pane is up, keeping the transcript clean', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.command.run(typed('bugflix', ''))
    const ui = await $.ui.mount({
      plugin: 'bugflix',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'bugflix',
      props: PANE,
    })

    const answered = await $.command.run(typed('bf', '3'))
    expect(answered.text).toBeUndefined()
    expect(await ui.find({ key: 'next' })).toBeDefined()
    expect(w.panes.has('bugflix')).toBe(true)
  })

  test('pauses and resumes exactly where it left off', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'one', turnId: 't1' })
    await w.clock.settle()

    let ui = await $.ui.mount({ plugin: 'bugflix', surface: 'terminal', component: 'Pane', requestId: 'bugflix', props: PANE })
    const prompt = (await ui.findAll({ type: 'Text' })).map(text => text.text)
    await ui.unmount()

    await $.turn.complete(done('t1'))
    expect(w.panes.size).toBe(0)

    await $.turn.start({ text: 'two', turnId: 't2' })
    await w.clock.settle()
    ui = await $.ui.mount({ plugin: 'bugflix', surface: 'terminal', component: 'Pane', requestId: 'bugflix', props: PANE })
    expect((await ui.findAll({ type: 'Text' })).map(text => text.text)).toEqual(prompt)
  })

  test('says it is paused, with the score, once Claude is done', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await w.clock.settle()
    await $.command.run(typed('bugflix', '1'))
    await $.turn.complete(done('t1'))
    expect(w.statuses.at(-1)).toMatch(/BugFlix paused · \d[\d,]* pts/)
  })
})

describe('across sessions', () => {
  test('a new session resumes the saved card and score', async ($, on) => {
    const saved = {
      isEnabled: true,
      game: {
        card: {
          id: 'dl-001',
          category: 'dev-lore',
          difficulty: 1,
          prompt: 'HTTP 418 means…',
          choices: ["I'm a teapot", 'Server melted', 'Unauthorized coffee', 'Too many teapots'],
          order: [3, 2, 1, 0],
          source: 'local',
        },
        reveal: null,
        score: 1240,
        streak: 4,
        bestStreak: 6,
        answered: 12,
        correct: 9,
        seen: ['dl-001'],
      },
    }
    const w = world(on, saved)
    await $.session.start(START)
    await $.turn.start({ text: 'continue', turnId: 't1' })
    await w.clock.settle()

    const ui = await $.ui.mount({ plugin: 'bugflix', surface: 'terminal', component: 'Pane', requestId: 'bugflix', props: PANE })
    expect(await ui.find({ type: 'Text', text: 'HTTP 418 means…' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1,240 pts · 🔥4/ })).toBeDefined()

    // The teapot was drawn last (order 3, 2, 1, 0): slot 4.
    const answered = await $.command.run(typed('bugflix', '4'))
    expect(answered.text).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^✅/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1,380 pts · 🔥5/ })).toBeDefined()
  })

  test('off is remembered across sessions', async ($, on) => {
    const w = world(on, { isEnabled: false })
    await $.session.start(START)
    await $.turn.start({ text: 'work', turnId: 't1' })
    await w.clock.settle()
    expect(w.panes.size).toBe(0)
  })
})

describe('commands', () => {
  test('offline builds explain what needs the server', async ($, on) => {
    world(on)
    await $.session.start(START)
    expect((await $.command.run(typed('bugflix', 'room join ABC123'))).text).toMatch(/offline/)
    expect((await $.command.run(typed('bugflix', 'pro'))).text).toMatch(/offline/)
    expect((await $.command.run(typed('bugflix', 'help'))).text).toMatch(/\/bugflix on \| off/)
    expect((await $.command.run(typed('bugflix', 'name x'))).text).toMatch(/3-20/)
  })
})
