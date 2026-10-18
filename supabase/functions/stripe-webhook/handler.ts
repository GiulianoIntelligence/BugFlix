// What a Stripe event means for a BugFlix player, apart from Stripe's and
// Supabase's clients so it can be tested on its own (handler_test.ts).

export type ProUpdate =
  | {
      by: 'player'
      playerId: string
      isPro: true
      customerId: string | null
      subscriptionId: string | null
    }
  | { by: 'subscription'; subscriptionId: string; isPro: boolean }

export type StripeEventLike = {
  type: string
  data: { object: Record<string, unknown> }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Subscription statuses that keep Pro on. past_due keeps it while Stripe
// retries the card; Stripe ends the subscription if the retries fail.
const LIVE = new Set(['active', 'trialing', 'past_due'])

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
        by: 'player',
        playerId,
        isPro: true,
        customerId: idOf(object.customer),
        subscriptionId: idOf(object.subscription),
      }
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscriptionId = idOf(object.id)
      if (subscriptionId === null) {
        return null
      }

      return {
        by: 'subscription',
        subscriptionId,
        isPro: event.type === 'customer.subscription.updated' && LIVE.has(String(object.status)),
      }
    }
    default:
      return null
  }
}
