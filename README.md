# BugFlix 🎬

**Binge-worthy AI trivia that plays in a Claude Code side pane while Claude works, and gets out of the way the moment it's done.**

Light, funny multiple-choice questions about Claude Code, LLM APIs, prompting, agents & MCP, and dev lore. Weekly leaderboards, team rooms, streaks, and a Pro tier billed through Stripe. There's no app to install: it's a Claude Code plugin (a "mod").

```
╭─ BugFlix ─────────────────────────────╮
│ 🎬 BugFlix · Context Wrangler          │
│ 1,240 pts · 🔥4 · 31/40 right          │
│                                       │
│ LLM APIs · ★☆☆                         │
│ HTTP 429 means…                       │
│                                       │
│ 1: Created successfully               │
│ 2: Too Many Requests: slow down       │
│ 3: The model is tired                 │
│ 4: Payment required                   │
│                                       │
│ 🏆 #12 this week · 🟢 37 playing       │
│ t: Top  p: Pro  h: Help  x: Off        │
╰───────────────────────────────────────╯
```

## Install

At the Claude Code prompt:

```
/plugin install bugflix --marketplace GiulianoIntelligence/BugFlix
```

Answer `y` to add the marketplace, then pick a scope (user scope = every project). From a shell instead: `claude plugin install bugflix --marketplace GiulianoIntelligence/BugFlix`. In the desktop app: click **+** next to the prompt, then **Plugins**, **Add marketplace** with `GiulianoIntelligence/BugFlix`, then **Add plugin**.

The repository has to be readable by whoever installs it, so make it public before you share it.

## How it plays

- **It follows Claude.** When Claude starts working on your prompt, the pane pops up. The moment Claude finishes (or you interrupt it), the pane closes and a one-line status shows your score: `🎬 BugFlix paused · 1,240 pts · 🔥4`.
- **It never covers Claude.** Claude Code places the pane. In the fullscreen layout it docks beside the transcript (110+ columns); otherwise it sits above the prompt box. Your transcript, Claude's reasoning and your prompt stay visible. Claude Code picks the side; BugFlix only asks for 46 columns docked or 16 rows above the prompt.
- **It resumes where you left off.** An unanswered question, your score and your streak survive closing the pane, the next turn, and restarting Claude Code.
- **Subagents don't trigger it.** Only your main conversation's turns do.
- **Narrow terminal?** Claude Code only auto-places panes in wide terminals. Run `/bugflix` once to open it yourself. After that it pops up on its own from 110 columns.

### Controls

Click an answer, or press **ctrl+x tab** to move into the pane and use the keys: **1–4** answer, **n** next, **t** leaderboard, **p** Pro, **h** help, **x** off, **b** back. **Esc** returns to your prompt.

| Command | What it does |
| --- | --- |
| `/bugflix` | Show or hide the pane right now |
| `/bugflix off` · `/bugflix on` | Stop or restart the automatic pop-up (remembered across sessions) |
| `/bugflix 1`…`4` | Answer (also `a`–`d`) |
| `/bugflix next` | Next question |
| `/bugflix top` | This week's leaderboard |
| `/bugflix name <you>` | Your leaderboard name |
| `/bugflix room join <CODE>` · `room new <name>` · `room leave` | Team rooms |
| `/bugflix pro` | Upgrade link, or manage your subscription |
| `/bugflix refresh` | Re-check your account (after paying) |
| `/bugflix stats` · `/bugflix help` | Your stats · all commands |

`/bf` is short for `/bugflix`. Answering by command while the pane is open adds nothing to the conversation Claude reads.

### Scoring

100 / 150 / 200 points for easy / medium / hard, plus 10 per answer in your current streak (up to +100). Titles go from *Prompt Padawan* to *10x Vibe Coder*. Leaderboards reset every Monday (UTC).

### Free and Pro

| | Free | Pro |
| --- | --- | --- |
| Questions | 20 a day | Unlimited |
| Packs | Starter pack | Every pack, as it drops |
| Leaderboards | ✓ | ✓ with a ✨ |
| Rooms | Join | Create and join |

Without a server configured, BugFlix runs fully offline on the 88-question starter pack with a local score.

## Running the BugFlix service (owner setup)

You need a Supabase project and a Stripe account. Do everything in Stripe **test mode** first.

### 1. Supabase

```bash
supabase link --project-ref <your-project-ref>
supabase db push                                   # creates tables + bf_* functions
psql "$DATABASE_URL" -f supabase/seed.sql          # the 88-question starter pack
psql "$DATABASE_URL" -f supabase/packs/001-pro-launch.sql   # the first Pro pack
```

You can also paste those files into the SQL editor. Then copy the **project URL** and the **anon** (or `sb_publishable_…`) key into `src/config.ts`. Both are meant to be public: every table is locked by row-level security, and the key can only call the `bf_*` functions.

### 2. Stripe

1. Create a product **BugFlix Pro** with a recurring price, for example $4.99/month (and optionally a yearly price).
2. Create a **Payment Link** for it. Under *After payment*, show a confirmation message such as "You're Pro! Run `/bugflix refresh` in Claude Code."
3. Turn on the **customer portal** and copy its login link.
4. Put both links in `src/config.ts` (`stripePaymentLink`, `stripePortalLink`) and set `priceLabel`.

BugFlix opens the Payment Link with `?client_reference_id=<player id>`, which is how the webhook knows who paid.

### 3. The webhook

```bash
supabase functions deploy stripe-webhook --no-verify-jwt
supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_WEBHOOK_SECRET=whsec_...
```

In Stripe, under Developers → Webhooks, add `https://<project-ref>.supabase.co/functions/v1/stripe-webhook` with these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.updated` and `customer.subscription.deleted`. Paying turns Pro on, and cancelling or failed renewals turn it off.

### 4. Ship it

Bump `version` in `.claude-plugin/plugin.json`, commit and push. Players get it with `claude plugin update bugflix`.

### Adding question packs

Copy `supabase/packs/001-pro-launch.sql`, give the questions new ids, and run it against the database. Subscribers see the new pack immediately, with no plugin update. Keep `is_free = false` for Pro content. To change the free starter pack, edit `src/questions.ts`, then run `npm run seed` and apply `supabase/seed.sql`. The free daily limit is `bf_free_daily()` in the migration; keep `freeDailyQuestions` in `src/config.ts` in step with it.

## Development

```bash
claude --plugin-dir .        # run Claude Code with this folder as a plugin; saves hot-reload
npm test                     # 28 mod tests (claude plugin test) + webhook tests
npm run validate             # claude plugin validate
npm run check:server         # bf_* behaviour checks against $DATABASE_URL (rolled back)
```

To point the mod at a local `supabase start`, set `BUGFLIX_SUPABASE_URL=http://127.0.0.1:54321` and `BUGFLIX_SUPABASE_KEY=<local anon key>` before launching Claude Code.

| Path | What it is |
| --- | --- |
| `hooks/register.tsx` | The mod: pane, commands, turn hooks |
| `src/game.ts` | Dealing, scoring, levels, banter (pure, tested) |
| `src/questions.ts` | The free starter pack |
| `src/backend.ts` | Supabase RPC client |
| `src/config.ts` | Your server and Stripe links |
| `types/index.d.ts` | The mod's state contract |
| `supabase/migrations/` | Tables, RLS, and the `bf_*` functions |
| `supabase/packs/` | Pro question packs |
| `supabase/functions/stripe-webhook/` | Stripe → `is_pro` |
| `docs/LAUNCH.md` | Pricing, revenue math and a launch plan |

### Security notes

- Players are anonymous: the mod generates a random 64-hex token and the server stores only its SHA-256.
- Answers are checked on the server, and the client never receives them for online questions. Points, streaks and the free limit can't be faked from a modified client.
- The starter pack's answers ship in the plugin source, so they're public. That's fine for practice, but leaderboard integrity comes from the daily limit and Pro content.
- The webhook verifies Stripe's signature over the raw body before it trusts anything.

## License

MIT
