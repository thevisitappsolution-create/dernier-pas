-- Classements : seuls les joueurs qui ont un compte (e-mail) y figurent.
-- n = nombre de joueurs avec compte dans ce classement, above = combien ont plus que p_v (pour calculer sa place).
create or replace function public.lastep_board(p_mode text, p_week text, p_v integer default 0)
returns jsonb language sql stable security definer set search_path = public as $$
  with b as (
    select p.uid, p.name, p.skin, case when p_mode = 'adv' then p.wxp else p.elo end as v
    from lastep_players p join lastep_accounts a on a.uid = p.uid
    where case when p_mode = 'adv' then p.week = p_week and p.wxp > 0
               else p.updated_at > now() - interval '30 days' end
  )
  select jsonb_build_object(
    'n', (select count(*) from b),
    'above', (select count(*) from b where v > coalesce(p_v, 0)),
    'rows', coalesce((select jsonb_agg(r) from (select uid, name, skin, v from b order by v desc limit 50) r), '[]'::jsonb)
  );
$$;
revoke all on function public.lastep_board(text, text, integer) from public;
grant execute on function public.lastep_board(text, text, integer) to anon, authenticated;
