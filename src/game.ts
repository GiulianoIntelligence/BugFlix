// Pure game rules: dealing, scoring, levels and banter. No `$` in here, so
// every rule is testable and the server (supabase/) can mirror the scoring.

import type { Card, Choice, Difficulty, GameState, Reveal } from '../types'
import type { Question } from './questions'

export type Random = () => number

export const INITIAL_GAME: GameState = {
  card: null,
  reveal: null,
  score: 0,
  streak: 0,
  bestStreak: 0,
  answered: 0,
  correct: 0,
  seen: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function isCard(value: unknown): value is Card {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.prompt === 'string' &&
    Array.isArray(value.choices) &&
    value.choices.length === 4 &&
    Array.isArray(value.order) &&
    value.order.length === 4 &&
    (value.source === 'local' || value.source === 'online')
  )
}

function isReveal(value: unknown): value is Reveal {
  return isRecord(value) && typeof value.isCorrect === 'boolean' && typeof value.answer === 'number'
}

// Reads back what $.store kept from an earlier session (or an older version
// of the mod), keeping what still fits and starting the rest over.
export function restoreGame(saved: unknown): GameState {
  if (!isRecord(saved)) {
    return INITIAL_GAME
  }

  const card = isCard(saved.card) ? saved.card : null
  const reveal = card !== null && isReveal(saved.reveal) ? saved.reveal : null

  return {
    card,
    reveal,
    score: count(saved.score),
    streak: count(saved.streak),
    bestStreak: count(saved.bestStreak),
    answered: count(saved.answered),
    correct: count(saved.correct),
    seen: Array.isArray(saved.seen) ? saved.seen.filter((id): id is string => typeof id === 'string') : [],
  }
}

const DIFFICULTY_POINTS: Record<Difficulty, number> = { 1: 100, 2: 150, 3: 200 }

const STREAK_BONUS = 10

const MAX_STREAK_BONUS = 100

// Points for a correct answer: the difficulty's base plus 10 per streak step
// already held, capped at +100. Mirrored by bf_answer in the migration.
export function pointsFor(difficulty: Difficulty, streakBefore: number): number {
  return DIFFICULTY_POINTS[difficulty] + Math.min(streakBefore * STREAK_BONUS, MAX_STREAK_BONUS)
}

export function shuffledOrder(random: Random): Choice[] {
  const order: Choice[] = [0, 1, 2, 3]
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const held = order[i] as Choice
    order[i] = order[j] as Choice
    order[j] = held
  }

  return order
}

export function toCard(
  question: Pick<Question, 'id' | 'category' | 'difficulty' | 'prompt' | 'choices'>,
  source: Card['source'],
  random: Random,
): Card {
  return {
    id: question.id,
    category: question.category,
    difficulty: question.difficulty,
    prompt: question.prompt,
    choices: [...question.choices],
    order: shuffledOrder(random),
    source,
  }
}

// An unanswered card is kept, so a pane closed mid-question resumes on it.
export function deal(state: GameState, bank: readonly Question[], random: Random): GameState {
  if (state.card !== null && state.reveal === null) {
    return state
  }

  const seen = new Set(state.seen)
  const fresh = bank.filter(question => !seen.has(question.id))
  const pool = fresh.length > 0 ? fresh : bank
  const question = pool[Math.floor(random() * pool.length)]
  if (question === undefined) {
    return state
  }

  const history = fresh.length > 0 ? [...state.seen, question.id] : [question.id]

  return { ...state, card: toCard(question, 'local', random), reveal: null, seen: history }
}

// `slot` is the 0-based position the player picked on screen.
export function originalChoice(card: Card, slot: number): Choice | undefined {
  return card.order[slot]
}

export function answerLocal(
  state: GameState,
  bank: readonly Question[],
  slot: number,
  random: Random,
): GameState {
  const { card } = state
  if (card === null || state.reveal !== null) {
    return state
  }

  const picked = originalChoice(card, slot)
  const question = bank.find(one => one.id === card.id)
  if (picked === undefined || question === undefined) {
    return state
  }

  const isCorrect = picked === question.answer
  const points = isCorrect ? pointsFor(question.difficulty, state.streak) : 0

  return settle(state, {
    picked,
    answer: question.answer,
    isCorrect,
    points,
    quip: question.quip,
    cheer: cheerFor(isCorrect, isCorrect ? state.streak + 1 : 0, random),
  })
}

// Applies a reveal to the running tallies; the server's totals, when online,
// overwrite score and streak afterwards.
export function settle(state: GameState, reveal: Reveal): GameState {
  const streak = reveal.isCorrect ? state.streak + 1 : 0

  return {
    ...state,
    reveal,
    score: state.score + reveal.points,
    streak,
    bestStreak: Math.max(state.bestStreak, streak),
    answered: state.answered + 1,
    correct: state.correct + (reveal.isCorrect ? 1 : 0),
  }
}

const LEVELS: readonly { at: number; title: string }[] = [
  { at: 0, title: 'Prompt Padawan' },
  { at: 500, title: 'Token Tinkerer' },
  { at: 1500, title: 'Context Wrangler' },
  { at: 3000, title: 'Agent Whisperer' },
  { at: 6000, title: 'MCP Mage' },
  { at: 10000, title: 'Hallucination Hunter' },
  { at: 20000, title: 'Principal Prompt Engineer' },
  { at: 40000, title: '10x Vibe Coder' },
]

export function levelFor(score: number): { title: string; next: number | null } {
  let index = 0
  LEVELS.forEach((level, i) => {
    if (score >= level.at) {
      index = i
    }
  })

  return { title: LEVELS[index]?.title ?? 'Prompt Padawan', next: LEVELS[index + 1]?.at ?? null }
}

const RIGHT = [
  'Correct!',
  'Nailed it.',
  'Big brain energy.',
  'Ship it!',
  'LGTM.',
  'Tests pass.',
  'Zero hallucinations detected.',
]

const WRONG = [
  'Nope.',
  'Confidently incorrect.',
  'That was a hallucination.',
  'Segfault.',
  'Works on your machine only.',
  'Close. Not really.',
]

function pick<T>(list: readonly T[], random: Random): T {
  return list[Math.floor(random() * list.length)] as T
}

export function cheerFor(isCorrect: boolean, streak: number, random: Random): string {
  if (!isCorrect) {
    return pick(WRONG, random)
  }
  if (streak >= 10) {
    return `UNSTOPPABLE. ${streak} in a row!`
  }
  if (streak >= 5) {
    return `On fire: ${streak} in a row!`
  }

  return pick(RIGHT, random)
}

const ADJECTIVES = ['Async', 'Lazy', 'Rogue', 'Nullable', 'Recursive', 'Sleepy', 'Turbo', 'Vibing', 'Cached', 'Quantum']

const NOUNS = ['Prompter', 'Debugger', 'Tokenizer', 'Agent', 'Linter', 'Hamster', 'Wizard', 'Goblin', 'Duck', 'Compiler']

export function randomHandle(random: Random): string {
  return `${pick(ADJECTIVES, random)}${pick(NOUNS, random)}${Math.floor(random() * 90) + 10}`
}

export const HANDLE_PATTERN = /^[A-Za-z0-9_-]{3,20}$/

export function formatPoints(points: number): string {
  return String(Math.round(points)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

// Accepts 1-4 or a-d, as typed after /bugflix; the 0-based slot or undefined.
export function slotFromArg(arg: string): number | undefined {
  const text = arg.trim().toLowerCase()
  const digit = ['1', '2', '3', '4'].indexOf(text)
  if (digit >= 0) {
    return digit
  }
  const letter = ['a', 'b', 'c', 'd'].indexOf(text)

  return letter >= 0 ? letter : undefined
}
