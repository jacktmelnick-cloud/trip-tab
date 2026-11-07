-- Adds announcements: the admin posts them and every signed-in person sees them.

create table if not exists trip_private.announcements (
  id uuid primary key default gen_random_uuid(),
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
alter table trip_private.announcements enable row level security;

create or replace function public.trip_get_announcements(p_token text) returns json
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.session_person(p_token);
  return coalesce((select json_agg(json_build_object(
      'id', a.id, 'body', a.body, 'createdAt', a.created_at) order by a.created_at desc)
    from trip_private.announcements a), '[]'::json);
end $$;

create or replace function public.trip_admin_post_announcement(p_token text, p_admin text, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  clean_body text := btrim(coalesce(p_body, ''));
begin
  perform trip_private.require_admin(p_token, p_admin);
  if char_length(clean_body) not between 1 and 500 then
    raise exception 'bad_announcement';
  end if;
  if (select count(*) from trip_private.announcements) >= 50 then
    raise exception 'too_many_announcements';
  end if;
  insert into trip_private.announcements (body) values (clean_body);
end $$;

create or replace function public.trip_admin_delete_announcement(p_token text, p_admin text, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform trip_private.require_admin(p_token, p_admin);
  delete from trip_private.announcements where id = p_id;
end $$;

revoke all on function public.trip_get_announcements(text) from public, anon, authenticated;
revoke all on function public.trip_admin_post_announcement(text, text, text) from public, anon, authenticated;
revoke all on function public.trip_admin_delete_announcement(text, text, uuid) from public, anon, authenticated;

grant execute on function public.trip_get_announcements(text) to anon;
grant execute on function public.trip_admin_post_announcement(text, text, text) to anon;
grant execute on function public.trip_admin_delete_announcement(text, text, uuid) to anon;
