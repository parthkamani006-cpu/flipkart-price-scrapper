-- Browser uploads use short-lived signed tokens issued by the server.  Keeping
-- this bucket private means an uploaded seller export is never publicly URL
-- addressable, and it is deleted by /api/upload after validation.
insert into storage.buckets (id, name, public, file_size_limit)
values ('upload-staging', 'upload-staging', false, null)
on conflict (id) do update set public = false, file_size_limit = null;
