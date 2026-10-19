export type Category = 'claude-code' | 'llm-apis' | 'prompting' | 'agents-mcp' | 'dev-lore'

export type Difficulty = 1 | 2 | 3

export type Choice = 0 | 1 | 2 | 3

export type Card = {
  id: string
  category: Category
  difficulty: Difficulty
  prompt: string
  choices: readonly string[]
  order: readonly Choice[]
  source: 'local' | 'online'
}

export type Reveal = {
  picked: Choice
  answer: Choice
  isCorrect: boolean
  points: number
  quip: string
  cheer: string
}

export type GameState = {
  card: Card | null
  reveal: Reveal | null
  score: number
  streak: number
  bestStreak: number
  answered: number
  correct: number
  seen: string[]
}

export type Room = { code: string; name: string }

export type Me = {
  id: string
  handle: string
  isPro: boolean
  total: number
  weekly: number
  streak: number
  bestStreak: number
  freeLeft: number | null
  rankWeekly: number | null
  room: Room | null
}

export type BoardRow = {
  rank: number
  handle: string
  weekly: number
  isPro: boolean
  isMe: boolean
}

export type NetState = {
  mode: 'offline' | 'connecting' | 'online' | 'error'
  me: Me | null
  board: BoardRow[]
  scope: 'global' | 'room'
  playingNow: number | null
  isLimited: boolean
  note: string | null
}

export type View = 'play' | 'board' | 'pro' | 'help'

declare module 'claude-code' {
  interface PluginState {
    bugflix: {
      game: GameState
      view: View
      net: NetState
      isEnabled: boolean
    }
  }
}
