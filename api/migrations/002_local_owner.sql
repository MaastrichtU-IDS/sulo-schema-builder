-- Until authentication lands (plan 2), every schema is owned by this row.
-- It stays afterwards as an ordinary user record; nothing special-cases it
-- except the pre-auth request context.
insert into users (id, subject, display_name, global_role, quota_tier)
values ('00000000-0000-0000-0000-000000000001', 'local', 'Local user', 'admin', 'staff')
on conflict (subject) do nothing;
