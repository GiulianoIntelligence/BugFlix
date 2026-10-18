// Run with `node --test supabase/functions/stripe-webhook/handler_test.ts`
// (Node 22.18+) or `deno test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decide } from './handler.ts'

const PLAYER = '6f1c2c1e-0000-4000-8000-000000000001'

test('a paid checkout makes its player Pro', () => {
  const update = decide({
    type: 'checkout.session.completed',
    data: {
      object: { client_reference_id: PLAYER, payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1' },
    },
  })
  assert.deepEqual(update, { by: 'player', playerId: PLAYER, isPro: true, customerId: 'cus_1', subscriptionId: 'sub_1' })
})

test('a lifetime (one-off) payment has no subscription', () => {
  const update = decide({
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: PLAYER, payment_status: 'paid', customer: { id: 'cus_2' }, subscription: null } },
  })
  assert.deepEqual(update, { by: 'player', playerId: PLAYER, isPro: true, customerId: 'cus_2', subscriptionId: null })
})

test('an unpaid checkout waits for async_payment_succeeded', () => {
  const object = { client_reference_id: PLAYER, payment_status: 'unpaid', customer: 'cus_1', subscription: 'sub_1' }
  assert.equal(decide({ type: 'checkout.session.completed', data: { object } }), null)
  assert.equal(
    decide({ type: 'checkout.session.async_payment_succeeded', data: { object: { ...object, payment_status: 'paid' } } })
      ?.isPro,
    true,
  )
})

test('checkouts that are not BugFlix sales are ignored', () => {
  for (const client_reference_id of [undefined, null, 'not-a-uuid', "1'; drop table bf_players;--"]) {
    assert.equal(
      decide({ type: 'checkout.session.completed', data: { object: { client_reference_id, payment_status: 'paid' } } }),
      null,
    )
  }
})

test('subscription status keeps or ends Pro', () => {
  const status = (type: string, value: string) =>
    decide({ type, data: { object: { id: 'sub_1', status: value } } })
  assert.deepEqual(status('customer.subscription.updated', 'active'), { by: 'subscription', subscriptionId: 'sub_1', isPro: true })
  assert.equal(status('customer.subscription.updated', 'past_due')?.isPro, true)
  assert.equal(status('customer.subscription.updated', 'unpaid')?.isPro, false)
  assert.equal(status('customer.subscription.updated', 'canceled')?.isPro, false)
  assert.equal(status('customer.subscription.deleted', 'active')?.isPro, false)
})

test('other events change nothing', () => {
  assert.equal(decide({ type: 'invoice.paid', data: { object: {} } }), null)
})
