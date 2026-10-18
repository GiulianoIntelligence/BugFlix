import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Card, GameState, Me, NetState, Reveal } from '../types'
import {
  BackendError,
  checkoutUrl,
  createRoom,
  describeError,
  fetchBoard,
  fetchMe,
  fetchNext,
  hasServer,
  joinRoom,
  leaveRoom,
  makeToken,
  renamePlayer,
  signUp,
  submitAnswer,
  useServer,
} from '../src/backend'
import { CONFIG } from '../src/config'
import {
  answerLocal,
  cheerFor,
  deal,
  formatPoints,
  HANDLE_PATTERN,
  INITIAL_GAME,
  levelFor,
  originalChoice,
  randomHandle,
  restoreGame,
  settle,
  slotFromArg,
  toCard,
} from '../src/game'
import { CATEGORY_LABEL, STARTER_PACK } from '../src/questions'

type Engine = EngineInterface

type Auth = { token: string; playerId: string }

const PANE = 'bugflix'

const TITLE = 'BugFlix'

const POLL_MS = 60_000

const COMMAND_HINT = '[on|off|1-4|next|top|room|name|pro|help]'

const INITIAL_NET: NetState = {
  mode: 'offline',
  me: null,
  board: [],
  scope: 'global',
  playingNow: null,
  isLimited: false,
  note: null,
}

const game = atom({ plugin: 'bugflix', key: 'game' } as const, INITIAL_GAME)
const view = atom({ plugin: 'bugflix', key: 'view' } as const, 'play')
const net = atom({ plugin: 'bugflix', key: 'net' } as const, INITIAL_NET)
const isEnabled = atom({ plugin: 'bugflix', key: 'isEnabled' } as const, true)

const HELP = [
  'BugFlix: AI trivia while Claude works.',
  '  /bugflix            show or hide the pane',
  '  /bugflix on | off   pop up automatically while Claude works (on by default)',
  '  /bugflix 1-4        answer (or click, or ctrl+x tab into the pane and press 1-4)',
  '  /bugflix next       next question',
  '  /bugflix top        weekly leaderboard',
  '  /bugflix name <you> pick your leaderboard name',
  '  /bugflix room join <CODE> | room new <name> | room leave',
  '  /bugflix pro        unlimited questions, every new pack, team rooms',
  '  /bugflix refresh    re-check your account (after upgrading)',
].join('\n')

// Module state: what a hot reload may forget without harm.
let isTurnRunning = false
let poll: Timer | undefined
let isAnswering = false

function isAuth(value: unknown): value is Auth {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Auth).token === 'string' &&
    typeof (value as Auth).playerId === 'string'
  )
}

async function loadAuth($: Engine): Promise<Auth | undefined> {
  const saved = await $.store.get('auth')

  return isAuth(saved) ? saved : undefined
}

async function setGame($: Engine, change: (state: GameState) => GameState): Promise<GameState> {
  const after = await update($, game, change)
  await $.store.set('game', after)

  return after
}

async function setNet($: Engine, change: Partial<NetState>): Promise<void> {
  await update($, net, state => {
    // Only bf_board ranks a player: other answers keep the last rank shown.
    const me =
      change.me && change.me.rankWeekly === null && state.me?.id === change.me.id
        ? { ...change.me, rankWeekly: state.me.rankWeekly }
        : change.me

    return { ...state, ...change, ...(me === undefined ? {} : { me }) }
  })
}

function withServerTotals(state: GameState, me: Me): GameState {
  return { ...state, score: me.total, streak: me.streak, bestStreak: Math.max(state.bestStreak, me.bestStreak) }
}

async function isPaneOpen($: Engine): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE)
}

// --- the server -------------------------------------------------------------

async function signIn($: Engine): Promise<Me> {
  const saved = await loadAuth($)
  if (saved !== undefined) {
    try {
      return await fetchMe($, saved.token)
    } catch (error) {
      if (!(error instanceof BackendError && error.code === 'unknown_player')) {
        throw error
      }
    }
  }

  const token = makeToken()
  const player = await signUp($, token, randomHandle(Math.random))
  await $.store.set('auth', { token, playerId: player.id })

  return player
}

async function connect($: Engine): Promise<void> {
  if (!hasServer()) {
    return
  }

  await setNet($, { mode: 'connecting', note: null })
  try {
    const player = await signIn($)
    await setNet($, { mode: 'online', me: player, note: null, isLimited: false })
    // Online, the server deals: a local card left from offline play goes.
    await setGame($, state =>
      withServerTotals(state.card?.source === 'local' && state.reveal === null ? { ...state, card: null } : state, player),
    )
  } catch (error) {
    await setNet($, { mode: 'error', note: `Playing offline: ${describeError(error)}` })
  }
}

async function refreshBoard($: Engine): Promise<void> {
  const status = await read($, net)
  const auth = await loadAuth($)
  if (status.mode !== 'online' || auth === undefined) {
    return
  }

  try {
    const result = await fetchBoard($, auth.token, status.scope)
    await update($, net, state => ({
      ...state,
      board: result.rows,
      playingNow: result.playingNow,
      me: state.me === null ? null : { ...state.me, rankWeekly: result.myRank },
    }))
  } catch (error) {
    await setNet($, { note: describeError(error) })
  }
}

function startPolling($: Engine): void {
  if (poll !== undefined || !hasServer()) {
    return
  }
  poll = $.clock.every(POLL_MS, () => {
    void refreshBoard($)
  })
  void refreshBoard($)
}

function stopPolling(): void {
  poll?.cancel()
  poll = undefined
}

// --- playing ----------------------------------------------------------------

// Deals a new card unless one is waiting for an answer.
async function dealCard($: Engine): Promise<void> {
  const current = await read($, game)
  if (current.card !== null && current.reveal === null) {
    return
  }

  const status = await read($, net)
  const auth = await loadAuth($)
  if (status.mode === 'online' && auth !== undefined) {
    try {
      const result = await fetchNext($, auth.token)
      if (result.isLimited) {
        await setNet($, { me: result.me, isLimited: true })
        await setGame($, state => ({ ...state, card: null, reveal: null }))

        return
      }
      await setNet($, { me: result.me, isLimited: false, note: null })
      await setGame($, state => ({ ...state, card: toCard(result.card, 'online', Math.random), reveal: null }))

      return
    } catch (error) {
      // The server is unreachable: keep the fun going on the starter pack.
      await setNet($, { note: `Offline round: ${describeError(error)}` })
    }
  }

  await setGame($, state => deal(state, STARTER_PACK, Math.random))
}

async function ensureCard($: Engine): Promise<void> {
  const current = await read($, game)
  if (current.card === null) {
    await dealCard($)
  }
}

function slotOf(card: Card, choice: number): number {
  return card.order.indexOf(choice as Card['order'][number])
}

function summary(state: GameState): string {
  const { card, reveal } = state
  if (card === null || reveal === null) {
    return 'No answer yet.'
  }
  if (reveal.isCorrect) {
    const streak = state.streak > 1 ? ` · 🔥${state.streak}` : ''

    return `✅ ${reveal.cheer} +${reveal.points}${streak} · ${reveal.quip}`
  }
  const slot = slotOf(card, reveal.answer)

  return `❌ ${reveal.cheer} It was ${slot + 1}: ${card.choices[reveal.answer] ?? ''} · ${reveal.quip}`
}

async function answerSlot($: Engine, slot: number): Promise<string> {
  const current = await read($, game)
  const { card } = current
  if (card === null) {
    return 'No question up. /bugflix deals one.'
  }
  if (current.reveal !== null) {
    return 'Already answered. /bugflix next for another.'
  }
  const picked = originalChoice(card, slot)
  if (picked === undefined) {
    return 'Pick 1, 2, 3 or 4.'
  }

  if (card.source === 'local') {
    return summary(await setGame($, state => answerLocal(state, STARTER_PACK, slot, Math.random)))
  }

  const auth = await loadAuth($)
  if (auth === undefined) {
    return 'Not signed in to the BugFlix server. Try /bugflix refresh.'
  }
  if (isAnswering) {
    return 'Hang on, still scoring your last answer.'
  }
  isAnswering = true
  try {
    const result = await submitAnswer($, auth.token, card.id, picked)
    const reveal: Reveal = {
      picked,
      answer: result.answer,
      isCorrect: result.isCorrect,
      points: result.points,
      quip: result.quip,
      cheer: cheerFor(result.isCorrect, result.me.streak, Math.random),
    }
    const after = await setGame($, state =>
      state.card?.id === card.id && state.reveal === null ? withServerTotals(settle(state, reveal), result.me) : state,
    )
    await setNet($, { me: result.me, note: null })

    return summary(after)
  } catch (error) {
    if (error instanceof BackendError && error.code === 'no_pending') {
      // Answered from another terminal: move on.
      await setGame($, state => ({ ...state, card: null, reveal: null }))
      await dealCard($)
    }
    await setNet($, { note: describeError(error) })

    return describeError(error)
  } finally {
    isAnswering = false
  }
}

async function nextCard($: Engine): Promise<string> {
  const current = await read($, game)
  if (current.card !== null && current.reveal === null) {
    return 'Answer this one first: 1-4.'
  }
  await update($, view, () => 'play')
  await dealCard($)

  return 'Next question is up.'
}

// --- the pane ---------------------------------------------------------------

// Opens the pane without waiting on the network; the card follows.
async function showPane($: Engine): Promise<boolean> {
  const opened = await $.ui.open({ id: PANE, title: TITLE, rows: 16, columns: 46 })
  $.ui.status(opened.isPlaced ? undefined : '🎬 BugFlix: type /bugflix to play while Claude works')
  if (opened.isPlaced) {
    startPolling($)
  }

  return opened.isPlaced
}

async function openPane($: Engine): Promise<boolean> {
  const isPlaced = await showPane($)
  await ensureCard($)

  return isPlaced
}

async function closePane($: Engine): Promise<void> {
  stopPolling()
  if (await isPaneOpen($)) {
    await $.ui.close({ id: PANE })
  }
}

async function showPaused($: Engine): Promise<void> {
  const state = await read($, game)
  if (state.answered === 0 || !(await read($, isEnabled))) {
    $.ui.status(undefined)

    return
  }
  const streak = state.streak > 0 ? ` · 🔥${state.streak}` : ''
  $.ui.status(`🎬 BugFlix paused · ${formatPoints(state.score)} pts${streak} · back when Claude works`)
}

async function setEnabled($: Engine, value: boolean): Promise<void> {
  await update($, isEnabled, () => value)
  await $.store.set('isEnabled', value)
}

async function turnOff($: Engine): Promise<string> {
  await setEnabled($, false)
  await closePane($)
  $.ui.status(undefined)

  return 'BugFlix off. /bugflix on brings it back.'
}

// --- commands ---------------------------------------------------------------

async function requireOnline($: Engine): Promise<{ auth: Auth } | { text: string }> {
  const status = await read($, net)
  const auth = await loadAuth($)
  if (!hasServer()) {
    return { text: 'This BugFlix build runs offline: no leaderboards, rooms or Pro.' }
  }
  if (status.mode !== 'online' || auth === undefined) {
    return { text: `Not connected to the BugFlix server${status.note ? ` (${status.note})` : ''}. Try /bugflix refresh.` }
  }

  return { auth }
}

async function roomCommand($: Engine, words: string[]): Promise<string> {
  const online = await requireOnline($)
  if ('text' in online) {
    return online.text
  }
  const [action = '', ...rest] = words
  try {
    let player: Me
    switch (action.toLowerCase()) {
      case 'new':
      case 'create':
        player = await createRoom($, online.auth.token, rest.join(' ').trim() || 'My team')
        break
      case 'join':
        player = await joinRoom($, online.auth.token, (rest[0] ?? '').toUpperCase())
        break
      case 'leave':
        player = await leaveRoom($, online.auth.token)
        break
      default: {
        const room = (await read($, net)).me?.room

        return room
          ? `You are in room ${room.code} (${room.name}). Share: /bugflix room join ${room.code}`
          : 'Not in a room. Join one with /bugflix room join <CODE>; Pro players create them with /bugflix room new <name>.'
      }
    }
    await setNet($, { me: player, scope: player.room ? 'room' : 'global' })
    await refreshBoard($)

    return player.room
      ? `You're in room ${player.room.code} (${player.room.name}). Teammates join with /bugflix room join ${player.room.code}`
      : 'You left the room.'
  } catch (error) {
    return describeError(error)
  }
}

async function nameCommand($: Engine, handle: string): Promise<string> {
  if (!HANDLE_PATTERN.test(handle)) {
    return 'Names are 3-20 letters, digits, _ or -.'
  }
  const online = await requireOnline($)
  if ('text' in online) {
    return online.text
  }
  try {
    const player = await renamePlayer($, online.auth.token, handle)
    await setNet($, { me: player })

    return `You're now ${player.handle} on the leaderboard.`
  } catch (error) {
    return describeError(error)
  }
}

async function proText($: Engine): Promise<string> {
  const online = await requireOnline($)
  if ('text' in online) {
    return online.text
  }
  const me = (await read($, net)).me
  if (me?.isPro) {
    return CONFIG.stripePortalLink
      ? `You're Pro ✨ Manage your subscription: ${CONFIG.stripePortalLink}`
      : "You're Pro ✨ Thanks for keeping BugFlix alive!"
  }
  const url = checkoutUrl(online.auth.playerId)

  return url
    ? `BugFlix Pro (${CONFIG.priceLabel}): unlimited questions, every new pack, team rooms. Upgrade: ${url}  Then run /bugflix refresh.`
    : 'Pro is not on sale yet.'
}

function statsText(state: GameState): string {
  const level = levelFor(state.score)
  const rate = state.answered > 0 ? Math.round((state.correct / state.answered) * 100) : 0
  const next = level.next === null ? 'max level!' : `${formatPoints(level.next - state.score)} pts to next level`

  return `${level.title} · ${formatPoints(state.score)} pts · ${state.correct}/${state.answered} right (${rate}%) · best streak ${state.bestStreak} · ${next}`
}

async function runCommand($: Engine, args: string): Promise<{ text?: string }> {
  const [verb = '', ...rest] = args.trim().split(/\s+/)
  const word = verb.toLowerCase()

  const slot = slotFromArg(word)
  if (slot !== undefined) {
    const text = await answerSlot($, slot)

    // With the pane in view the answer shows there; the transcript (which
    // Claude reads too) stays clean.
    return (await isPaneOpen($)) ? {} : { text }
  }

  switch (word) {
    case '': {
      if (await isPaneOpen($)) {
        await closePane($)

        return { text: 'BugFlix hidden. /bugflix brings it back.' }
      }
      await openPane($)

      return { text: 'BugFlix is up: click an answer, or ctrl+x tab into the pane and press 1-4.' }
    }
    case 'on':
      await setEnabled($, true)
      await openPane($)

      return { text: 'BugFlix on: it pops up while Claude works and pauses when it is done.' }
    case 'off':
      return { text: await turnOff($) }
    case 'next':
    case 'n':
    case 'skip': {
      const before = await read($, game)
      const isWaiting = before.card !== null && before.reveal === null
      const text = await nextCard($)
      if (!(await isPaneOpen($))) {
        await openPane($)
      }

      return isWaiting ? { text } : {}
    }
    case 'top':
    case 'board':
    case 'leaderboard':
      await update($, view, () => 'board')
      await openPane($)
      await refreshBoard($)

      return {}
    case 'room':
      return { text: await roomCommand($, rest) }
    case 'name':
      return { text: await nameCommand($, rest.join('')) }
    case 'pro':
    case 'upgrade': {
      const text = await proText($)
      await update($, view, () => 'pro')
      await openPane($)

      return { text }
    }
    case 'refresh':
      await connect($)
      await refreshBoard($)

      return { text: describeAccount(await read($, net)) }
    case 'stats':
      return { text: statsText(await read($, game)) }
    case 'help':
    case '?':
      return { text: HELP }
    default:
      return { text: `Unknown option "${verb}".\n${HELP}` }
  }
}

function describeAccount(status: NetState): string {
  if (status.mode !== 'online' || status.me === null) {
    return status.note ?? 'Playing offline.'
  }
  const { me } = status
  const plan = me.isPro ? 'Pro ✨' : `Free (${me.freeLeft ?? 0} questions left today)`

  return `Signed in as ${me.handle} · ${plan} · ${formatPoints(me.weekly)} pts this week`
}

// --- drawing ----------------------------------------------------------------

const STARS: Record<number, string> = { 1: '★☆☆', 2: '★★☆', 3: '★★★' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'bugflix',
      description: 'AI trivia while Claude works: show/hide, on|off, 1-4, next, top, room, pro',
      argumentHint: COMMAND_HINT,
      immediate: true,
    })
    await $.command.register({
      name: 'bf',
      description: 'Short for /bugflix',
      argumentHint: COMMAND_HINT,
      immediate: true,
    })

    const [savedGame, savedEnabled, serverUrl, serverKey] = await Promise.all([
      $.store.get('game'),
      $.store.get('isEnabled'),
      $.env.get('BUGFLIX_SUPABASE_URL'),
      $.env.get('BUGFLIX_SUPABASE_KEY'),
    ])
    useServer(serverUrl, serverKey)
    await update($, game, () => restoreGame(savedGame))
    await update($, isEnabled, () => savedEnabled !== false)
    await update($, view, () => 'play')

    if (hasServer()) {
      $.clock.after(0, () => {
        void connect($)
      })
    }
    await showPaused($)

    return next(e)
  })

  on('command.run', { command: 'bugflix' }, ($, e) => runCommand($, e.args)).catch(() => ({
    text: 'BugFlix hiccuped. Try again in a moment.',
  }))
  on('command.run', { command: 'bf' }, ($, e) => runCommand($, e.args)).catch(() => ({
    text: 'BugFlix hiccuped. Try again in a moment.',
  }))

  // Claude starts working: the pane pops up (when on). It opens here, in
  // answer to the prompt that started the turn; the card is fetched after,
  // so the turn never waits on the network.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }
    isTurnRunning = true
    if (await read($, isEnabled)) {
      await showPane($)
      $.clock.after(0, () => {
        void (async () => {
          await ensureCard($)
          if (!isTurnRunning) {
            await closePane($)
          }
        })()
      })
    }

    return next(e)
  })

  // Claude is done: the pane closes; the game resumes next time.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }
    isTurnRunning = false
    const result = await next(e)
    await closePane($)
    await showPaused($)

    return result
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      stopPolling()
      $.ui.toast('BugFlix hidden until Claude starts its next task. /bugflix off stops the pop-ups.')
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const state = await read($, game)
    const screen = await read($, view)
    const status = await read($, net)
    const isOnline = status.mode === 'online' && status.me !== null
    const level = levelFor(state.score)
    const back = <Button key="back" plain hotkey="b" label="Back" onPress={() => update($, view, () => 'play')} />

    const header = (
      <Box flexDirection="column" marginBottom={1}>
        <Text wrap="truncate-end">
          <Text bold color="claude">
            🎬 BugFlix
          </Text>
          <Text dimColor> · {level.title}</Text>
        </Text>
        <Text wrap="truncate-end">
          {formatPoints(state.score)} pts{state.streak > 0 ? ` · 🔥${state.streak}` : ''} · {state.correct}/
          {state.answered} right{isOnline && status.me?.isPro ? ' · ✨Pro' : ''}
        </Text>
      </Box>
    )

    const note = status.note ? (
      <Text color="warning" wrap="truncate-end">
        {status.note}
      </Text>
    ) : null

    if (screen === 'help') {
      return (
        <Box flexDirection="column">
          {header}
          <Text bold>How to play</Text>
          <Text>• Pops up while Claude works, pauses when it is done.</Text>
          <Text>• Click an answer, or ctrl+x tab here and press 1-4.</Text>
          <Text>• Or type /bugflix 1-4 and /bugflix next.</Text>
          <Text>• /bugflix off stops the pop-ups, /bugflix on brings them back.</Text>
          <Text>• /bugflix name you · /bugflix room join CODE</Text>
          <Text dimColor>Points: 100/150/200 by difficulty, +10 per streak step (max +100).</Text>
          <Box marginTop={1}>{back}</Box>
        </Box>
      )
    }

    if (screen === 'board') {
      const inRoom = isOnline && status.me?.room !== null && status.me?.room !== undefined
      const scopeLabel = status.scope === 'room' && status.me?.room ? `Room ${status.me.room.code}` : 'Global'

      return (
        <Box flexDirection="column">
          {header}
          <Text bold>🏆 This week · {scopeLabel}</Text>
          {!isOnline && <Text dimColor>Leaderboards need the BugFlix server. You're playing offline.</Text>}
          {isOnline && status.board.length === 0 && <Text dimColor>Nobody on the board yet. Be first!</Text>}
          {status.board.map(row => (
            <Text key={`row-${row.rank}-${row.handle}`} wrap="truncate-end" bold={row.isMe} color={row.isMe ? 'success' : undefined}>
              {String(row.rank).padStart(3)}. {row.handle}
              {row.isPro ? ' ✨' : ''} · {formatPoints(row.weekly)}
            </Text>
          ))}
          {isOnline && status.me?.rankWeekly && !status.board.some(row => row.isMe) ? (
            <Text color="success">
              {String(status.me.rankWeekly).padStart(3)}. You · {formatPoints(status.me.weekly)}
            </Text>
          ) : null}
          {status.playingNow !== null && <Text dimColor>🟢 {status.playingNow} playing right now</Text>}
          {note}
          <Box marginTop={1} gap={2}>
            {back}
            {inRoom && (
              <Button
                key="scope"
                plain
                hotkey="g"
                label={status.scope === 'room' ? 'Global' : 'My room'}
                onPress={async () => {
                  await update($, net, current => ({
                    ...current,
                    scope: current.scope === 'room' ? ('global' as const) : ('room' as const),
                  }))
                  await refreshBoard($)
                }}
              />
            )}
          </Box>
        </Box>
      )
    }

    if (screen === 'pro') {
      const me = status.me
      const url = me ? checkoutUrl(me.id) : undefined

      return (
        <Box flexDirection="column">
          {header}
          <Text bold>✨ BugFlix Pro · {CONFIG.priceLabel}</Text>
          <Text>• Unlimited questions (free: {CONFIG.freeDailyQuestions} a day)</Text>
          <Text>• Every new question pack as it drops</Text>
          <Text>• Private rooms for your team</Text>
          <Text>• A ✨ next to your name</Text>
          {!isOnline && <Text dimColor>Pro needs the BugFlix server. You're playing offline.</Text>}
          {isOnline && me?.isPro && <Text color="success">You're Pro. Thank you for keeping BugFlix alive!</Text>}
          {isOnline && !me?.isPro && url !== undefined && <Link href={url} label="→ Upgrade with Stripe" />}
          {isOnline && !me?.isPro && url === undefined && <Text dimColor>Pro is not on sale yet.</Text>}
          {isOnline && me?.isPro && CONFIG.stripePortalLink !== '' && (
            <Link href={CONFIG.stripePortalLink} label="Manage subscription" />
          )}
          {note}
          <Box marginTop={1} gap={2}>
            {back}
            {isOnline && !me?.isPro && (
              <Button
                key="refresh"
                plain
                hotkey="f"
                label="I've paid: refresh"
                onPress={async () => {
                  await connect($)
                }}
              />
            )}
          </Box>
        </Box>
      )
    }

    const { card, reveal } = state
    const footer = (
      <Box flexDirection="column" marginTop={1}>
        {isOnline && status.me ? (
          <Text dimColor wrap="truncate-end">
            {status.me.rankWeekly ? `🏆 #${status.me.rankWeekly} this week` : '🏆 unranked'}
            {status.playingNow !== null ? ` · 🟢 ${status.playingNow} playing` : ''}
            {!status.me.isPro && status.me.freeLeft !== null ? ` · ${status.me.freeLeft} free left today` : ''}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {status.mode === 'connecting' ? 'Connecting…' : 'Offline mode · local score'}
          </Text>
        )}
        <Box gap={2}>
          <Button key="top" plain hotkey="t" label="Top" onPress={() => update($, view, () => 'board').then(() => refreshBoard($))} />
          <Button key="pro" plain hotkey="p" label="Pro" onPress={() => update($, view, () => 'pro')} />
          <Button key="help" plain hotkey="h" label="Help" onPress={() => update($, view, () => 'help')} />
          <Button
            key="off"
            plain
            hotkey="x"
            label="Off"
            onPress={async () => {
              $.ui.toast(await turnOff($))
            }}
          />
        </Box>
      </Box>
    )

    if (card === null) {
      return (
        <Box flexDirection="column">
          {header}
          {status.isLimited ? (
            <Box flexDirection="column">
              <Text bold>That's today's {CONFIG.freeDailyQuestions} free questions! 🎉</Text>
              <Text>Come back tomorrow, or go Pro for unlimited play.</Text>
              <Button key="go-pro" variant="primary" label="See Pro" onPress={() => update($, view, () => 'pro')} />
            </Box>
          ) : (
            <Text dimColor>Shuffling the deck…</Text>
          )}
          {note}
          {footer}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {header}
        <Text dimColor wrap="truncate-end">
          {CATEGORY_LABEL[card.category]} · {STARS[card.difficulty] ?? ''}
        </Text>
        <Text bold>{card.prompt}</Text>
        <Box flexDirection="column" marginTop={1}>
          {card.order.map((choice, slot) => {
            const label = card.choices[choice] ?? ''
            if (reveal === null) {
              return (
                <Button
                  key={`answer-${slot + 1}`}
                  plain
                  hotkey={String(slot + 1)}
                  label={label}
                  onPress={() => answerSlot($, slot)}
                />
              )
            }
            const isAnswer = choice === reveal.answer
            const isPicked = choice === reveal.picked

            return (
              <Text
                key={`shown-${slot + 1}`}
                color={isAnswer ? 'success' : isPicked ? 'error' : undefined}
                dimColor={!isAnswer && !isPicked}
              >
                {isAnswer ? '✓' : isPicked ? '✗' : ' '} {slot + 1}: {label}
              </Text>
            )
          })}
        </Box>
        {reveal !== null && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={reveal.isCorrect ? 'success' : 'error'}>
              {reveal.isCorrect ? `✅ ${reveal.cheer} +${reveal.points}` : `❌ ${reveal.cheer}`}
            </Text>
            <Text italic dimColor>
              {reveal.quip}
            </Text>
            <Button key="next" variant="primary" hotkey="n" label="Next question" onPress={() => nextCard($)} />
          </Box>
        )}
        {note}
        {footer}
      </Box>
    )
  })
}
