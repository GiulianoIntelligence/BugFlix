// What a Stripe event means for a BugFlix player, apart from Stripe's and
// Supabase's clients so it can be tested on its own (handler_test.ts).
//
// An event is only a trigger. Stripe may deliver events late, twice or out of
// order, so whether a subscription is live is read from Stripe when the event
// is handled (index.ts), never from the status the event recorded.

export type ProUpdate =
  | {
      by: 'checkout'
      playerId: string
      customerId: string | null
      subscriptionId: string | null
    }
  | { by: 'subscription'; subscriptionId: string }

export type StripeEventLike = {
  type: string
  data: { object: Record<string, unknown> }
}

// The RPC in the migration that records the update.
export type Rpc =
  | {
      fn: 'bf_stripe_checkout'
      args: { p_player: string; p_customer: string | null; p_subscription: string | null; p_is_live: boolean }
    }
  | { fn: 'bf_stripe_subscription'; args: { p_subscription: string; p_is_live: boolean } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Subscription statuses that keep Pro on. past_due keeps it while Stripe
// retries the card; Stripe ends the subscription if the retries fail.
const LIVE = new Set(['active', 'trialing', 'past_due'])

export function isLive(status: unknown): boolean {
  return LIVE.has(String(status))
}

function idOf(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id
  }

  return null
}

export function decide(event: StripeEventLike): ProUpdate | null {
  const object = event.data.object

  switch (event.type) {
    // A Payment Link checkout finished. The mod opened it with
    // ?client_reference_id=<player id>; anything else is not a BugFlix sale.
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const playerId = object.client_reference_id
      if (typeof playerId !== 'string' || !UUID.test(playerId)) {
        return null
      }
      // Bank debits and the like settle later, as async_payment_succeeded.
      if (object.payment_status === 'unpaid') {
        return null
      }

      return {
        by: 'checkout',
        playerId,
        customerId: idOf(object.customer),
        subscriptionId: idOf(object.subscription),
      }
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscriptionId = idOf(object.id)

      return subscriptionId === null ? null : { by: 'subscription', subscriptionId }
    }
    default:
      return null
  }
}

// The RPC to make, given whether the subscription is live now. A checkout
// with no subscription is a one-off (lifetime) purchase.
export function toRpc(update: ProUpdate, isLiveNow: boolean): Rpc {
  return update.by === 'checkout'
    ? {
        fn: 'bf_stripe_checkout',
        args: {
          p_player: update.playerId,
          p_customer: update.customerId,
          p_subscription: update.subscriptionId,
          p_is_live: update.subscriptionId === null ? true : isLiveNow,
        },
      }
    : { fn: 'bf_stripe_subscription', args: { p_subscription: update.subscriptionId, p_is_live: isLiveNow } }
}
