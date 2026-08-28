revoke all on table public.learning_progress from anon;
revoke all on sequence public.learning_progress_id_seq from anon;

grant select, insert, update, delete on table public.learning_progress to authenticated;
grant usage, select on sequence public.learning_progress_id_seq to authenticated;
