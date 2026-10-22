-- Migration 015: fecha o acesso via API à função rls_auto_enable.
--
-- A função é disparada pelo event trigger ensure_rls e liga o RLS em toda
-- tabela nova do schema public; ela continua existindo. Só os papéis da API
-- perdem o EXECUTE, que eles nunca precisaram: o event trigger roda como
-- postgres. Isso resolve o alerta do Supabase de função SECURITY DEFINER
-- executável por anon/authenticated via /rest/v1/rpc/rls_auto_enable.

revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
