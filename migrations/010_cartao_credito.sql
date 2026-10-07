-- Migration 010: histórico e saldo do Cartão de Crédito.
--
-- Cada linha é um movimento positivo. O sinal do saldo é definido por tipo:
-- 'divida' aumenta o valor devido e 'abatimento' o reduz. O aplicativo não
-- permite registrar abatimento acima do saldo vigente.

create table public.cartao_credito_lancamentos (
  id          uuid primary key default gen_random_uuid(),
  tipo        text not null check (tipo in ('divida', 'abatimento')),
  valor       numeric(12,2) not null check (valor > 0),
  data        date not null,
  created_at  timestamptz not null default now()
);

create index cartao_credito_lancamentos_data
  on public.cartao_credito_lancamentos (data desc, created_at desc);

alter table public.cartao_credito_lancamentos enable row level security;

revoke all on table public.cartao_credito_lancamentos from anon;
grant select, insert, delete on table public.cartao_credito_lancamentos to authenticated;

create policy "auth_all" on public.cartao_credito_lancamentos
  for all to authenticated using (true) with check (true);

create trigger auditoria_linha
  after insert or update or delete on public.cartao_credito_lancamentos
  for each row execute function audit_private.registrar_auditoria_linha();
