-- Trip Tab database. Paste this whole file into the Supabase SQL Editor once.
-- Tables live in a schema the public API can't reach. The only way in is
-- through the functions below, and every one of them checks the group passcode.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists trip_private;
revoke all on schema trip_private from public;

create table if not exists trip_private.config (
  id boolean primary key default true check (id),
  passcode_hash text not null
);

create table if not exists trip_private.people (
  id text primary key,
  name text not null,
  position integer not null,
  venmo text not null default '',
  zelle text not null default '',
  handles_updated_at timestamptz
);

create table if not exists trip_private.receipts (
  id uuid primary key default gen_random_uuid(),
  person_id text not null references trip_private.people (id),
  store text not null check (char_length(store) between 1 and 80),
  amount_cents integer not null check (amount_cents between 1 and 1000000),
  note text not null default '' check (char_length(note) <= 200),
  image text not null check (char_length(image) <= 2000000 and image like 'data:image/jpeg;base64,%'),
  created_at timestamptz not null default now()
);

create table if not exists trip_private.payments (
  id uuid primary key default gen_random_uuid(),
  from_id text not null references trip_private.people (id),
  to_id text not null references trip_private.people (id),
  amount_cents integer not null check (amount_cents between 1 and 1000000),
  created_at timestamptz not null default now(),
  check (from_id <> to_id)
);

alter table trip_private.config enable row level security;
alter table trip_private.people enable row level security;
alter table trip_private.receipts enable row level security;
alter table trip_private.payments enable row level security;

create or replace function trip_private.check_code(p_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  stored text;
begin
  select passcode_hash into stored from trip_private.config;
  if stored is null or p_code is null or extensions.crypt(p_code, stored) <> stored then
    raise exception 'wrong_passcode';
  end if;
end $$;

create or replace function public.trip_get_state(p_code text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.check_code(p_code);
  return json_build_object(
    'people', coalesce((select json_agg(json_build_object(
        'id', p.id, 'name', p.name, 'venmo', p.venmo, 'zelle', p.zelle,
        'handlesUpdatedAt', p.handles_updated_at) order by p.position)
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

create or replace function public.trip_get_image(p_code text, p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.check_code(p_code);
  return (select image from trip_private.receipts where id = p_id);
end $$;

create or replace function public.trip_add_receipt(
  p_code text, p_person_id text, p_store text, p_amount_cents integer, p_note text, p_image text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  perform trip_private.check_code(p_code);
  if (select count(*) from trip_private.receipts) >= 500 then
    raise exception 'too_many_receipts';
  end if;
  insert into trip_private.receipts (person_id, store, amount_cents, note, image)
  values (p_person_id, btrim(p_store), p_amount_cents, btrim(coalesce(p_note, '')), p_image)
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.trip_delete_receipt(p_code text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.check_code(p_code);
  delete from trip_private.receipts where id = p_id;
end $$;

create or replace function public.trip_set_handles(
  p_code text, p_person_id text, p_venmo text, p_zelle text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  clean_venmo text := ltrim(btrim(coalesce(p_venmo, '')), '@');
  clean_zelle text := btrim(coalesce(p_zelle, ''));
begin
  perform trip_private.check_code(p_code);
  if clean_venmo <> '' and clean_venmo !~ '^[A-Za-z0-9_-]{1,30}$' then
    raise exception 'bad_venmo';
  end if;
  if char_length(clean_zelle) > 100 then
    raise exception 'bad_zelle';
  end if;
  update trip_private.people
  set venmo = clean_venmo, zelle = clean_zelle, handles_updated_at = now()
  where id = p_person_id;
end $$;

create or replace function public.trip_add_payment(
  p_code text, p_from_id text, p_to_id text, p_amount_cents integer
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  new_id uuid;
begin
  perform trip_private.check_code(p_code);
  insert into trip_private.payments (from_id, to_id, amount_cents)
  values (p_from_id, p_to_id, p_amount_cents)
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.trip_delete_payment(p_code text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.check_code(p_code);
  delete from trip_private.payments where id = p_id;
end $$;

revoke all on all functions in schema trip_private from public;
revoke all on function public.trip_get_state(text) from public, anon, authenticated;
revoke all on function public.trip_get_image(text, uuid) from public, anon, authenticated;
revoke all on function public.trip_add_receipt(text, text, text, integer, text, text) from public, anon, authenticated;
revoke all on function public.trip_delete_receipt(text, uuid) from public, anon, authenticated;
revoke all on function public.trip_set_handles(text, text, text, text) from public, anon, authenticated;
revoke all on function public.trip_add_payment(text, text, text, integer) from public, anon, authenticated;
revoke all on function public.trip_delete_payment(text, uuid) from public, anon, authenticated;

grant execute on function public.trip_get_state(text) to anon;
grant execute on function public.trip_get_image(text, uuid) to anon;
grant execute on function public.trip_add_receipt(text, text, text, integer, text, text) to anon;
grant execute on function public.trip_delete_receipt(text, uuid) to anon;
grant execute on function public.trip_set_handles(text, text, text, text) to anon;
grant execute on function public.trip_add_payment(text, text, text, integer) to anon;
grant execute on function public.trip_delete_payment(text, uuid) to anon;
