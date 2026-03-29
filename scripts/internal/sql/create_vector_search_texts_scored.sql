create or replace function public.vector_search_texts_scored(
  p_agent_id uuid,
  p_query_embedding extensions.vector
)
returns table (
  chunk_text text,
  distance real,
  score real
)
language sql
security definer
set search_path = public, extensions
as $$
  select
    t.chunk_text,
    t.distance,
    greatest(0::real, least(1::real, (1 - t.distance)::real)) as score
  from (
    select
      case
        when e.docs_id is not null then dt.content
        when e.faqs_id is not null then
          trim(concat_ws(E'\n',
            ft.description,
            ft.answer
          ))
        when e.notes_id is not null then trim(concat_ws(E'\n', nt.title, nt.content))
        when e.notion_id is not null then ntt.content
        when e.products_id is not null then
          trim(concat_ws(E'\n',
            pt.title,
            pt.description,
            case
              when pt.price is null then null
              else concat('price: ', pt.price::text, ' ', coalesce(pt.currency, 'usd'))
            end,
            case
              when pt.period is null then null
              else concat('period: ', pt.period)
            end
          ))
        else null
      end as chunk_text,
      (e.content <=> p_query_embedding)::real as distance
    from public.embeddings e
    left join public.docs_text dt on dt.id = e.docs_id
    left join public.faqs_text ft on ft.id = e.faqs_id
    left join public.notes_text nt on nt.id = e.notes_id
    left join public.notion_text ntt on ntt.id = e.notion_id
    left join public.products_text pt on pt.id = e.products_id
    where e.agent_id = p_agent_id
      and auth.role() = 'service_role'
    order by e.content <=> p_query_embedding
    limit 12
  ) t
  where t.chunk_text is not null
  order by t.distance asc;
$$;
