-- Behaviour checks for the bf_* RPCs. Run against a database that has the
-- migration, seed.sql and packs/ applied (any throwaway Postgres 15+ with
-- the anon/authenticated roles), e.g.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/checks/rpc_checks.sql
-- Everything runs in a transaction that is rolled back at the end.

begin;

create function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin
  if not ok then
    raise exception 'CHECK FAILED: %', what;
  end if;
end $$;

create function pg_temp.expect_error(statement text, code text) returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'CHECK FAILED: % should have raised %', statement, code;
exception when others then
  if sqlerrm <> code then
    raise exception 'CHECK FAILED: % raised "%" instead of %', statement, sqlerrm, code;
  end if;
end $$;

do $$
declare
  alice text := repeat('a', 64);
  bob text := repeat('b', 64);
  me jsonb;
  card jsonb;
  reply jsonb;
  first_card text;
  right_choice integer;
  i integer;
  board jsonb;
  code text;
begin
  -- Sign-up is idempotent per token; a taken name gets a suffix.
  me := bf_register(alice, 'AsyncDuck42');
  perform pg_temp.expect(me->>'handle' = 'AsyncDuck42', 'alice keeps her name');
  perform pg_temp.expect((me->>'free_left')::int = 20, 'a new player has 20 free questions');
  perform pg_temp.expect(bf_register(alice, 'Other')->>'id' = me->>'id', 'same token, same player');
  perform pg_temp.expect(bf_register(bob, 'asyncduck42')->>'handle' ~ '^asyncduck42\d{6}$', 'case-insensitive clash gets a suffix');
  perform pg_temp.expect_error(format('select bf_me(%L)', repeat('z', 64)), 'unknown_player');

  -- Dealing: no answer leaks, the waiting card comes back until answered.
  reply := bf_next(alice);
  card := reply->'card';
  first_card := card->>'id';
  perform pg_temp.expect(not (card ? 'answer'), 'the card carries no answer');
  perform pg_temp.expect(jsonb_array_length(card->'choices') = 4, 'four choices');
  perform pg_temp.expect((reply->'me'->>'free_left')::int = 19, 'a dealt card uses a free question');
  perform pg_temp.expect(bf_next(alice)->'card'->>'id' = first_card, 'the waiting card is resumed');
  perform pg_temp.expect(exists (select 1 from bf_questions where id = first_card and is_free), 'free players get free packs');

  -- A wrong answer scores nothing; answering twice is refused.
  select (answer + 1) % 4 into right_choice from bf_questions where id = first_card;
  reply := bf_answer(alice, first_card, right_choice);
  perform pg_temp.expect(reply->>'is_correct' = 'false' and (reply->>'points')::int = 0, 'wrong scores 0');
  perform pg_temp.expect((reply->'me'->>'streak')::int = 0, 'wrong resets the streak');
  perform pg_temp.expect_error(format('select bf_answer(%L, %L, 0)', alice, first_card), 'no_pending');
  perform pg_temp.expect_error(format('select bf_answer(%L, %L, 7)', alice, first_card), 'bad_choice');

  -- Three right answers in a row: base points plus 10 per streak step held.
  for i in 0..2 loop
    card := bf_next(alice)->'card';
    perform pg_temp.expect(card->>'id' <> first_card, 'unseen questions come first');
    select answer into right_choice from bf_questions where id = card->>'id';
    reply := bf_answer(alice, card->>'id', right_choice);
    perform pg_temp.expect(reply->>'is_correct' = 'true', 'right is right');
    perform pg_temp.expect(
      (reply->>'points')::int = (case (card->>'difficulty')::int when 1 then 100 when 2 then 150 else 200 end) + i * 10,
      format('points for streak step %s', i)
    );
  end loop;
  me := bf_me(alice);
  perform pg_temp.expect((me->>'streak')::int = 3 and (me->>'best_streak')::int = 3, 'streak of 3');
  perform pg_temp.expect((me->>'weekly')::int = (me->>'total')::int, 'all points are this week''s');

  -- The free limit: 20 cards a day, then the upsell.
  for i in 1..16 loop
    card := bf_next(alice)->'card';
    perform bf_answer(alice, card->>'id', 0);
  end loop;
  reply := bf_next(alice);
  perform pg_temp.expect(reply->>'limited' = 'true' and reply->'card' = 'null'::jsonb, 'limited after 20');
  perform pg_temp.expect((reply->'me'->>'free_left')::int = 0, 'no free questions left');

  -- Pro: unlimited, Pro packs, rooms.
  update bf_players set is_pro = true where token_hash = bf_hash(alice);
  reply := bf_next(alice);
  perform pg_temp.expect(reply->>'limited' = 'false', 'Pro is unlimited');
  perform pg_temp.expect(reply->'me'->'free_left' = 'null'::jsonb, 'Pro has no free counter');
  perform bf_answer(alice, reply->'card'->>'id', 0);

  perform pg_temp.expect_error(format('select bf_room_create(%L, %L)', bob, 'Rocket'), 'pro_only');
  me := bf_room_create(alice, '  Team Rocket  ');
  code := me->'room'->>'code';
  perform pg_temp.expect(code ~ '^[0-9A-F]{6}$' and me->'room'->>'name' = 'Team Rocket', 'room created');
  perform pg_temp.expect_error(format('select bf_room_join(%L, %L)', bob, 'NOPE00'), 'no_room');
  perform pg_temp.expect(bf_room_join(bob, lower(code))->'room'->>'code' = code, 'bob joins by code');

  -- Leaderboards.
  card := bf_next(bob)->'card';
  select answer into right_choice from bf_questions where id = card->>'id';
  perform bf_answer(bob, card->>'id', right_choice);
  board := bf_board(alice, 'global');
  perform pg_temp.expect((board->>'my_rank')::int = 1, 'alice leads');
  perform pg_temp.expect((board->'rows'->0->>'is_me')::boolean, 'her row is marked');
  perform pg_temp.expect((board->>'playing_now')::int >= 2, 'both are playing now');
  board := bf_board(bob, 'room');
  perform pg_temp.expect(jsonb_array_length(board->'rows') = 2 and (board->>'my_rank')::int = 2, 'room board');
  perform bf_room_leave(bob);
  perform pg_temp.expect(jsonb_array_length(bf_board(bob, 'room')->'rows') = 0, 'no room, empty room board');

  -- Names.
  perform pg_temp.expect_error(format('select bf_set_handle(%L, %L)', bob, 'x'), 'bad_handle');
  perform pg_temp.expect_error(format('select bf_set_handle(%L, %L)', bob, 'ASYNCDUCK42'), 'handle_taken');
  perform pg_temp.expect(bf_set_handle(bob, 'RogueLinter7')->>'handle' = 'RogueLinter7', 'rename');
end $$;

-- The anon key reaches the RPCs and nothing else.
set local role anon;

do $$
begin
  perform pg_temp.expect(bf_me(repeat('a', 64))->>'handle' = 'AsyncDuck42', 'anon can call the RPCs');
  perform pg_temp.expect_error('select count(*) from bf_players', 'permission denied for table bf_players');
  perform pg_temp.expect_error('select answer from bf_questions limit 1', 'permission denied for table bf_questions');
  perform pg_temp.expect_error('update bf_players set is_pro = true', 'permission denied for table bf_players');
  perform pg_temp.expect_error(format('select bf_hash(%L)', 'x'), 'permission denied for function bf_hash');
  perform pg_temp.expect_error(format('select bf_player(%L)', repeat('a', 64)), 'permission denied for function bf_player');
end $$;

reset role;

select 'all bf_* checks passed' as result;

rollback;
