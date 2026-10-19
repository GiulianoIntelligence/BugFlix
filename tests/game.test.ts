import { describe, expect, test } from 'claude-code/testing'

import {
  answerLocal,
  deal,
  formatPoints,
  INITIAL_GAME,
  levelFor,
  pointsFor,
  restoreGame,
  shuffledOrder,
  slotFromArg,
} from '../src/game'
import { STARTER_PACK } from '../src/questions'

// A seeded generator, so a run is the same every time.
function seeded(seed: number): () => number {
  let value = seed

  return () => {
    value = (value * 1103515245 + 12345) % 2147483648

    return value / 2147483648
  }
}

describe('starter pack', () => {
  test('every question is well formed', () => {
    const ids = new Set<string>()
    for (const question of STARTER_PACK) {
      expect(ids.has(question.id), `duplicate id ${question.id}`).toBe(false)
      ids.add(question.id)
      expect(question.choices).toHaveLength(4)
      expect(new Set(question.choices).size, `repeated choice in ${question.id}`).toBe(4)
      expect(question.answer).toBeGreaterThanOrEqual(0)
      expect(question.answer).toBeLessThanOrEqual(3)
      expect(question.prompt.length).toBeGreaterThan(5)
      expect(question.quip.length).toBeGreaterThan(5)
    }
    expect(STARTER_PACK.length).toBeGreaterThanOrEqual(80)
  })
})

describe('scoring', () => {
  test('pays by difficulty plus a capped streak bonus', () => {
    expect(pointsFor(1, 0)).toBe(100)
    expect(pointsFor(2, 0)).toBe(150)
    expect(pointsFor(3, 3)).toBe(230)
    expect(pointsFor(1, 50)).toBe(200)
  })

  test('levels climb with the score', () => {
    expect(levelFor(0).title).toBe('Prompt Padawan')
    expect(levelFor(0).next).toBe(500)
    expect(levelFor(3200).title).toBe('Agent Whisperer')
    expect(levelFor(99999).next).toBeNull()
  })

  test('formats points with thousands separators', () => {
    expect(formatPoints(0)).toBe('0')
    expect(formatPoints(1240)).toBe('1,240')
    expect(formatPoints(1234567)).toBe('1,234,567')
  })
})

describe('playing', () => {
  test('a shuffled order is a permutation of the four choices', () => {
    const random = seeded(7)
    for (let i = 0; i < 50; i++) {
      expect([...shuffledOrder(random)].sort()).toEqual([0, 1, 2, 3])
    }
  })

  test('an unanswered card is kept, an answered one replaced', () => {
    const random = seeded(1)
    const first = deal(INITIAL_GAME, STARTER_PACK, random)
    expect(first.card).not.toBeNull()
    expect(deal(first, STARTER_PACK, random)).toBe(first)

    const answered = answerLocal(first, STARTER_PACK, 0, random)
    expect(answered.reveal).not.toBeNull()
    const second = deal(answered, STARTER_PACK, random)
    expect(second.card?.id).not.toBe(first.card?.id)
    expect(second.reveal).toBeNull()
  })

  test('the right slot scores and builds a streak, the wrong one resets it', () => {
    const random = seeded(3)
    let state = deal(INITIAL_GAME, STARTER_PACK, random)
    const card = state.card!
    const question = STARTER_PACK.find(one => one.id === card.id)!
    const rightSlot = card.order.indexOf(question.answer)

    state = answerLocal(state, STARTER_PACK, rightSlot, random)
    expect(state.reveal?.isCorrect).toBe(true)
    expect(state.score).toBe(pointsFor(question.difficulty, 0))
    expect(state.streak).toBe(1)
    expect(state.correct).toBe(1)

    state = deal(state, STARTER_PACK, random)
    const next = state.card!
    const nextQuestion = STARTER_PACK.find(one => one.id === next.id)!
    const wrongSlot = next.order.findIndex(choice => choice !== nextQuestion.answer)
    state = answerLocal(state, STARTER_PACK, wrongSlot, random)
    expect(state.reveal?.isCorrect).toBe(false)
    expect(state.streak).toBe(0)
    expect(state.bestStreak).toBe(1)
    expect(state.answered).toBe(2)
  })

  test('answering twice changes nothing', () => {
    const random = seeded(5)
    const answered = answerLocal(deal(INITIAL_GAME, STARTER_PACK, random), STARTER_PACK, 0, random)
    expect(answerLocal(answered, STARTER_PACK, 1, random)).toBe(answered)
  })

  test('the whole pack is dealt before any repeat', () => {
    const random = seeded(11)
    let state = INITIAL_GAME
    const dealt = new Set<string>()
    for (let i = 0; i < STARTER_PACK.length; i++) {
      state = deal(state, STARTER_PACK, random)
      dealt.add(state.card!.id)
      state = answerLocal(state, STARTER_PACK, 0, random)
    }
    expect(dealt.size).toBe(STARTER_PACK.length)
  })

  test('reads 1-4 and a-d as answer slots', () => {
    expect(slotFromArg('1')).toBe(0)
    expect(slotFromArg('4')).toBe(3)
    expect(slotFromArg('C')).toBe(2)
    expect(slotFromArg('5')).toBeUndefined()
    expect(slotFromArg('next')).toBeUndefined()
  })
})

describe('restoring', () => {
  test('a saved game comes back as it was', () => {
    const random = seeded(9)
    const saved = answerLocal(deal(INITIAL_GAME, STARTER_PACK, random), STARTER_PACK, 2, random)
    expect(restoreGame(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
  })

  test('junk starts a new game', () => {
    expect(restoreGame(undefined)).toEqual(INITIAL_GAME)
    expect(restoreGame('nope')).toEqual(INITIAL_GAME)
    expect(restoreGame({ score: -5, card: { id: 1 } })).toEqual(INITIAL_GAME)
  })
})
