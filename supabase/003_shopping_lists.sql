-- Adds each person's shopping list. Only signed-in people can read it.

create table if not exists trip_private.assignments (
  id integer primary key,
  -- If an admin removes someone, their items stay on the list as unassigned.
  person_id text references trip_private.people (id) on delete set null,
  sheet_row integer not null,
  item text not null,
  quantity text not null,
  estimate_cents integer not null,
  store text not null,
  url text not null default '',
  buy_when text not null
);
alter table trip_private.assignments enable row level security;

create or replace function public.trip_get_assignments(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.session_person(p_token);
  return coalesce((select json_agg(json_build_object(
      'id', a.id, 'personId', a.person_id, 'item', a.item, 'quantity', a.quantity,
      'estimateCents', a.estimate_cents, 'store', a.store, 'url', a.url, 'when', a.buy_when) order by a.id)
    from trip_private.assignments a), '[]'::json);
end $$;

revoke all on function public.trip_get_assignments(text) from public, anon, authenticated;
grant execute on function public.trip_get_assignments(text) to anon;
