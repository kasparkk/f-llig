-- Kalender-Abo fuer faellig.
-- Die App legt ihre Kalender-Datei unter <konto-id>/<geheimnis>.ics ab.
-- Der Ordner ist oeffentlich lesbar (sonst kann kein Kalender abonnieren),
-- aber nur ueber den vollen, geheimen Dateinamen. Auflisten, Schreiben und
-- Loeschen darf jedes Konto nur im eigenen Unterordner.

insert into storage.buckets (id, name, public, file_size_limit)
values ('faellig-kalender', 'faellig-kalender', true, 1048576)
on conflict (id) do nothing;

create policy "faellig_kalender_eigene_lesen" on storage.objects
  for select to authenticated
  using (bucket_id = 'faellig-kalender' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "faellig_kalender_eigene_anlegen" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'faellig-kalender' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "faellig_kalender_eigene_aendern" on storage.objects
  for update to authenticated
  using (bucket_id = 'faellig-kalender' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'faellig-kalender' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "faellig_kalender_eigene_loeschen" on storage.objects
  for delete to authenticated
  using (bucket_id = 'faellig-kalender' and (storage.foldername(name))[1] = (select auth.uid())::text);
