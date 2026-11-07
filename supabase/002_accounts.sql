-- Adds a personal login for each name, plus an admin passcode.
-- The group passcode keeps outsiders from seeing the names or claiming one.

alter table trip_private.config add column if not exists admin_hash text;
alter table trip_private.people add column if not exists password_hash text;
alter table trip_private.people add column if not exists failed_logins integer not null default 0;
alter table trip_private.people add column if not exists locked_until timestamptz;
alter table trip_private.people drop column if exists handles_device;
alter table trip_private.receipts drop column if exists device;
alter table trip_private.payments drop column if exists device;

create table if not exists trip_private.sessions (
  token_hash text primary key,
  person_id text not null references trip_private.people (id) on delete cascade,
  expires_at timestamptz not null
);
alter table trip_private.sessions enable row level security;

-- Old versions of these functions must go, so nothing can skip the login checks.
drop function if exists public.trip_get_state(text);
drop function if exists public.trip_get_state(text, text);
drop function if exists public.trip_get_image(text, uuid);
drop function if exists public.trip_add_receipt(text, text, text, integer, text, text);
drop function if exists public.trip_add_receipt(text, text, text, integer, text, text, text);
drop function if exists public.trip_delete_receipt(text, uuid);
drop function if exists public.trip_delete_receipt(text, uuid, text);
drop function if exists public.trip_delete_receipt(text, uuid, text, text);
drop function if exists public.trip_set_handles(text, text, text, text);
drop function if exists public.trip_set_handles(text, text, text, text, text);
drop function if exists public.trip_set_handles(text, text, text, text, text, text);
drop function if exists public.trip_add_payment(text, text, text, integer);
drop function if exists public.trip_add_payment(text, text, text, integer, text);
drop function if exists public.trip_delete_payment(text, uuid);
drop function if exists public.trip_delete_payment(text, uuid, text);
drop function if exists public.trip_delete_payment(text, uuid, text, text);
drop function if exists public.trip_admin_check(text, text);
drop function if exists public.trip_admin_add_person(text, text, text);
drop function if exists public.trip_admin_remove_person(text, text, text);
drop function if exists public.trip_admin_set_passcode(text, text, text);
drop function if exists trip_private.require_admin(text, text);

create or replace function trip_private.session_person(p_token text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  found_id text;
begin
  select person_id into found_id from trip_private.sessions
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and expires_at > now();
  if found_id is null then
    raise exception 'signed_out';
  end if;
  return found_id;
end $$;

create or replace function trip_private.issue_session(p_person_id text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  delete from trip_private.sessions where expires_at <= now();
  insert into trip_private.sessions (token_hash, person_id, expires_at)
  values (encode(extensions.digest(token, 'sha256'), 'hex'), p_person_id, now() + interval '30 days');
  return token;
end $$;

create or replace function trip_private.is_admin(p_admin text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  stored text;
begin
  select admin_hash into stored from trip_private.config;
  return stored is not null and p_admin is not null and extensions.crypt(p_admin, stored) = stored;
end $$;

create or replace function trip_private.require_admin(p_token text, p_admin text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.session_person(p_token);
  if not trip_private.is_admin(p_admin) then
    raise exception 'not_allowed';
  end if;
end $$;

create or replace function public.trip_list_names(p_code text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.check_code(p_code);
  return coalesce((select json_agg(json_build_object(
      'id', p.id, 'name', p.name, 'hasLogin', p.password_hash is not null) order by p.position)
    from trip_private.people p), '[]'::json);
end $$;

create or replace function public.trip_create_login(p_code text, p_person_id text, p_password text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.check_code(p_code);
  if p_password is null or char_length(p_password) not between 6 and 72 then
    raise exception 'bad_password';
  end if;
  update trip_private.people
  set password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), failed_logins = 0, locked_until = null
  where id = p_person_id and password_hash is null;
  if not found then
    raise exception 'already_claimed';
  end if;
  return trip_private.issue_session(p_person_id);
end $$;

-- Returns errors as data: raising one would also undo the failed-attempt count.
create or replace function public.trip_sign_in(p_code text, p_person_id text, p_password text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  person record;
begin
  perform trip_private.check_code(p_code);
  select * into person from trip_private.people where id = p_person_id for update;
  if not found or person.password_hash is null then
    return json_build_object('error', 'no_login');
  end if;
  if person.locked_until is not null and person.locked_until > now() then
    return json_build_object('error', 'locked');
  end if;
  if p_password is null or extensions.crypt(p_password, person.password_hash) <> person.password_hash then
    update trip_private.people
    set failed_logins = case when person.failed_logins >= 4 then 0 else person.failed_logins + 1 end,
        locked_until = case when person.failed_logins >= 4 then now() + interval '15 minutes' else null end
    where id = p_person_id;
    return json_build_object('error', case when person.failed_logins >= 4 then 'locked' else 'wrong_password' end);
  end if;
  update trip_private.people set failed_logins = 0, locked_until = null where id = p_person_id;
  return json_build_object('token', trip_private.issue_session(p_person_id));
end $$;

create or replace function public.trip_sign_out(p_token text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from trip_private.sessions
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
end $$;

create or replace function public.trip_get_state(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare
  me text := trip_private.session_person(p_token);
begin
  return json_build_object(
    'me', me,
    'people', coalesce((select json_agg(json_build_object(
        'id', p.id, 'name', p.name, 'venmo', p.venmo, 'zelle', p.zelle,
        'hasLogin', p.password_hash is not null) order by p.position)
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

create or replace function public.trip_get_image(p_token text, p_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.session_person(p_token);
  return (select image from trip_private.receipts where id = p_id);
end $$;

create or replace function public.trip_add_receipt(
  p_token text, p_person_id text, p_store text, p_amount_cents integer, p_note text, p_image text, p_admin text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me text := trip_private.session_person(p_token);
  new_id uuid;
begin
  if p_person_id is distinct from me and not trip_private.is_admin(p_admin) then
    raise exception 'not_allowed';
  end if;
  if (select count(*) from trip_private.receipts) >= 500 then
    raise exception 'too_many_receipts';
  end if;
  insert into trip_private.receipts (person_id, store, amount_cents, note, image)
  values (p_person_id, btrim(p_store), p_amount_cents, btrim(coalesce(p_note, '')), p_image)
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.trip_delete_receipt(p_token text, p_id uuid, p_admin text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me text := trip_private.session_person(p_token);
begin
  if not trip_private.is_admin(p_admin) and not exists (
    select 1 from trip_private.receipts where id = p_id and person_id = me
  ) then
    raise exception 'not_allowed';
  end if;
  delete from trip_private.receipts where id = p_id;
end $$;

create or replace function public.trip_set_handles(
  p_token text, p_person_id text, p_venmo text, p_zelle text, p_admin text
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me text := trip_private.session_person(p_token);
  clean_venmo text := ltrim(btrim(coalesce(p_venmo, '')), '@');
  clean_zelle text := btrim(coalesce(p_zelle, ''));
begin
  if p_person_id is distinct from me and not trip_private.is_admin(p_admin) then
    raise exception 'not_allowed';
  end if;
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
  p_token text, p_from_id text, p_to_id text, p_amount_cents integer, p_admin text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me text := trip_private.session_person(p_token);
  new_id uuid;
begin
  if me not in (p_from_id, p_to_id) and not trip_private.is_admin(p_admin) then
    raise exception 'not_allowed';
  end if;
  insert into trip_private.payments (from_id, to_id, amount_cents)
  values (p_from_id, p_to_id, p_amount_cents)
  returning id into new_id;
  return new_id;
end $$;

create or replace function public.trip_delete_payment(p_token text, p_id uuid, p_admin text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  me text := trip_private.session_person(p_token);
begin
  if not trip_private.is_admin(p_admin) and not exists (
    select 1 from trip_private.payments where id = p_id and me in (from_id, to_id)
  ) then
    raise exception 'not_allowed';
  end if;
  delete from trip_private.payments where id = p_id;
end $$;

create or replace function public.trip_admin_check(p_token text, p_admin text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.session_person(p_token);
  return trip_private.is_admin(p_admin);
end $$;

create or replace function public.trip_admin_add_person(p_token text, p_admin text, p_name text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  clean_name text := btrim(coalesce(p_name, ''));
begin
  perform trip_private.require_admin(p_token, p_admin);
  if char_length(clean_name) not between 1 and 60 then
    raise exception 'bad_name';
  end if;
  insert into trip_private.people (id, name, position)
  values (
    'p-' || replace(gen_random_uuid()::text, '-', ''),
    clean_name,
    (select coalesce(max(position), 0) + 1 from trip_private.people)
  );
end $$;

create or replace function public.trip_admin_remove_person(p_token text, p_admin text, p_person_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.require_admin(p_token, p_admin);
  if exists (select 1 from trip_private.receipts where person_id = p_person_id)
    or exists (select 1 from trip_private.payments where from_id = p_person_id or to_id = p_person_id) then
    raise exception 'person_has_records';
  end if;
  delete from trip_private.people where id = p_person_id;
end $$;

-- Clears a forgotten password and signs that person out, so they can create a new one.
create or replace function public.trip_admin_reset_login(p_token text, p_admin text, p_person_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.require_admin(p_token, p_admin);
  update trip_private.people set password_hash = null, failed_logins = 0, locked_until = null where id = p_person_id;
  delete from trip_private.sessions where person_id = p_person_id;
end $$;

create or replace function public.trip_admin_set_passcode(p_token text, p_admin text, p_new_code text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.require_admin(p_token, p_admin);
  if p_new_code is null or char_length(btrim(p_new_code)) < 8 then
    raise exception 'short_passcode';
  end if;
  update trip_private.config set passcode_hash = extensions.crypt(btrim(p_new_code), extensions.gen_salt('bf', 10));
end $$;

revoke all on all functions in schema trip_private from public;

revoke all on function public.trip_list_names(text) from public, anon, authenticated;
revoke all on function public.trip_create_login(text, text, text) from public, anon, authenticated;
revoke all on function public.trip_sign_in(text, text, text) from public, anon, authenticated;
revoke all on function public.trip_sign_out(text) from public, anon, authenticated;
revoke all on function public.trip_get_state(text) from public, anon, authenticated;
revoke all on function public.trip_get_image(text, uuid) from public, anon, authenticated;
revoke all on function public.trip_add_receipt(text, text, text, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.trip_delete_receipt(text, uuid, text) from public, anon, authenticated;
revoke all on function public.trip_set_handles(text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.trip_add_payment(text, text, text, integer, text) from public, anon, authenticated;
revoke all on function public.trip_delete_payment(text, uuid, text) from public, anon, authenticated;
revoke all on function public.trip_admin_check(text, text) from public, anon, authenticated;
revoke all on function public.trip_admin_add_person(text, text, text) from public, anon, authenticated;
revoke all on function public.trip_admin_remove_person(text, text, text) from public, anon, authenticated;
revoke all on function public.trip_admin_reset_login(text, text, text) from public, anon, authenticated;
revoke all on function public.trip_admin_set_passcode(text, text, text) from public, anon, authenticated;

grant execute on function public.trip_list_names(text) to anon;
grant execute on function public.trip_create_login(text, text, text) to anon;
grant execute on function public.trip_sign_in(text, text, text) to anon;
grant execute on function public.trip_sign_out(text) to anon;
grant execute on function public.trip_get_state(text) to anon;
grant execute on function public.trip_get_image(text, uuid) to anon;
grant execute on function public.trip_add_receipt(text, text, text, integer, text, text, text) to anon;
grant execute on function public.trip_delete_receipt(text, uuid, text) to anon;
grant execute on function public.trip_set_handles(text, text, text, text, text) to anon;
grant execute on function public.trip_add_payment(text, text, text, integer, text) to anon;
grant execute on function public.trip_delete_payment(text, uuid, text) to anon;
grant execute on function public.trip_admin_check(text, text) to anon;
grant execute on function public.trip_admin_add_person(text, text, text) to anon;
grant execute on function public.trip_admin_remove_person(text, text, text) to anon;
grant execute on function public.trip_admin_reset_login(text, text, text) to anon;
grant execute on function public.trip_admin_set_passcode(text, text, text) to anon;
