// Stripe webhook: keeps Pro in step with payments, through the
// bf_stripe_checkout and bf_stripe_subscription functions in the migration.
//
// Deploy:  supabase functions deploy stripe-webhook --no-verify-jwt
// Secrets: supabase secrets set STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_...
// Stripe:  Developers > Webhooks > add https://<project>.supabase.co/functions/v1/stripe-webhook
//          for checkout.session.completed, checkout.session.async_payment_succeeded,
//          customer.subscription.updated and customer.subscription.deleted.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set by Supabase itself.

import { createClient } from 'npm:@supabase/supabase-js@2.117.2'
import Stripe from 'npm:stripe@22.6.2'

import { decide, isLive, toRpc } from './handler.ts'
import type { ProUpdate } from './handler.ts'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '')
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') ?? ''
const cryptoProvider = Stripe.createSubtleCryptoProvider()
const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
  auth: { persistSession: false },
})

// Records the update with the subscription's status as Stripe reports it now,
// so a late or retried event can never undo a newer change. Returns whether a
// player or subscription row matched.
async function apply(update: ProUpdate): Promise<boolean> {
  const isLiveNow =
    update.subscriptionId === null ? true : isLive((await stripe.subscriptions.retrieve(update.subscriptionId)).status)
  const { fn, args } = toRpc(update, isLiveNow)
  const { data, error } = await supabase.rpc(fn, args)
  if (error) {
    throw new Error(`${fn} failed: ${error.message}`)
  }

  return data === true
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
  if (update === null) {
    return Response.json({ received: true, applied: false })
  }

  try {
    const matched = await apply(update)
    if (!matched) {
      console.warn(`${event.type} ${event.id}: no BugFlix player or subscription matched`)
    }

    return Response.json({ received: true, applied: matched })
  } catch (error) {
    console.error(error)

    // A 5xx makes Stripe retry the event later.
    return new Response('Update failed', { status: 500 })
  }
})
