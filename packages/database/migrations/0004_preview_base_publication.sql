-- Bind publication previews to the publication they were reviewed against
-- (the current publication when the preview was created, or null for none).
-- Publishing a preview whose base is no longer current is stale: another
-- publication or a withdrawal happened after the author reviewed it.
alter table publication_previews add column base_publication_id uuid;

alter table publication_previews
  add constraint publication_previews_base_publication_fk
  foreign key (organization_id, briefing_id, base_publication_id)
  references publications (organization_id, briefing_id, id);
