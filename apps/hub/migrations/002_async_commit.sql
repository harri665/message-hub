-- Everything in this database can be re-synced from the Mac and the phone, so trade crash
-- durability of the last few milliseconds of writes for much faster imports.
do $$
begin
  execute format('alter database %I set synchronous_commit = off', current_database());
end
$$;
