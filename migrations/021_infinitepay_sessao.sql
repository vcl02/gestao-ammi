-- Migration 021: sessão da InfinitePay guardada só no servidor.
--
-- Guarda as requisições copiadas do painel da InfinitePay como cURL e já
-- interpretadas (url, metodo, headers, corpo): a do read-token, que leva o
-- cookie de sessão, e a do balance, guardada sem o Bearer. Também guarda o JWT
-- de leitura em cache (vale ~30 min). Quem lê e grava é apenas a Edge
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
  id                     smallint primary key default 1 check (id = 1),
  requisicao_read_token  jsonb,
  requisicao_balance     jsonb,
  jwt                    text,
  jwt_expira_em          timestamptz,
  atualizado_em          timestamptz not null default now()
);

alter table public.infinitepay_sessao enable row level security;
revoke all on public.infinitepay_sessao from public, anon, authenticated;
