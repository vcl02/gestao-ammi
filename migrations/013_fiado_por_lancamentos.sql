-- Migration 013: Fiado passa a usar uma única tabela de lançamentos.
--
-- Vendas aumentam o saldo devido; pagamentos o reduzem. O histórico existente
-- é copiado com suas datas e timestamps antes de as duas tabelas antigas saírem.

create table public.fiado_lancamentos (
  id          uuid primary key default gen_random_uuid(),
  pessoa_nome text not null check (pessoa_nome = btrim(pessoa_nome) and pessoa_nome <> ''),
  tipo        text not null check (tipo in ('venda', 'pagamento')),
  valor       numeric(12,2) not null check (valor > 0),
  descricao   text,
  data        date not null,
  created_at  timestamptz not null default now()
);

create index fiado_lancamentos_pessoa_nome_normalizado
  on public.fiado_lancamentos (lower(pessoa_nome));
create index fiado_lancamentos_data
  on public.fiado_lancamentos (data desc, created_at desc);

alter table public.fiado_lancamentos enable row level security;
revoke all on table public.fiado_lancamentos from anon;
grant select, insert, delete on table public.fiado_lancamentos to authenticated;

create policy "auth_all" on public.fiado_lancamentos
  for all to authenticated using (true) with check (true);

create trigger auditoria_linha
  after insert or update or delete on public.fiado_lancamentos
  for each row execute function audit_private.registrar_auditoria_linha();

insert into public.fiado_lancamentos (id, pessoa_nome, tipo, valor, descricao, data, created_at)
select id, pessoa_nome, 'venda', valor, descricao, data, created_at
from public.fiado_vendas
union all
select id, pessoa_nome, 'pagamento', valor, descricao, data, created_at
from public.fiado_pagamentos;

create function public.validar_saldo_fiado_lancamento()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  total_vendas numeric(12,2);
  total_pagamentos numeric(12,2);
begin
  if tg_op = 'INSERT' and new.tipo = 'pagamento' then
    select coalesce(sum(valor) filter (where tipo = 'venda'), 0),
           coalesce(sum(valor) filter (where tipo = 'pagamento'), 0)
      into total_vendas, total_pagamentos
      from public.fiado_lancamentos
     where lower(pessoa_nome) = lower(btrim(new.pessoa_nome));

    if total_pagamentos + new.valor > total_vendas then
      raise exception 'Pagamento não pode ultrapassar o saldo do fiado';
    end if;
  end if;

  if tg_op = 'DELETE' and old.tipo = 'venda' then
    select coalesce(sum(valor) filter (where tipo = 'venda' and id <> old.id), 0),
           coalesce(sum(valor) filter (where tipo = 'pagamento'), 0)
      into total_vendas, total_pagamentos
      from public.fiado_lancamentos
     where lower(pessoa_nome) = lower(btrim(old.pessoa_nome));

    if total_pagamentos > total_vendas then
      raise exception 'Venda não pode ser removida abaixo dos pagamentos do fiado';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke execute on function public.validar_saldo_fiado_lancamento() from public, anon, authenticated;

create trigger validar_saldo_fiado_lancamento
  before insert or delete on public.fiado_lancamentos
  for each row execute function public.validar_saldo_fiado_lancamento();

drop table public.fiado_pagamentos;
drop table public.fiado_vendas;
drop function public.validar_saldo_fiado();
