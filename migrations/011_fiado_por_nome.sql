-- Migration 011: Fiado usa o nome diretamente nos lançamentos.
--
-- O cadastro separado de pessoas é removido. Vendas e pagamentos preservam o
-- nome histórico em pessoa_nome, sempre preenchido e sem espaços nas pontas.

alter table public.fiado_vendas add column pessoa_nome text;
alter table public.fiado_pagamentos add column pessoa_nome text;

update public.fiado_vendas as venda
set pessoa_nome = btrim(pessoa.nome)
from public.fiado_pessoas as pessoa
where pessoa.id = venda.pessoa_id;

update public.fiado_pagamentos as pagamento
set pessoa_nome = btrim(pessoa.nome)
from public.fiado_pessoas as pessoa
where pessoa.id = pagamento.pessoa_id;

alter table public.fiado_vendas
  alter column pessoa_nome set not null,
  add constraint fiado_vendas_pessoa_nome_valido
    check (pessoa_nome = btrim(pessoa_nome) and pessoa_nome <> '');

alter table public.fiado_pagamentos
  alter column pessoa_nome set not null,
  add constraint fiado_pagamentos_pessoa_nome_valido
    check (pessoa_nome = btrim(pessoa_nome) and pessoa_nome <> '');

create index fiado_vendas_pessoa_nome_normalizado
  on public.fiado_vendas (lower(pessoa_nome));

create index fiado_pagamentos_pessoa_nome_normalizado
  on public.fiado_pagamentos (lower(pessoa_nome));

alter table public.fiado_vendas drop constraint fiado_vendas_pessoa_id_fkey;
alter table public.fiado_pagamentos drop constraint fiado_pagamentos_pessoa_id_fkey;
alter table public.fiado_vendas drop column pessoa_id;
alter table public.fiado_pagamentos drop column pessoa_id;
drop table public.fiado_pessoas;

create function public.validar_saldo_fiado()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  nome_antigo text;
  nome_novo text;
  total_vendas numeric(12,2);
  total_pagamentos numeric(12,2);
begin
  if tg_table_name = 'fiado_pagamentos' and tg_op <> 'DELETE' then
    nome_novo := lower(btrim(new.pessoa_nome));
    select coalesce(sum(valor), 0) into total_vendas
    from public.fiado_vendas
    where lower(pessoa_nome) = nome_novo;

    select coalesce(sum(valor), 0) into total_pagamentos
    from public.fiado_pagamentos
    where lower(pessoa_nome) = nome_novo
      and (tg_op <> 'UPDATE' or id <> new.id);

    if total_pagamentos + new.valor > total_vendas then
      raise exception 'Pagamento não pode ultrapassar o saldo do fiado';
    end if;
  end if;

  if tg_table_name = 'fiado_vendas' and tg_op <> 'INSERT' then
    nome_antigo := lower(btrim(old.pessoa_nome));
    select coalesce(sum(valor), 0) into total_vendas
    from public.fiado_vendas
    where lower(pessoa_nome) = nome_antigo
      and id <> old.id;

    if tg_op = 'UPDATE' and lower(btrim(new.pessoa_nome)) = nome_antigo then
      total_vendas := total_vendas + new.valor;
    end if;

    select coalesce(sum(valor), 0) into total_pagamentos
    from public.fiado_pagamentos
    where lower(pessoa_nome) = nome_antigo;

    if total_pagamentos > total_vendas then
      raise exception 'Venda não pode ser removida ou reduzida abaixo dos pagamentos do fiado';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke execute on function public.validar_saldo_fiado() from public, anon, authenticated;

create trigger validar_saldo_fiado_vendas
  before update or delete on public.fiado_vendas
  for each row execute function public.validar_saldo_fiado();

create trigger validar_saldo_fiado_pagamentos
  before insert or update on public.fiado_pagamentos
  for each row execute function public.validar_saldo_fiado();
