-- LeoTeX accounts: storage for profile, preferences, shortcuts and the (passphrase-sealed) GitHub connection.
-- Run this once in your Supabase project: Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Every user can only read and change their own row (row level security). The service never sees your files.

create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint profiles_data_size check (octet_length(data::text) <= 300000)
);

alter table public.profiles enable row level security;

drop policy if exists "own row: read"   on public.profiles;
drop policy if exists "own row: insert" on public.profiles;
drop policy if exists "own row: update" on public.profiles;
drop policy if exists "own row: delete" on public.profiles;

create policy "own row: read"   on public.profiles for select to authenticated using ((select auth.uid()) = user_id);
create policy "own row: insert" on public.profiles for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own row: update" on public.profiles for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own row: delete" on public.profiles for delete to authenticated using ((select auth.uid()) = user_id);

revoke all on public.profiles from anon;
grant select, insert, update, delete on public.profiles to authenticated;

-- "Delete my account" in the settings page calls this. It removes the signed-in user and, by cascade, the row above.
create or replace function public.delete_my_account() returns void
  language sql security definer set search_path = ''
as $$ delete from auth.users where id = (select auth.uid()); $$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- A harmless query for the weekly keep-alive workflow (free projects pause after a week without activity).
create or replace function public.ping() returns integer
  language sql stable set search_path = ''
as $$ select 1; $$;

grant execute on function public.ping() to anon, authenticated;
