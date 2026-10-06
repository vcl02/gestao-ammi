-- Migration 008: auditoria linha a linha das tabelas do aplicativo.
-- Registra INSERT, UPDATE e DELETE feitos depois da aplicação desta migration.
-- SELECT não altera dados e, portanto, não gera log. DDL continua documentado
-- pelos arquivos e pelo histórico de migrations.

create schema audit_private;
revoke all on schema audit_private from public, anon, authenticated;

create table public.auditoria_db (
  id                bigint generated always as identity primary key,
  momento           timestamptz not null default now(),
  transacao_id      bigint not null default txid_current(),
  usuario_id        uuid,
  tabela            text not null,
  operacao          text not null check (operacao in ('INSERT', 'UPDATE', 'DELETE')),
  chave             jsonb not null default '{}'::jsonb,
  dados_anteriores  jsonb,
  dados_novos       jsonb,
  diferencas        jsonb not null
);

create index auditoria_db_momento on public.auditoria_db (momento desc);
create index auditoria_db_tabela_momento on public.auditoria_db (tabela, momento desc);

alter table public.auditoria_db enable row level security;
revoke all on public.auditoria_db from public, anon, authenticated;
revoke all on sequence public.auditoria_db_id_seq from public, anon, authenticated;
grant select on public.auditoria_db to authenticated;

create policy "auth_read" on public.auditoria_db
  for select to authenticated using (true);

create function audit_private.registrar_auditoria_linha()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  anteriores jsonb;
  novos jsonb;
  linha jsonb;
  chave_linha jsonb;
  mudancas jsonb;
begin
  if tg_op = 'INSERT' then
    anteriores := null;
    novos := to_jsonb(new);
  elsif tg_op = 'UPDATE' then
    anteriores := to_jsonb(old);
    novos := to_jsonb(new);
  else
    anteriores := to_jsonb(old);
    novos := null;
  end if;

  linha := coalesce(novos, anteriores, '{}'::jsonb);
  if linha ? 'id' then
    chave_linha := jsonb_build_object('id', linha -> 'id');
  elsif linha ? 'conta_id' and linha ? 'data' then
    chave_linha := jsonb_build_object('conta_id', linha -> 'conta_id', 'data', linha -> 'data');
  else
    chave_linha := '{}'::jsonb;
  end if;

  select coalesce(
    jsonb_object_agg(
      campo,
      jsonb_build_object(
        'antes', coalesce(anteriores, '{}'::jsonb) -> campo,
        'depois', coalesce(novos, '{}'::jsonb) -> campo
      )
    ),
    '{}'::jsonb
  )
  into mudancas
  from jsonb_object_keys(coalesce(anteriores, '{}'::jsonb) || coalesce(novos, '{}'::jsonb)) as campos(campo)
  where coalesce(anteriores, '{}'::jsonb) -> campo
    is distinct from coalesce(novos, '{}'::jsonb) -> campo;

  insert into public.auditoria_db (
    usuario_id,
    tabela,
    operacao,
    chave,
    dados_anteriores,
    dados_novos,
    diferencas
  ) values (
    auth.uid(),
    tg_table_name,
    tg_op,
    chave_linha,
    anteriores,
    novos,
    mudancas
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function audit_private.registrar_auditoria_linha() from public, anon, authenticated;

do $$
declare
  nome_tabela text;
begin
  foreach nome_tabela in array array[
    'caixa_casa_lancamentos',
    'salario_lancamentos',
    'contas_pagar',
    'contas_pagar_exdates',
    'contas_pagar_parcelas',
    'contas_pagar_pagamentos',
    'contas_pagar_ajustes',
    'emprestimo_aportes',
    'fiado_pessoas',
    'fiado_vendas',
    'fiado_pagamentos'
  ] loop
    execute format(
      'create trigger auditoria_linha after insert or update or delete on public.%I for each row execute function audit_private.registrar_auditoria_linha()',
      nome_tabela
    );
  end loop;
end;
$$;
