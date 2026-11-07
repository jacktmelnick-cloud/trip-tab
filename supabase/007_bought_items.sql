-- Lets people check off shopping list items as bought.

alter table trip_private.assignments add column if not exists bought_at timestamptz;

create or replace function public.trip_get_assignments(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.session_person(p_token);
  return coalesce((select json_agg(json_build_object(
      'id', a.id, 'personId', a.person_id, 'item', a.item, 'quantity', a.quantity,
      'estimateCents', a.estimate_cents, 'store', a.store, 'url', a.url, 'when', a.buy_when,
      'backupStore', a.backup_store, 'backupUrl', a.backup_url,
      'bought', a.bought_at is not null) order by a.id)
    from trip_private.assignments a), '[]'::json);
end $$;

-- Only the person assigned the item, or the admin, can change it.
create or replace function public.trip_set_bought(p_token text, p_id integer, p_bought boolean, p_admin text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me text := trip_private.session_person(p_token);
begin
  if not trip_private.is_admin(p_admin) and not exists (
    select 1 from trip_private.assignments where id = p_id and person_id = me
  ) then
    raise exception 'not_allowed';
  end if;
  update trip_private.assignments
  set bought_at = case when p_bought then coalesce(bought_at, now()) else null end
  where id = p_id;
end $$;

revoke all on function public.trip_get_assignments(text) from public, anon, authenticated;
revoke all on function public.trip_set_bought(text, integer, boolean, text) from public, anon, authenticated;
grant execute on function public.trip_get_assignments(text) to anon;
grant execute on function public.trip_set_bought(text, integer, boolean, text) to anon;
