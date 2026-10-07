-- Migration 012: Empréstimo passa a usar o mesmo livro de movimentos do Cartão.
--
-- Dívidas e abatimentos são linhas independentes. Os Empréstimos especiais
-- anteriores são convertidos preservando seus valores, datas e saldo atual;
-- depois a conta e os aportes legados deixam de existir.

create table public.emprestimo_lancamentos (
  id          uuid primary key default gen_random_uuid(),
  tipo        text not null check (tipo in ('divida', 'abatimento')),
  valor       numeric(12,2) not null check (valor > 0),
  data        date not null,
  created_at  timestamptz not null default now()
);

create index emprestimo_lancamentos_data
  on public.emprestimo_lancamentos (data desc, created_at desc);

alter table public.emprestimo_lancamentos enable row level security;

revoke all on table public.emprestimo_lancamentos from anon;
grant select, insert, delete on table public.emprestimo_lancamentos to authenticated;

create policy "auth_all" on public.emprestimo_lancamentos
  for all to authenticated using (true) with check (true);

create trigger auditoria_linha
  after insert or update or delete on public.emprestimo_lancamentos
  for each row execute function audit_private.registrar_auditoria_linha();

-- A conta parcelada legada vira uma dívida por parcela; uma conta mensal
-- legada, caso exista, vira uma dívida na sua data inicial.
insert into public.emprestimo_lancamentos (tipo, valor, data)
select 'divida', parcela.valor, parcela.data
from public.contas_pagar as conta
join public.contas_pagar_parcelas as parcela on parcela.conta_id = conta.id
where lower(btrim(conta.descricao)) = lower('Empréstimo')
union all
select 'divida', conta.valor, conta.data_inicio
from public.contas_pagar as conta
where lower(btrim(conta.descricao)) = lower('Empréstimo')
  and conta.tipo = 'mensal';

-- Cada aporte preservado passa a ser um abatimento com sua data original.
insert into public.emprestimo_lancamentos (tipo, valor, data)
select 'abatimento', aporte.valor, aporte.data
from public.emprestimo_aportes as aporte
join public.contas_pagar as conta on conta.id = aporte.conta_id
where lower(btrim(conta.descricao)) = lower('Empréstimo');

-- A origem antiga não é mais necessária: o novo histórico contém os dois
-- lados do saldo e a auditoria registra a exclusão em cascata.
delete from public.contas_pagar
where lower(btrim(descricao)) = lower('Empréstimo');

drop table public.emprestimo_aportes;
