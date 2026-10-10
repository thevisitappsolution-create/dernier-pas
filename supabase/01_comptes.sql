-- Lastep : comptes joueurs. La progression et l'économie (pièces, objets, pouvoirs, Premium) sont gardées sur le serveur.
-- Le client ne peut rien écrire directement : tout passe par des fonctions qui vérifient les prix et les plafonds.

create table if not exists public.lastep_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  uid text unique check (uid ~ '^[a-z0-9]{8}$'),
  coins integer not null default 100 check (coins >= 0 and coins <= 10000000),
  premium_until timestamptz,
  owned jsonb not null default '[]'::jsonb check (jsonb_typeof(owned) = 'array' and octet_length(owned::text) < 20000),
  refs jsonb not null default '[]'::jsonb check (jsonb_typeof(refs) = 'array' and octet_length(refs::text) < 4000),
  pw jsonb not null default '{}'::jsonb check (jsonb_typeof(pw) = 'object' and octet_length(pw::text) < 4000),
  progress jsonb not null default '{}'::jsonb check (jsonb_typeof(progress) = 'object' and octet_length(progress::text) < 300000),
  earn_day date not null default current_date,
  earned_today integer not null default 0,
  loot_today integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.lastep_accounts enable row level security;
drop policy if exists "lastep_accounts_read_own" on public.lastep_accounts;
create policy "lastep_accounts_read_own" on public.lastep_accounts for select to authenticated using (user_id = (select auth.uid()));

-- Prix de référence (pièces). kind : color, fur, fin, eyes, acc, trail, win, theme, ref
create table if not exists public.lastep_prices (kind text not null, id text not null, price integer not null check (price >= 0), primary key (kind, id));
alter table public.lastep_prices enable row level security;
drop policy if exists "lastep_prices_read" on public.lastep_prices;
create policy "lastep_prices_read" on public.lastep_prices for select to anon, authenticated using (true);

-- Achats en argent réel déjà crédités : une ligne par transaction, jamais deux fois
create table if not exists public.lastep_purchases (
  id text primary key,
  user_id uuid references auth.users(id) on delete set null,
  product text not null,
  coins integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.lastep_purchases enable row level security;

-- Statistiques et plantages : écriture seule
create table if not exists public.lastep_events (
  id bigint generated always as identity primary key,
  user_id uuid default auth.uid(),
  device text check (device is null or device ~ '^[a-z0-9]{8}$'),
  name text not null check (name ~ '^[a-z0-9_]{2,32}$'),
  data jsonb not null default '{}'::jsonb check (octet_length(data::text) < 2000),
  created_at timestamptz not null default now()
);
alter table public.lastep_events enable row level security;
drop policy if exists "lastep_events_insert" on public.lastep_events;
create policy "lastep_events_insert" on public.lastep_events for insert to anon, authenticated
  with check (user_id is null or user_id = (select auth.uid()));
create index if not exists lastep_events_name_time on public.lastep_events (name, created_at);

create or replace function public.lastep_pw_default() returns jsonb language sql immutable set search_path = public as $$
  select '{"push":{"n":1,"u":0},"heavy":{"n":1,"u":0},"ghost":{"n":1,"u":0},"swap":{"n":1,"u":0},"dyn":{"n":1,"u":0},"wall":{"n":1,"u":0},"jump":{"n":1,"u":0},"vision":{"n":1,"u":0}}'::jsonb;
$$;

-- Première connexion : crée le compte en reprenant la partie de cet appareil (pièces plafonnées à 5000, jamais Premium)
create or replace function public.lastep_account_open(p_uid text, p_progress jsonb, p_coins integer, p_owned jsonb, p_refs jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); acc public.lastep_accounts;
begin
  if me is null then raise exception 'not_authenticated'; end if;
  select * into acc from public.lastep_accounts where user_id = me;
  if not found then
    insert into public.lastep_accounts (user_id, uid, coins, owned, refs, pw, progress)
    values (me,
      case when p_uid ~ '^[a-z0-9]{8}$' and not exists (select 1 from public.lastep_accounts a where a.uid = p_uid) then p_uid else substr(md5(random()::text || me::text), 1, 8) end,
      least(greatest(coalesce(p_coins, 100), 0), 5000),
      case when jsonb_typeof(p_owned) = 'array' then (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from jsonb_array_elements_text(p_owned) x where exists (select 1 from public.lastep_prices pr where pr.kind || ':' || pr.id = x)) else '[]'::jsonb end,
      case when jsonb_typeof(p_refs) = 'array' then (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from jsonb_array_elements_text(p_refs) x where exists (select 1 from public.lastep_prices pr where pr.kind = 'ref' and pr.id = x)) else '[]'::jsonb end,
      public.lastep_pw_default(),
      case when jsonb_typeof(p_progress) = 'object' and octet_length(p_progress::text) < 300000 then p_progress else '{}'::jsonb end)
    returning * into acc;
  end if;
  return to_jsonb(acc) - 'earn_day' - 'earned_today' - 'loot_today';
end $$;

-- Synchronisation : l'appareil envoie ce qui a changé, le serveur vérifie et renvoie l'état officiel.
--   p_delta : variation nette des pièces sur l'appareil (gains moins dépenses)
--   p_owned : objets achetés (payés au prix du serveur)      p_loot : objets gagnés dans un coffre (6 par jour au plus)
--   p_refs  : réfs achetées      p_pwbuy : {"push":{"pack":1,"gold":0}}      p_pwuse : {"push":2}      p_progress : niveaux, badges, réglages…
-- Gains plafonnés à 3000 pièces par jour : trafiquer son téléphone ne rapporte rien de plus.
create or replace function public.lastep_sync(p_delta integer, p_owned jsonb, p_loot jsonb, p_refs jsonb, p_pwbuy jsonb, p_pwuse jsonb, p_progress jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); acc public.lastep_accounts; cap constant integer := 3000;
  cost integer := 0; earned integer; x text; k text; v jsonb; n integer; npack integer; ngold integer; pwj jsonb; nowms bigint := (extract(epoch from now()) * 1000)::bigint;
  v_owned jsonb; v_refs jsonb; loot_n integer := 0;
begin
  if me is null then raise exception 'not_authenticated'; end if;
  select * into acc from public.lastep_accounts where user_id = me for update;
  if not found then raise exception 'no_account'; end if;
  if acc.earn_day <> current_date then acc.earn_day := current_date; acc.earned_today := 0; acc.loot_today := 0; end if;
  v_owned := acc.owned; v_refs := acc.refs; pwj := coalesce(acc.pw, '{}'::jsonb);
  if jsonb_typeof(p_owned) = 'array' then
    for x in select jsonb_array_elements_text(p_owned) loop
      if not v_owned ? x then
        select price into n from public.lastep_prices where kind || ':' || id = x;
        if found then cost := cost + n; v_owned := v_owned || to_jsonb(x); end if;
      end if;
    end loop;
  end if;
  if jsonb_typeof(p_loot) = 'array' then
    for x in select jsonb_array_elements_text(p_loot) loop
      if not v_owned ? x and acc.loot_today + loot_n < 6 and exists (select 1 from public.lastep_prices where kind || ':' || id = x) then
        v_owned := v_owned || to_jsonb(x); loot_n := loot_n + 1;
      end if;
    end loop;
  end if;
  if jsonb_typeof(p_refs) = 'array' then
    for x in select jsonb_array_elements_text(p_refs) loop
      if not v_refs ? x then
        select price into n from public.lastep_prices where kind = 'ref' and id = x;
        if found then cost := cost + n; v_refs := v_refs || to_jsonb(x); end if;
      end if;
    end loop;
  end if;
  -- pouvoirs achetés : {"push":{"pack":2,"gold":1}} ; 1500 les 15 (Mine 2000), Gold 3000 = 7 jours
  if jsonb_typeof(p_pwbuy) = 'object' then
    for k, v in select key, value from jsonb_each(p_pwbuy) loop
      if k = any (array['push','heavy','ghost','swap','dyn','wall','jump','vision','mine']) and jsonb_typeof(v) = 'object' then
        npack := greatest(0, least(coalesce((v->>'pack')::int, 0), 20)); ngold := greatest(0, least(coalesce((v->>'gold')::int, 0), 10));
        if npack > 0 then
          cost := cost + (case when k = 'mine' then 2000 else 1500 end) * npack;   -- la Mine : 2000 les 15
          pwj := jsonb_set(pwj, array[k], jsonb_build_object('n', coalesce((pwj #>> array[k,'n'])::int, 0) + 15 * npack, 'u', coalesce((pwj #>> array[k,'u'])::bigint, 0)), true);
        end if;
        if ngold > 0 then
          cost := cost + 3000 * ngold;
          pwj := jsonb_set(pwj, array[k], jsonb_build_object('n', coalesce((pwj #>> array[k,'n'])::int, 0),
                   'u', greatest(nowms, coalesce((pwj #>> array[k,'u'])::bigint, 0)) + ngold * 7 * 86400000::bigint), true);
        end if;
      end if;
    end loop;
  end if;
  if jsonb_typeof(p_pwuse) = 'object' then
    for k, v in select key, value from jsonb_each(p_pwuse) loop
      if pwj ? k and coalesce((pwj #>> array[k,'u'])::bigint, 0) <= nowms then
        pwj := jsonb_set(pwj, array[k,'n'], to_jsonb(greatest(0, coalesce((pwj #>> array[k,'n'])::int, 0) - greatest(0, least(coalesce((v #>> '{}')::int, 0), 99)))), true);
      end if;
    end loop;
  end if;
  earned := coalesce(p_delta, 0) + cost;
  if earned > 0 then earned := least(earned, greatest(0, cap - acc.earned_today)); acc.earned_today := acc.earned_today + earned; end if;
  if acc.coins + earned - cost < 0 then raise exception 'not_enough_coins'; end if;
  update public.lastep_accounts set
    coins = acc.coins + earned - cost, owned = v_owned, refs = v_refs, pw = pwj,
    progress = case when jsonb_typeof(p_progress) = 'object' and octet_length(p_progress::text) < 300000 then p_progress else acc.progress end,
    earn_day = acc.earn_day, earned_today = acc.earned_today, loot_today = acc.loot_today + loot_n, updated_at = now()
  where user_id = me returning * into acc;
  return to_jsonb(acc) - 'earn_day' - 'earned_today' - 'loot_today';
end $$;

-- Suppression du compte : fonction serveur « lastep-account-delete » (supabase/functions).

revoke all on function public.lastep_account_open(text, jsonb, integer, jsonb, jsonb) from public, anon;
revoke all on function public.lastep_sync(integer, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from public, anon;
revoke all on function public.lastep_pw_default() from public, anon;
grant execute on function public.lastep_account_open(text, jsonb, integer, jsonb, jsonb) to authenticated;
grant execute on function public.lastep_sync(integer, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to authenticated;
