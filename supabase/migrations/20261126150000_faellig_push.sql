-- Push-Erinnerungen fuer faellig.
--
-- faellig_push_abo:  ein Push-Abo je Geraet (Adresse des Push-Dienstes, Schluessel, Zeitzone).
-- faellig_push_plan: was an welchem Tag gemeldet wird. Rechnet die App nach jedem Sync
--                    fuer die naechsten ~60 Tage aus; der Server rechnet nichts selbst.
-- Alle 15 Minuten ruft pg_cron die Edge Function faellig-push. Die fragt
-- faellig_push_faellig() nach allem, was jetzt dran ist, schickt es und
-- traegt per faellig_push_erledigt() ein, dass das Geraet heute bedient ist.
-- Rein additiv: bestehende Tabellen bleiben unberuehrt.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create table public.faellig_push_abo (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  endpoint text not null unique check (length(endpoint) <= 1000),
  p256dh text not null check (length(p256dh) <= 200),
  auth text not null check (length(auth) <= 100),
  zeitzone text not null default 'Europe/Berlin',
  geraet text not null default '' check (length(geraet) <= 100),
  zuletzt_tag date,              -- lokaler Tag, fuer den zuletzt geschickt wurde
  fehler integer not null default 0,
  erstellt_am timestamptz not null default now(),
  gesehen_am timestamptz not null default now()
);
comment on table public.faellig_push_abo is
  'Push-Abos der App faellig, eines je Geraet. Endpoint und Schluessel kommen vom Browser; zuletzt_tag verhindert doppelte Tagesmeldungen.';
create index faellig_push_abo_user on public.faellig_push_abo (user_id);
alter table public.faellig_push_abo enable row level security;

create policy "faellig_push_abo eigene lesen" on public.faellig_push_abo
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "faellig_push_abo eigene loeschen" on public.faellig_push_abo
  for delete to authenticated using ((select auth.uid()) = user_id);
-- Anlegen und Aendern nur ueber faellig_push_anmelden (unten).

create table public.faellig_push_plan (
  user_id uuid not null references auth.users on delete cascade,
  tag date not null,
  uhrzeit time not null,
  meldungen jsonb not null check (jsonb_typeof(meldungen) = 'array' and jsonb_array_length(meldungen) <= 12
                                  and octet_length(meldungen::text) <= 8000),
  primary key (user_id, tag)
);
comment on table public.faellig_push_plan is
  'Erinnerungsplan der App faellig: je Konto und lokalem Tag die Uhrzeit und die fertigen Meldungen. Wird von der App komplett ersetzt.';
alter table public.faellig_push_plan enable row level security;

create policy "faellig_push_plan eigene lesen" on public.faellig_push_plan
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "faellig_push_plan eigene anlegen" on public.faellig_push_plan
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "faellig_push_plan eigene loeschen" on public.faellig_push_plan
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Geraet anmelden oder auffrischen. Wer die Push-Adresse hat, besitzt sie:
-- wechselt ein Geraet das Konto, wandert das Abo mit (und faengt neu an).
create or replace function public.faellig_push_anmelden(
  adresse text, schluessel text, geheim text, zone text, name text default '')
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  zz text := zone;
begin
  if uid is null then raise exception 'nicht angemeldet' using errcode = '28000'; end if;
  if adresse is null or adresse !~ '^https://' or length(adresse) > 1000 then
    raise exception 'ungueltige Push-Adresse';
  end if;
  if schluessel is null or geheim is null then raise exception 'Schluessel fehlen'; end if;
  if zz is null or not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = zz) then
    zz := 'Europe/Berlin';
  end if;
  insert into public.faellig_push_abo as a (user_id, endpoint, p256dh, auth, zeitzone, geraet)
  values (uid, adresse, schluessel, geheim, zz, left(coalesce(name, ''), 100))
  on conflict (endpoint) do update set
    zuletzt_tag = case when a.user_id = uid then a.zuletzt_tag else null end,
    user_id = uid,
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    zeitzone = excluded.zeitzone,
    geraet = excluded.geraet,
    fehler = 0,
    gesehen_am = now();
end;
$function$;
revoke all on function public.faellig_push_anmelden(text, text, text, text, text) from public, anon;
grant execute on function public.faellig_push_anmelden(text, text, text, text, text) to authenticated;

-- Plan komplett ersetzen: [{ tag, uhrzeit, meldungen: [...] }, ...]
create or replace function public.faellig_push_plan_setzen(plan jsonb)
returns integer
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  n integer;
begin
  if uid is null then raise exception 'nicht angemeldet' using errcode = '28000'; end if;
  if jsonb_typeof(plan) <> 'array' or jsonb_array_length(plan) > 120 then
    raise exception 'plan muss eine Liste mit hoechstens 120 Tagen sein';
  end if;
  delete from public.faellig_push_plan where user_id = uid;
  insert into public.faellig_push_plan (user_id, tag, uhrzeit, meldungen)
  select uid, (p->>'tag')::date, (p->>'uhrzeit')::time, p->'meldungen'
  from jsonb_array_elements(plan) p
  where jsonb_array_length(p->'meldungen') > 0;
  get diagnostics n = row_count;
  return n;
end;
$function$;
revoke all on function public.faellig_push_plan_setzen(jsonb) from public, anon;
grant execute on function public.faellig_push_plan_setzen(jsonb) to authenticated;

-- Was jetzt raus muss: lokaler Tag des Geraets hat einen Plan, die Uhrzeit ist
-- erreicht (hoechstens 3 Stunden her, sonst kommt die Morgenmeldung abends)
-- und das Geraet hat heute noch nichts bekommen. Nur fuer die Edge Function.
create or replace function public.faellig_push_faellig()
returns table (abo_id uuid, endpoint text, p256dh text, auth text, tag date, meldungen jsonb)
language sql
security definer
set search_path to ''
as $function$
  select a.id, a.endpoint, a.p256dh, a.auth, p.tag, p.meldungen
  from public.faellig_push_abo a
  cross join lateral (select (now() at time zone a.zeitzone) as lokal) l
  join public.faellig_push_plan p on p.user_id = a.user_id and p.tag = l.lokal::date
  where (a.zuletzt_tag is null or a.zuletzt_tag < p.tag)
    and l.lokal >= p.tag + p.uhrzeit
    and l.lokal < p.tag + p.uhrzeit + interval '3 hours'
    and jsonb_array_length(p.meldungen) > 0;
$function$;

-- Ergebnis eintragen. weg = Push-Dienst kennt das Abo nicht mehr.
create or replace function public.faellig_push_erledigt(abo uuid, tag date, ok boolean, weg boolean)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if weg then
    delete from public.faellig_push_abo where id = abo;
  elsif ok then
    update public.faellig_push_abo set zuletzt_tag = tag, fehler = 0 where id = abo;
  else
    update public.faellig_push_abo set fehler = fehler + 1 where id = abo;
  end if;
end;
$function$;

-- Schluessel fuer die Edge Function (liegen im Vault, nicht im Code).
create or replace function public.faellig_push_geheimnisse()
returns jsonb
language sql
security definer
set search_path to ''
as $function$
  select jsonb_object_agg(name, decrypted_secret)
  from vault.decrypted_secrets
  where name in ('faellig_push_vapid_privat', 'faellig_push_vapid_public', 'faellig_push_cron');
$function$;

revoke all on function public.faellig_push_faellig() from public, anon, authenticated;
revoke all on function public.faellig_push_erledigt(uuid, date, boolean, boolean) from public, anon, authenticated;
revoke all on function public.faellig_push_geheimnisse() from public, anon, authenticated;
grant execute on function public.faellig_push_faellig() to service_role;
grant execute on function public.faellig_push_erledigt(uuid, date, boolean, boolean) to service_role;
grant execute on function public.faellig_push_geheimnisse() to service_role;

-- Die Schluessel selbst werden NICHT hier eingetragen (gehoeren nicht ins Repo):
--   select vault.create_secret('<privat>', 'faellig_push_vapid_privat');
--   select vault.create_secret('<oeffentlich>', 'faellig_push_vapid_public');
--   select vault.create_secret('<zufall>', 'faellig_push_cron');

-- Alle 15 Minuten nachsehen.
select cron.schedule('faellig-push', '*/15 * * * *', $cron$
  select net.http_post(
    url := 'https://xrrcuapiugwgqxxatkiq.supabase.co/functions/v1/faellig-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-faellig-cron', (select decrypted_secret from vault.decrypted_secrets where name = 'faellig_push_cron')),
    body := '{"aktion":"senden"}'::jsonb,
    timeout_milliseconds := 30000);
$cron$);
