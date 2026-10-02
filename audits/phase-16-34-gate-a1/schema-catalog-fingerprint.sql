with ext as (select objid from pg_depend where deptype='e'),
ns as (select oid, nspname from pg_namespace where nspname in ('public','private')),
rows as (
 select 'fn' k, n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' o,
        md5(pg_get_functiondef(p.oid)) d, md5(coalesce(p.proacl::text,'')) a
 from pg_proc p join ns n on n.oid=p.pronamespace where p.prokind in ('f','p') and p.oid not in (select objid from ext)
 union all
 select 'rel', n.nspname||'.'||c.relname||':'||c.relkind::text,
   md5(coalesce((select string_agg(a.attname||' '||format_type(a.atttypid,a.atttypmod)||' '||a.attnotnull::text||' '||coalesce(pg_get_expr(d.adbin,d.adrelid),''), ',' order by a.attnum)
    from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),'')||c.relrowsecurity::text||c.relforcerowsecurity::text||coalesce(pg_get_viewdef(c.oid),'')),
   md5(coalesce(c.relacl::text,''))
 from pg_class c join ns n on n.oid=c.relnamespace where c.relkind in ('r','v','m','p','f') and c.oid not in (select objid from ext)
 union all
 select 'con', n.nspname||'.'||c.conrelid::regclass::text||'.'||c.conname, md5(pg_get_constraintdef(c.oid)), ''
 from pg_constraint c join ns n on n.oid=c.connamespace where c.conrelid<>0
 union all
 select 'idx', n.nspname||'.'||i.relname, md5(pg_get_indexdef(i.oid)), ''
 from pg_index x join pg_class i on i.oid=x.indexrelid join ns n on n.oid=i.relnamespace
 union all
 select 'trg', t.tgrelid::regclass::text||'.'||t.tgname, md5(pg_get_triggerdef(t.oid)), ''
 from pg_trigger t join pg_class c on c.oid=t.tgrelid join ns n on n.oid=c.relnamespace where not t.tgisinternal
 union all
 select 'pol', schemaname||'.'||tablename||'.'||policyname, md5(permissive||roles::text||cmd||coalesce(qual,'')||coalesce(with_check,'')), ''
 from pg_policies where schemaname in ('public','private')
)
select k, count(*) n, md5(string_agg(o||'='||d, ',' order by o)) def_fp, md5(string_agg(o||'='||a, ',' order by o)) acl_fp from rows group by k order by k;
