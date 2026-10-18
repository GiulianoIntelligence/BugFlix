import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderPropsOf } from 'claude-code'

const PANE: RenderPropsOf['Pane'] = {
  title: 'BugFlix',
  isFocused: false,
  bodyColumns: 44,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

const CARD = {
  id: 'api-001',
  category: 'llm-apis',
  difficulty: 1,
  prompt: 'HTTP 429 means…',
  choices: ['The model is tired', 'Too Many Requests: slow down', 'Created successfully', 'Payment required'],
}

function typed(command: string, args: string) {
  return { command, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } }
}

type FakeOptions = { freeLeft?: number; isDown?: boolean }

// The engine beneath the mod, plus a fake BugFlix server behind $.http.fetch
// that answers the bf_* RPCs the way the migration's functions do.
function world(on: On, options: FakeOptions = {}) {
  mock.store(on)
  mock.env(on, { BUGFLIX_SUPABASE_URL: 'https://fake.supabase.co', BUGFLIX_SUPABASE_KEY: 'sb_publishable_test' })
  const clock = mock.clock(on, { now: 1_000 })
  const panes = new Set<string>()
  const calls: { fn: string; args: Record<string, unknown>; headers: Record<string, string> }[] = []
  let me = {
    id: '6f1c2c1e-0000-4000-8000-000000000001',
    handle: 'TurboDuck42',
    is_pro: false,
    total: 0,
    weekly: 0,
    streak: 0,
    best_streak: 0,
    free_left: options.freeLeft ?? 20,
    rank_weekly: null as number | null,
    room: null as { code: string; name: string } | null,
  }

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
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  on('http.fetch', ($, e) => {
    const fn = e.url.split('/rest/v1/rpc/')[1] ?? ''
    const args = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    calls.push({ fn, args, headers: e.init?.headers ?? {} })
    const reply = (status: number, body: unknown) => ({
      value: { status, ok: status < 300, headers: {}, text: JSON.stringify(body) },
    })
    if (options.isDown) {
      return reply(503, { message: 'upstream unavailable' })
    }

    switch (fn) {
      case 'bf_register':
      case 'bf_me':
        return reply(200, me)
      case 'bf_next':
        return me.free_left === 0
          ? reply(200, { limited: true, card: null, me })
          : reply(200, { limited: false, card: CARD, me })
      case 'bf_answer': {
        const isCorrect = args.p_choice === 1
        me = {
          ...me,
          total: me.total + (isCorrect ? 100 : 0),
          weekly: me.weekly + (isCorrect ? 100 : 0),
          streak: isCorrect ? me.streak + 1 : 0,
          free_left: me.free_left - 1,
        }

        return reply(200, { is_correct: isCorrect, answer: 1, points: isCorrect ? 100 : 0, quip: 'Back off.', me })
      }
      case 'bf_board':
        return reply(200, {
          rows: [{ rank: 1, handle: me.handle, weekly: me.weekly, is_pro: false, is_me: true }],
          my_rank: 1,
          playing_now: 7,
        })
      case 'bf_room_join':
        if (args.p_code !== 'ABC123') {
          return reply(400, { message: 'no_room' })
        }
        me = { ...me, room: { code: 'ABC123', name: 'Team Rocket' } }

        return reply(200, me)
      default:
        return reply(404, { message: `unknown rpc ${fn}` })
    }
  })

  return { clock, panes, calls }
}

async function playOne($: Engine, clock: { settle: () => Promise<void> }) {
  await $.session.start(START)
  await clock.settle()
  await $.turn.start({ text: 'ship it', turnId: 't1' })
  await clock.settle()

  return $.ui.mount({ plugin: 'bugflix', surface: 'terminal', component: 'Pane', requestId: 'bugflix', props: PANE })
}

describe('online', () => {
  test('signs up once, deals from the server and scores there', async ($, on) => {
    const w = world(on)
    const ui = await playOne($, w.clock)

    expect(w.calls[0]?.fn).toBe('bf_register')
    expect(String(w.calls[0]?.args.p_token)).toMatch(/^[0-9a-f]{64}$/)
    expect(w.calls[0]?.headers.apikey).toBe('sb_publishable_test')
    expect(w.calls[0]?.headers.Authorization).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'HTTP 429 means…' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /🟢 7 playing/ })).toBeDefined()

    // Find the slot the shuffle put "Too Many Requests" in, and click it.
    const buttons = await ui.findAll({ type: 'Button', text: /Too Many Requests/ })
    expect(buttons).toHaveLength(1)
    await ui.press({ key: buttons[0]!.key! })

    const answer = w.calls.find(call => call.fn === 'bf_answer')
    expect(answer?.args).toMatchObject({ p_question: 'api-001', p_choice: 1 })
    expect(await ui.find({ type: 'Text', text: /^✅ .* \+100/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /100 pts · 🔥1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /19 free left today/ })).toBeDefined()

    // A second session signs in with the stored token instead of signing up.
    await $.session.start(START)
    await w.clock.settle()
    expect(w.calls.filter(call => call.fn === 'bf_register')).toHaveLength(1)
    expect(w.calls.at(-1)?.fn).toBe('bf_me')
  })

  test('the free limit shows the upgrade, not a question', async ($, on) => {
    const w = world(on, { freeLeft: 0 })
    const ui = await playOne($, w.clock)
    expect(await ui.find({ type: 'Text', text: /free questions/ })).toBeDefined()
    expect(await ui.find({ key: 'go-pro' })).toBeDefined()
    expect(await ui.find({ key: 'answer-1' })).toBeUndefined()

    await ui.press({ key: 'go-pro' })
    expect(await ui.find({ type: 'Text', text: /BugFlix Pro/ })).toBeDefined()
  })

  test('a server outage falls back to the starter pack', async ($, on) => {
    const w = world(on, { isDown: true })
    const ui = await playOne($, w.clock)
    expect(await ui.find({ key: 'answer-1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Playing offline/ })).toBeDefined()
  })

  test('joins a room by code', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    expect((await $.command.run(typed('bugflix', 'room join nope'))).text).toMatch(/No room/)
    expect((await $.command.run(typed('bugflix', 'room join abc123'))).text).toMatch(/room ABC123 \(Team Rocket\)/)
  })

  test('Pro without a payment link says so', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await w.clock.settle()
    expect((await $.command.run(typed('bugflix', 'pro'))).text).toMatch(/not on sale/)
  })
})
