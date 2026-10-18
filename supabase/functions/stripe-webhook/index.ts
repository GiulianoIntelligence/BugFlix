// Stripe webhook: keeps bf_players.is_pro in step with payments.
//
// Deploy:  supabase functions deploy stripe-webhook --no-verify-jwt
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_...
// Stripe:  Developers > Webhooks > add https://<project>.supabase.co/functions/v1/stripe-webhook
//          for checkout.session.completed, checkout.session.async_payment_succeeded,
//          customer.subscription.updated and customer.subscription.deleted.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set by Supabase itself.

import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import Stripe from 'npm:stripe@22.6.2'

import { decide } from './handler.ts'
import type { ProUpdate } from './handler.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '')
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''
const cryptoProvider = Stripe.createSubtleCryptoProvider()
const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
  auth: { persistSession: false },
})

async function apply(update: ProUpdate): Promise<void> {
  const query =
    update.by === 'player'
      ? supabase
          .from('bf_players')
          .update({
            is_pro: true,
            stripe_customer_id: update.customerId,
            stripe_subscription_id: update.subscriptionId,
          })
          .eq('id', update.playerId)
      : supabase.from('bf_players').update({ is_pro: update.isPro }).eq('stripe_subscription_id', update.subscriptionId)

  const { error } = await query
  if (error) {
    throw new Error(`bf_players update failed: ${error.message}`)
  }
}

Deno.serve(async request => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }
  const signature = request.headers.get('stripe-signature')
  if (signature === null) {
    return new Response('Missing Stripe-Signature', { status: 400 })
  }

  // The signature covers the raw body: verify before parsing anything.
  let event: Stripe.Event
  try {
    event = await stripe.webhooks.constructEventAsync(
      await request.text(),
      signature,
      webhookSecret,
      undefined,
      cryptoProvider,
    )
  } catch (error) {
    return new Response(`Bad signature: ${error instanceof Error ? error.message : 'unknown'}`, { status: 400 })
  }

  const update = decide(event as unknown as Parameters<typeof decide>[0])
  if (update !== null) {
    try {
      await apply(update)
    } catch (error) {
      console.error(error)

      // A 5xx makes Stripe retry the event later.
      return new Response('Update failed', { status: 500 })
    }
  }

  return Response.json({ received: true, applied: update !== null })
})
