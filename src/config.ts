// The BugFlix server, set once by whoever publishes the mod. Everything here
// ships inside the plugin, so only public values belong in it:
//   - the Supabase project URL and its anon (or sb_publishable_) key, which
//     can only call the bf_* functions: every table is locked by RLS;
//   - Stripe Payment Link and customer-portal URLs, which are public pages.
// Leave supabaseUrl empty and BugFlix runs in offline mode: the starter pack,
// local scores, no leaderboards and no Pro.

export type Config = {
  supabaseUrl: string
  supabaseAnonKey: string
  stripePaymentLink: string
  stripePortalLink: string
  priceLabel: string
  freeDailyQuestions: number
}

export const CONFIG: Config = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  // A Stripe Payment Link for the Pro subscription. BugFlix appends
  // ?client_reference_id=<player id> so the webhook knows who paid.
  stripePaymentLink: '',
  // The Stripe customer portal login link, where subscribers cancel or
  // change their card.
  stripePortalLink: '',
  priceLabel: '$4.99/month',
  freeDailyQuestions: 20,
}
