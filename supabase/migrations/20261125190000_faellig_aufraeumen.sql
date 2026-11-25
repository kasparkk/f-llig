-- Grabsteine (geloeschte Eintraege) aelter als `tage` aus dem eigenen Konto entfernen.
-- Rein additiv: neue Loesch-Regel nur fuer eigene Grabsteine, neue Funktion.
-- Lebende Eintraege kann man hierueber nicht loeschen.

create policy "faellig: eigene grabsteine loeschen"
  on public.faellig_daten
  for delete
  to authenticated
  using ((select auth.uid()) = user_id and geloescht);

create or replace function public.faellig_aufraeumen(tage integer default 90)
returns integer
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  uid uuid := auth.uid();
  n integer;
begin
  if uid is null then
    raise exception 'nicht angemeldet' using errcode = '28000';
  end if;
  -- Unter 30 Tagen waere es riskant: Geraete, die ein paar Wochen offline
  -- waren, bekaemen das Loeschen sonst nicht mehr mit.
  if tage is null or tage < 30 then
    raise exception 'tage muss mindestens 30 sein';
  end if;

  delete from public.faellig_daten
  where user_id = uid
    and geloescht
    and geaendert_am < (extract(epoch from clock_timestamp()) * 1000)::bigint - tage::bigint * 86400000;

  get diagnostics n = row_count;
  return n;
end;
$function$;

revoke all on function public.faellig_aufraeumen(integer) from public, anon;
grant execute on function public.faellig_aufraeumen(integer) to authenticated;
