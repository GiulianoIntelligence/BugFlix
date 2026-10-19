-- BugFlix server: players, questions, answers and rooms, and the bf_* RPCs the
-- mod calls with the project's anon (publishable) key.
--
-- Every table has RLS on and no policy, and anon/authenticated hold no table
-- privileges: the anon key reaches data only through the SECURITY DEFINER
-- functions at the bottom. The server checks every submitted answer and
-- enforces the free daily limit, on UTC days whatever time zone a caller asks
-- for. Starter-pack answers ship inside the mod, so points on free questions
-- are not protected against a modified mod; Pro packs live only here.
-- A player is a random 64-hex token the mod keeps; only its SHA-256 is stored.

create table public.bf_rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  owner_id uuid,
  created_at timestamptz not null default now()
);

create table public.bf_players (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  handle text not null check (handle ~ '^[A-Za-z0-9_-]{3,20}$'),
  is_pro boolean not null default false,
  is_lifetime boolean not null default false,
  room_id uuid references public.bf_rooms (id) on delete set null,
  total integer not null default 0,
  streak integer not null default 0,
  best_streak integer not null default 0,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

alter table public.bf_rooms
  add constraint bf_rooms_owner_fk foreign key (owner_id) references public.bf_players (id) on delete set null;

create unique index bf_players_handle_lower on public.bf_players (lower(handle));
create index bf_players_last_seen on public.bf_players (last_seen);
create index bf_players_room on public.bf_players (room_id);

-- Stripe subscriptions, one row each. A player who pays twice has two, and is
-- Pro while any of them is live (or after a one-off, lifetime purchase).
create table public.bf_subscriptions (
  id text primary key,
  player_id uuid not null references public.bf_players (id) on delete cascade,
  customer_id text,
  is_live boolean not null,
  updated_at timestamptz not null default now()
);

create index bf_subscriptions_player on public.bf_subscriptions (player_id);

create table public.bf_questions (
  id text primary key,
  pack text not null default 'starter',
  is_free boolean not null default true,
  category text not null check (category in ('claude-code', 'llm-apis', 'prompting', 'agents-mcp', 'dev-lore')),
  difficulty smallint not null check (difficulty between 1 and 3),
  prompt text not null,
  choices jsonb not null check (jsonb_typeof(choices) = 'array' and jsonb_array_length(choices) = 4),
  answer smallint not null check (answer between 0 and 3),
  quip text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.bf_answers (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.bf_players (id) on delete cascade,
  question_id text not null references public.bf_questions (id) on delete cascade,
  served_at timestamptz not null default now(),
  answered_at timestamptz,
  choice smallint,
  is_correct boolean,
  points integer not null default 0
);

-- One card waiting for an answer per player: what lets a closed pane resume.
create unique index bf_answers_one_pending on public.bf_answers (player_id) where answered_at is null;
create index bf_answers_player_question on public.bf_answers (player_id, question_id);
create index bf_answers_player_served on public.bf_answers (player_id, served_at);
create index bf_answers_answered on public.bf_answers (answered_at) where answered_at is not null;

alter table public.bf_rooms enable row level security;
alter table public.bf_players enable row level security;
alter table public.bf_questions enable row level security;
alter table public.bf_answers enable row level security;
alter table public.bf_subscriptions enable row level security;

revoke all on public.bf_rooms, public.bf_players, public.bf_questions, public.bf_answers, public.bf_subscriptions
from anon, authenticated;

-- Knobs ---------------------------------------------------------------------

-- Questions a free player is dealt per UTC day. Mirror CONFIG.freeDailyQuestions.
create or replace function public.bf_free_daily() returns integer
language sql immutable as $$ select 20 $$;

-- Internal helpers (not callable with the anon key) -------------------------

create or replace function public.bf_hash(p_token text) returns text
language sql immutable as $$ select encode(sha256(convert_to(p_token, 'UTF8')), 'hex') $$;

-- The player behind a token, touching last_seen at most once a minute.
create or replace function public.bf_player(p_token text) returns public.bf_players
language plpgsql as $$
declare
  v public.bf_players;
begin
  if p_token is null or length(p_token) < 32 then
    raise exception 'unknown_player';
  end if;
  select * into v from public.bf_players where token_hash = public.bf_hash(p_token);
  if not found then
    raise exception 'unknown_player';
  end if;
  if v.last_seen < now() - interval '1 minute' then
    update public.bf_players set last_seen = now() where id = v.id returning * into v;
  end if;
  return v;
end $$;

create or replace function public.bf_me_json(v public.bf_players) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'id', v.id,
    'handle', v.handle,
    'is_pro', v.is_pro,
    'total', v.total,
    'weekly', coalesce((
      select sum(a.points) from public.bf_answers a
      where a.player_id = v.id and a.answered_at >= date_trunc('week', now(), 'UTC')
    ), 0),
    'streak', v.streak,
    'best_streak', v.best_streak,
    'free_left', case when v.is_pro then null else greatest(0, public.bf_free_daily() - (
      select count(*) from public.bf_answers a
      where a.player_id = v.id and a.served_at >= date_trunc('day', now(), 'UTC')
    )) end,
    'rank_weekly', null,
    'room', (select jsonb_build_object('code', r.code, 'name', r.name) from public.bf_rooms r where r.id = v.room_id)
  )
$$;

-- RPCs the mod calls --------------------------------------------------------

create or replace function public.bf_register(p_token text, p_handle text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v bf_players;
  v_base text := case when p_handle ~ '^[A-Za-z0-9_-]{3,20}$' then p_handle else 'player' end;
  v_handle text := v_base;
  v_tries integer := 0;
begin
  if p_token is null or length(p_token) < 32 or length(p_token) > 200 then
    raise exception 'bad_token';
  end if;
  loop
    select * into v from bf_players where token_hash = bf_hash(p_token);
    if found then
      return bf_me_json(v);
    end if;
    begin
      insert into bf_players (token_hash, handle) values (bf_hash(p_token), v_handle) returning * into v;
      return bf_me_json(v);
    exception when unique_violation then
      -- The token raced another sign-up (the loop finds it), or the name is taken.
      v_tries := v_tries + 1;
      if v_tries > 10 then
        raise exception 'handle_taken';
      end if;
      v_handle := left(v_base, 14) || (floor(random() * 900000) + 100000)::integer::text;
    end;
  end loop;
end $$;

create or replace function public.bf_me(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return bf_me_json(bf_player(p_token));
end $$;

-- The card waiting for an answer, else a fresh one: unseen first, then the one
-- seen longest ago. Free players get free packs and bf_free_daily() a day.
create or replace function public.bf_next(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v bf_players := bf_player(p_token);
  q bf_questions;
begin
  select qq.* into q
  from bf_answers a join bf_questions qq on qq.id = a.question_id
  where a.player_id = v.id and a.answered_at is null;

  if not found then
    if not v.is_pro and (
      select count(*) from bf_answers a where a.player_id = v.id and a.served_at >= date_trunc('day', now(), 'UTC')
    ) >= bf_free_daily() then
      return jsonb_build_object('limited', true, 'card', null, 'me', bf_me_json(v));
    end if;

    select qq.* into q from bf_questions qq
    where qq.is_active and (v.is_pro or qq.is_free)
      and not exists (select 1 from bf_answers a where a.player_id = v.id and a.question_id = qq.id)
    order by random()
    limit 1;

    if not found then
      select qq.* into q from bf_questions qq
      where qq.is_active and (v.is_pro or qq.is_free)
      order by (select max(a.served_at) from bf_answers a where a.player_id = v.id and a.question_id = qq.id)
        nulls first, random()
      limit 1;
    end if;

    if not found then
      raise exception 'no_questions';
    end if;

    insert into bf_answers (player_id, question_id) values (v.id, q.id)
    on conflict (player_id) where answered_at is null do nothing;

    -- Another terminal dealt first: hand back its card.
    select qq.* into q
    from bf_answers a join bf_questions qq on qq.id = a.question_id
    where a.player_id = v.id and a.answered_at is null;
  end if;

  return jsonb_build_object(
    'limited', false,
    'card', jsonb_build_object(
      'id', q.id, 'category', q.category, 'difficulty', q.difficulty, 'prompt', q.prompt, 'choices', q.choices
    ),
    'me', bf_me_json(v)
  );
end $$;

-- Scores the waiting card. Points mirror pointsFor() in src/game.ts.
create or replace function public.bf_answer(p_token text, p_question text, p_choice integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v bf_players := bf_player(p_token);
  q bf_questions;
  v_answer_id bigint;
  v_correct boolean;
  v_points integer := 0;
  v_streak integer := 0;
begin
  if p_choice is null or p_choice < 0 or p_choice > 3 then
    raise exception 'bad_choice';
  end if;

  select a.id into v_answer_id from bf_answers a
  where a.player_id = v.id and a.question_id = p_question and a.answered_at is null
  for update;
  if not found then
    raise exception 'no_pending';
  end if;

  select * into q from bf_questions where id = p_question;
  v_correct := p_choice = q.answer;
  if v_correct then
    v_points := case q.difficulty when 1 then 100 when 2 then 150 else 200 end + least(v.streak * 10, 100);
    v_streak := v.streak + 1;
  end if;

  update bf_answers
  set answered_at = now(), choice = p_choice, is_correct = v_correct, points = v_points
  where id = v_answer_id;

  update bf_players
  set total = total + v_points, streak = v_streak, best_streak = greatest(best_streak, v_streak), last_seen = now()
  where id = v.id
  returning * into v;

  return jsonb_build_object(
    'is_correct', v_correct, 'answer', q.answer, 'points', v_points, 'quip', q.quip, 'me', bf_me_json(v)
  );
end $$;

-- This week's top 10 (UTC weeks start Monday), globally or in the player's
-- room, their own rank, and how many players were active in 5 minutes.
create or replace function public.bf_board(p_token text, p_scope text default 'global') returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v bf_players := bf_player(p_token);
  v_rows jsonb;
  v_rank bigint;
  v_playing bigint;
begin
  with weekly as (
    select p.id, p.handle, p.is_pro, sum(a.points) as score
    from bf_answers a join bf_players p on p.id = a.player_id
    where a.answered_at >= date_trunc('week', now(), 'UTC')
      and (p_scope <> 'room' or (v.room_id is not null and p.room_id = v.room_id))
    group by p.id, p.handle, p.is_pro
    having sum(a.points) > 0
  ), ranked as (
    select weekly.*, rank() over (order by score desc) as place from weekly
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object('rank', place, 'handle', handle, 'weekly', score, 'is_pro', is_pro, 'is_me', id = v.id)
        order by place, handle
      ) filter (where place <= 10),
      '[]'::jsonb
    ),
    max(place) filter (where id = v.id)
  into v_rows, v_rank
  from ranked;

  select count(*) into v_playing from bf_players where last_seen > now() - interval '5 minutes';

  return jsonb_build_object('rows', v_rows, 'my_rank', v_rank, 'playing_now', v_playing);
end $$;

create or replace function public.bf_set_handle(p_token text, p_handle text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v bf_players := bf_player(p_token);
begin
  if p_handle is null or p_handle !~ '^[A-Za-z0-9_-]{3,20}$' then
    raise exception 'bad_handle';
  end if;
  begin
    update bf_players set handle = p_handle where id = v.id returning * into v;
  exception when unique_violation then
    raise exception 'handle_taken';
  end;
  return bf_me_json(v);
end $$;

-- Rooms: Pro players create them (a team lead pays, the team joins free).
create or replace function public.bf_room_create(p_token text, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v bf_players := bf_player(p_token);
  v_room uuid;
  v_name text := left(coalesce(nullif(btrim(p_name), ''), 'My team'), 40);
begin
  if not v.is_pro then
    raise exception 'pro_only';
  end if;
  loop
    insert into bf_rooms (code, name, owner_id)
    values (upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6)), v_name, v.id)
    on conflict (code) do nothing
    returning id into v_room;
    exit when v_room is not null;
  end loop;
  update bf_players set room_id = v_room where id = v.id returning * into v;
  return bf_me_json(v);
end $$;

create or replace function public.bf_room_join(p_token text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v bf_players := bf_player(p_token);
  v_room uuid;
begin
  select id into v_room from bf_rooms where code = upper(btrim(coalesce(p_code, '')));
  if not found then
    raise exception 'no_room';
  end if;
  update bf_players set room_id = v_room where id = v.id returning * into v;
  return bf_me_json(v);
end $$;

create or replace function public.bf_room_leave(p_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v bf_players := bf_player(p_token);
begin
  update bf_players set room_id = null where id = v.id returning * into v;
  return bf_me_json(v);
end $$;

-- Payments (called by the stripe-webhook function with the service role) ---

-- Pro while the player bought lifetime or holds any live subscription.
create or replace function public.bf_sync_pro(p_player uuid) returns void
language sql as $$
  update public.bf_players p
  set is_pro = p.is_lifetime or exists (
    select 1 from public.bf_subscriptions s where s.player_id = p.id and s.is_live
  )
  where p.id = p_player
$$;

-- A paid checkout for the player its client_reference_id names. p_subscription
-- is null for a one-off (lifetime) purchase; p_is_live is the subscription's
-- status as Stripe reports it now, never as an event recorded it. Returns
-- false when no such player exists.
create or replace function public.bf_stripe_checkout(
  p_player uuid, p_customer text, p_subscription text, p_is_live boolean
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from bf_players where id = p_player) then
    return false;
  end if;
  if p_subscription is null then
    update bf_players set is_lifetime = true where id = p_player;
  else
    insert into bf_subscriptions (id, player_id, customer_id, is_live)
    values (p_subscription, p_player, p_customer, p_is_live)
    on conflict (id) do update set is_live = excluded.is_live, updated_at = now();
  end if;
  perform bf_sync_pro(p_player);
  return true;
end $$;

-- A subscription changed: its status as Stripe reports it now. Returns false
-- for a subscription no checkout has recorded (yet).
create or replace function public.bf_stripe_subscription(p_subscription text, p_is_live boolean)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_player uuid;
begin
  update bf_subscriptions set is_live = p_is_live, updated_at = now()
  where id = p_subscription
  returning player_id into v_player;
  if v_player is null then
    return false;
  end if;
  perform bf_sync_pro(v_player);
  return true;
end $$;

-- Who may call what ----------------------------------------------------------

revoke execute on function
  public.bf_free_daily(),
  public.bf_hash(text),
  public.bf_player(text),
  public.bf_me_json(public.bf_players),
  public.bf_sync_pro(uuid),
  public.bf_stripe_checkout(uuid, text, text, boolean),
  public.bf_stripe_subscription(text, boolean)
from public, anon, authenticated;

grant execute on function
  public.bf_stripe_checkout(uuid, text, text, boolean),
  public.bf_stripe_subscription(text, boolean)
to service_role;

revoke execute on function
  public.bf_register(text, text),
  public.bf_me(text),
  public.bf_next(text),
  public.bf_answer(text, text, integer),
  public.bf_board(text, text),
  public.bf_set_handle(text, text),
  public.bf_room_create(text, text),
  public.bf_room_join(text, text),
  public.bf_room_leave(text)
from public;

grant execute on function
  public.bf_register(text, text),
  public.bf_me(text),
  public.bf_next(text),
  public.bf_answer(text, text, integer),
  public.bf_board(text, text),
  public.bf_set_handle(text, text),
  public.bf_room_create(text, text),
  public.bf_room_join(text, text),
  public.bf_room_leave(text)
to anon, authenticated;
