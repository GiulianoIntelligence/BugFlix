// The BugFlix server's client: Supabase RPCs (the bf_* functions in
// supabase/migrations) over $.http.fetch. Each call carries the player's
// secret token; the server keeps only its SHA-256.

import type { EngineInterface } from 'claude-code'

import type { BoardRow, Category, Choice, Difficulty, Me } from '../types'
import { CONFIG } from './config'

export class BackendError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export type ServerCard = {
  id: string
  category: Category
  difficulty: Difficulty
  prompt: string
  choices: [string, string, string, string]
}

export type NextResult = { isLimited: true; me: Me } | { isLimited: false; card: ServerCard; me: Me }

export type AnswerResult = {
  isCorrect: boolean
  answer: Choice
  points: number
  quip: string
  me: Me
}

export type BoardResult = {
  rows: BoardRow[]
  myRank: number | null
  playingNow: number
}

// The server in use: CONFIG's, unless BUGFLIX_SUPABASE_URL and
// BUGFLIX_SUPABASE_KEY point elsewhere (a local `supabase start`, a test).
const server = { url: CONFIG.supabaseUrl, key: CONFIG.supabaseAnonKey }

export function useServer(url: string | undefined, key: string | undefined): void {
  if (url !== undefined && url !== '' && key !== undefined && key !== '') {
    server.url = url
    server.key = key
  }
}

export function hasServer(): boolean {
  return server.url !== '' && server.key !== ''
}

export function checkoutUrl(playerId: string): string | undefined {
  if (CONFIG.stripePaymentLink === '') {
    return undefined
  }
  const separator = CONFIG.stripePaymentLink.includes('?') ? '&' : '?'

  return `${CONFIG.stripePaymentLink}${separator}client_reference_id=${encodeURIComponent(playerId)}`
}

export function makeToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '')
}

function headers(): Record<string, string> {
  const { key } = server
  const base: Record<string, string> = {
    apikey: key,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  // Legacy anon keys are JWTs and ride as a bearer too; sb_publishable_ keys
  // must not.
  if (key.startsWith('eyJ')) {
    base.Authorization = `Bearer ${key}`
  }

  return base
}

async function rpc($: EngineInterface, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await $.http.fetch(`${server.url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(args),
  })

  let body: unknown = null
  try {
    body = response.text === '' ? null : JSON.parse(response.text)
  } catch {
    body = null
  }

  if (!response.ok) {
    const message = isRecord(body) && typeof body.message === 'string' ? body.message : `HTTP ${response.status}`
    throw new BackendError(message, message)
  }

  return body
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function toMe(value: unknown): Me {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new BackendError('bad_response', 'The server sent an unexpected answer.')
  }
  const room = isRecord(value.room) ? { code: str(value.room.code), name: str(value.room.name) } : null

  return {
    id: value.id,
    handle: str(value.handle, 'player'),
    isPro: value.is_pro === true,
    total: num(value.total),
    weekly: num(value.weekly),
    streak: num(value.streak),
    bestStreak: num(value.best_streak),
    freeLeft: typeof value.free_left === 'number' ? value.free_left : null,
    rankWeekly: typeof value.rank_weekly === 'number' ? value.rank_weekly : null,
    room,
  }
}

function toCard(value: unknown): ServerCard {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 4
  ) {
    throw new BackendError('bad_response', 'The server sent an unexpected question.')
  }
  const [a, b, c, d] = value.choices.map(choice => str(choice))
  const difficulty = num(value.difficulty, 1)

  return {
    id: value.id,
    category: str(value.category, 'dev-lore') as Category,
    difficulty: (difficulty === 2 || difficulty === 3 ? difficulty : 1) as Difficulty,
    prompt: str(value.prompt),
    choices: [a ?? '', b ?? '', c ?? '', d ?? ''],
  }
}

export async function signUp($: EngineInterface, token: string, handle: string): Promise<Me> {
  return toMe(await rpc($, 'bf_register', { p_token: token, p_handle: handle }))
}

export async function fetchMe($: EngineInterface, token: string): Promise<Me> {
  return toMe(await rpc($, 'bf_me', { p_token: token }))
}

export async function fetchNext($: EngineInterface, token: string): Promise<NextResult> {
  const body = await rpc($, 'bf_next', { p_token: token })
  if (!isRecord(body)) {
    throw new BackendError('bad_response', 'The server sent an unexpected answer.')
  }
  const player = toMe(body.me)

  return body.limited === true
    ? { isLimited: true, me: player }
    : { isLimited: false, card: toCard(body.card), me: player }
}

export async function submitAnswer(
  $: EngineInterface,
  token: string,
  questionId: string,
  choice: Choice,
): Promise<AnswerResult> {
  const body = await rpc($, 'bf_answer', { p_token: token, p_question: questionId, p_choice: choice })
  if (!isRecord(body)) {
    throw new BackendError('bad_response', 'The server sent an unexpected answer.')
  }
  const correct = num(body.answer)

  return {
    isCorrect: body.is_correct === true,
    answer: (correct >= 0 && correct <= 3 ? correct : 0) as Choice,
    points: num(body.points),
    quip: str(body.quip),
    me: toMe(body.me),
  }
}

export async function fetchBoard($: EngineInterface, token: string, scope: 'global' | 'room'): Promise<BoardResult> {
  const body = await rpc($, 'bf_board', { p_token: token, p_scope: scope })
  if (!isRecord(body) || !Array.isArray(body.rows)) {
    throw new BackendError('bad_response', 'The server sent an unexpected leaderboard.')
  }

  return {
    rows: body.rows.filter(isRecord).map(row => ({
      rank: num(row.rank),
      handle: str(row.handle),
      weekly: num(row.weekly),
      isPro: row.is_pro === true,
      isMe: row.is_me === true,
    })),
    myRank: typeof body.my_rank === 'number' ? body.my_rank : null,
    playingNow: num(body.playing_now),
  }
}

export async function renamePlayer($: EngineInterface, token: string, handle: string): Promise<Me> {
  return toMe(await rpc($, 'bf_set_handle', { p_token: token, p_handle: handle }))
}

export async function createRoom($: EngineInterface, token: string, name: string): Promise<Me> {
  return toMe(await rpc($, 'bf_room_create', { p_token: token, p_name: name }))
}

export async function joinRoom($: EngineInterface, token: string, code: string): Promise<Me> {
  return toMe(await rpc($, 'bf_room_join', { p_token: token, p_code: code }))
}

export async function leaveRoom($: EngineInterface, token: string): Promise<Me> {
  return toMe(await rpc($, 'bf_room_leave', { p_token: token }))
}

// The server's error codes, in words a player reads.
export function describeError(error: unknown): string {
  if (!(error instanceof BackendError)) {
    return error instanceof Error ? error.message : 'Something went wrong.'
  }
  switch (error.code) {
    case 'handle_taken':
      return 'That name is taken. Try another.'
    case 'bad_handle':
      return 'Names are 3-20 letters, digits, _ or -.'
    case 'pro_only':
      return 'Creating rooms is a Pro feature. Joining is free.'
    case 'no_room':
      return 'No room has that code.'
    case 'unknown_player':
      return 'This player is not known to the server.'
    case 'no_pending':
      return 'That question was already answered.'
    default:
      return error.message
  }
}
