// Run with `node --test supabase/functions/stripe-webhook/handler_test.ts`
// (Node 22.18+) or `deno test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { decide, isLive, toRpc } from './handler.ts'

const PLAYER = '6f1c2c1e-0000-4000-8000-000000000001'

test('a paid checkout names its player, customer and subscription', () => {
  const update = decide({
    type: 'checkout.session.completed',
    data: {
      object: { client_reference_id: PLAYER, payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1' },
    },
  })
  assert.deepEqual(update, { by: 'checkout', playerId: PLAYER, customerId: 'cus_1', subscriptionId: 'sub_1' })
})

test('the checkout RPC takes the live status read from Stripe, not from the event', () => {
  const update = { by: 'checkout', playerId: PLAYER, customerId: 'cus_1', subscriptionId: 'sub_1' } as const
  assert.deepEqual(toRpc(update, true), {
    fn: 'bf_stripe_checkout',
    args: { p_player: PLAYER, p_customer: 'cus_1', p_subscription: 'sub_1', p_is_live: true },
  })
  // A checkout retried after the subscription was cancelled records it as not live.
  assert.equal(toRpc(update, false).args.p_is_live, false)
})

test('a one-off (lifetime) payment has no subscription and is always live', () => {
  const update = decide({
    type: 'checkout.session.completed',
    data: { object: { client_reference_id: PLAYER, payment_status: 'paid', customer: { id: 'cus_2' }, subscription: null } },
  })
  assert.deepEqual(update, { by: 'checkout', playerId: PLAYER, customerId: 'cus_2', subscriptionId: null })
  assert.deepEqual(toRpc(update!, false).args, { p_player: PLAYER, p_customer: 'cus_2', p_subscription: null, p_is_live: true })
})

test('an unpaid checkout waits for async_payment_succeeded', () => {
  const object = { client_reference_id: PLAYER, payment_status: 'unpaid', customer: 'cus_1', subscription: 'sub_1' }
  assert.equal(decide({ type: 'checkout.session.completed', data: { object } }), null)
  assert.equal(
    decide({ type: 'checkout.session.async_payment_succeeded', data: { object: { ...object, payment_status: 'paid' } } })
      ?.by,
    'checkout',
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

test('subscription events name the subscription only; its status is read from Stripe', () => {
  for (const type of ['customer.subscription.updated', 'customer.subscription.deleted']) {
    const update = decide({ type, data: { object: { id: 'sub_1', status: 'active' } } })
    assert.deepEqual(update, { by: 'subscription', subscriptionId: 'sub_1' })
    assert.deepEqual(toRpc(update!, false), {
      fn: 'bf_stripe_subscription',
      args: { p_subscription: 'sub_1', p_is_live: false },
    })
  }
})

test('live statuses', () => {
  assert.equal(isLive('active'), true)
  assert.equal(isLive('trialing'), true)
  assert.equal(isLive('past_due'), true)
  for (const status of ['canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused', undefined]) {
    assert.equal(isLive(status), false)
  }
})

test('other events change nothing', () => {
  assert.equal(decide({ type: 'invoice.paid', data: { object: {} } }), null)
})
