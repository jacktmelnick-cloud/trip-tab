-- Adds a backup store and link to each shopping list item.

alter table trip_private.assignments add column if not exists backup_store text not null default '';
alter table trip_private.assignments add column if not exists backup_url text not null default '';

create or replace function public.trip_get_assignments(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.session_person(p_token);
  return coalesce((select json_agg(json_build_object(
      'id', a.id, 'personId', a.person_id, 'item', a.item, 'quantity', a.quantity,
      'estimateCents', a.estimate_cents, 'store', a.store, 'url', a.url, 'when', a.buy_when,
      'backupStore', a.backup_store, 'backupUrl', a.backup_url) order by a.id)
    from trip_private.assignments a), '[]'::json);
end $$;

revoke all on function public.trip_get_assignments(text) from public, anon, authenticated;
grant execute on function public.trip_get_assignments(text) to anon;
