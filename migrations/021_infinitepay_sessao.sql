-- Migration 021: sessão da InfinitePay guardada só no servidor.
--
-- Guarda o cookie de sessão da InfinitePay, o user_id que o read-token pede e
-- o JWT de leitura em cache (vale ~30 min). Quem lê e grava é apenas a Edge
-- Function infinitepay-saldo, com a service role. Por isso a tabela tem RLS
-- ligado e NENHUMA policy, e os papéis do app perdem todo acesso: o navegador
-- nunca consegue ler o cookie, nem por /rest/v1. Exceção deliberada ao padrão
-- auth_all das outras tabelas.
--
-- Também fica fora da auditoria (migration 008) de propósito: auditar copiaria
-- o cookie para auditoria_db, que os usuários do app podem ler.
--
-- Uma linha só (id = 1): existe uma única conta InfinitePay.

create table if not exists public.infinitepay_sessao (
  id             smallint primary key default 1 check (id = 1),
  user_id        text not null,
  cookie         text not null,
  jwt            text,
  jwt_expira_em  timestamptz,
  atualizado_em  timestamptz not null default now()
);

alter table public.infinitepay_sessao enable row level security;
revoke all on public.infinitepay_sessao from public, anon, authenticated;
