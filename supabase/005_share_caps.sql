-- Lets a person's share of the split have a maximum. Everyone else evenly covers the difference.

alter table trip_private.people add column if not exists share_cap_cents integer check (share_cap_cents >= 0);

create or replace function public.trip_get_state(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  me text := trip_private.session_person(p_token);
begin
  return json_build_object(
    'me', me,
    'people', coalesce((select json_agg(json_build_object(
        'id', p.id, 'name', p.name, 'venmo', p.venmo, 'zelle', p.zelle,
        'hasLogin', p.password_hash is not null, 'shareCapCents', p.share_cap_cents) order by p.position)
      from trip_private.people p), '[]'::json),
    'receipts', coalesce((select json_agg(json_build_object(
        'id', r.id, 'personId', r.person_id, 'store', r.store, 'amountCents', r.amount_cents,
        'note', r.note, 'createdAt', r.created_at) order by r.created_at desc)
      from trip_private.receipts r), '[]'::json),
    'payments', coalesce((select json_agg(json_build_object(
        'id', y.id, 'fromId', y.from_id, 'toId', y.to_id, 'amountCents', y.amount_cents,
        'createdAt', y.created_at) order by y.created_at desc)
      from trip_private.payments y), '[]'::json)
  );
end $$;

revoke all on function public.trip_get_state(text) from public, anon, authenticated;
grant execute on function public.trip_get_state(text) to anon;
