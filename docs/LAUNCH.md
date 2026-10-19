# Launching BugFlix

How BugFlix can earn a steady four-figure monthly income. These are planning numbers, not a promise. The code takes payments; players come from distribution, and distribution is most of the work.

## Revenue math

Pro is $4.99/month. After Stripe's card fee (about 2.9% + 30¢ in the US) and Stripe Billing's fee on subscriptions, roughly **$4.50** of each payment reaches you. Check your own Stripe pricing page.

| Monthly goal | Paying subscribers | Weekly players needed at 3% conversion |
| --- | --- | --- |
| $1,000 | ~225 | ~7,500 |
| $3,000 | ~670 | ~22,000 |
| $5,000 | ~1,100 | ~37,000 |

Freemium developer tools commonly convert a few percent of active users. Three ways to move the numbers:

- **Annual plan** ($39/year, about 35% off): cash up front and much lower churn. Add a yearly price to the BugFlix Pro product and turn on Stripe's upsell from the monthly price to it (or allow plan switching in the customer portal). The existing Payment Link then offers annual billing and still passes the player id, so the webhook needs no change. Don't share a separate Payment Link outside the mod: a purchase made without the mod's `client_reference_id` can't be matched to a player, so the buyer would never get Pro.
- **Team rooms**: rooms are Pro-only to create, so a team lead pays and the whole team plays. A later "Team" price (say $19/month for a room of 10) is a natural upsell.
- **Sponsored packs**: AI tool companies want developers to learn their APIs. A sponsored pack ("This week's MCP pack, brought to you by …") is a separate income line that doesn't depend on conversion. A handful of sponsors at a few hundred dollars each could matter more than subscriptions early on.

## Costs

- Supabase: the free tier is enough to launch. Move to the Pro plan (about $25/month) once you have real traffic or need daily backups.
- Stripe: fees only, no monthly cost.
- Your time writing questions. Budget one 20-question pack a week, since fresh content is what Pro subscribers pay for.

## Launch checklist

1. Make the repository public so `/plugin install bugflix --marketplace GiulianoIntelligence/BugFlix` works for everyone.
2. Do the owner setup in the README in Stripe **test mode**, then buy Pro with the test card `4242 4242 4242 4242` and check that `/bugflix refresh` shows ✨Pro.
3. Switch Stripe to live mode: new live keys, a live Payment Link, the customer portal turned on in live mode, and the live webhook secret. Put the live Payment Link and the live portal login link (no `test_` in the URL) in `src/config.ts`, then ship (README step 4).
4. Add a short terms-of-service and privacy page and link it from the Payment Link. BugFlix stores a hash of a random token, a handle, scores and per-question answer history with timestamps, room membership and a last-seen time. For Pro players it also stores Stripe customer and subscription IDs, which link the account to Stripe's record of the buyer's email and billing details. Stripe handles all card data.
5. Record a 20-second screen capture: a prompt, the pane popping up, a correct answer with a 🔥 streak, Claude finishing, the pane vanishing.

## Getting players

- **Show HN / Reddit / X**: lead with the GIF and the one-line install. "Trivia that plays while Claude Code works" explains itself.
- **Claude Code communities and plugin marketplaces**: list BugFlix wherever Claude Code plugins are collected.
- **Weekly leaderboard posts**: every Monday, post last week's top 10 (handles only). It's free content and gives players a reason to come back.
- **Team challenges**: invite engineering teams to a room-vs-room week. One Pro lead brings a whole team.
- **Your own audience**: every pack is a post. "5 MCP facts most devs get wrong" works as a tweet and links back to the game.

## What to watch

- Weekly active players and questions answered per player.
- How many players hit the free limit, and how many of those upgrade.
- Churn after the first and second month. If people cancel, ship packs more often.
- Leaderboard weirdness: rename or reset abusive handles with SQL (`update bf_players set handle = … where …`).

## Brand and policy

- Keep "Claude" out of the product name and logo. "BugFlix, a trivia game for Claude Code" is descriptive; "Claude Trivia" is not. Read Anthropic's brand guidelines and terms before you market it.
- Keep the questions accurate. Claude Code and the APIs change, so review the starter pack every few months and fix anything stale. Wrong answers are bad for a learning game.
