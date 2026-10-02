\set ON_ERROR_STOP on
begin;
set local lock_timeout = '2s';
set local statement_timeout = '10s';
revoke execute on function public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text) from service_role;

do $$
begin
  if has_function_privilege('service_role',
    'public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text)', 'EXECUTE')
    or has_function_privilege('anon',
    'public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text)', 'EXECUTE')
    or has_function_privilege('authenticated',
    'public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text)', 'EXECUTE')
    or not has_function_privilege('postgres',
    'public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text)', 'EXECUTE') then
    raise exception 'privilege matrix did not match expected roles';
  end if;
end;
$$;

set local role service_role;
do $$
begin
  begin
    perform public.record_cpsc_identity_observation(null,null,null,null,null,null,null,null,null);
    raise exception 'service_role direct call unexpectedly succeeded';
  exception when insufficient_privilege then
    raise notice 'service_role direct call denied';
  end;
end;
$$;
reset role;

set local role anon;
do $$
begin
  begin
    perform public.record_cpsc_identity_observation(null,null,null,null,null,null,null,null,null);
    raise exception 'anon direct call unexpectedly succeeded';
  exception when insufficient_privilege then
    raise notice 'anon direct call denied';
  end;
end;
$$;
reset role;

set local role authenticated;
do $$
begin
  begin
    perform public.record_cpsc_identity_observation(null,null,null,null,null,null,null,null,null);
    raise exception 'authenticated direct call unexpectedly succeeded';
  exception when insufficient_privilege then
    raise notice 'authenticated direct call denied';
  end;
end;
$$;
reset role;

select current_user, has_function_privilege('postgres',
  'public.record_cpsc_identity_observation(text,text,text,text,text,date,text,timestamptz,text)', 'EXECUTE') as owner_can_execute;
rollback;
