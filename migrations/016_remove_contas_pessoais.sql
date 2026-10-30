-- Migration 016: remove as contas pessoais.
--
-- A funcionalidade saiu do aplicativo. Os lançamentos que os pagamentos dessas
-- contas criaram no Salário, no Caixa Casa e na Roberta são desvinculados antes
-- da exclusão: continuam existindo como lançamentos manuais, e os saldos não
-- mudam. Sem isso, a exclusão das contas os apagaria por cascata.
--
-- Rode este arquivo no SQL Editor somente depois que o código sem contas
-- pessoais estiver publicado: a versão anterior grava a coluna `pessoal` ao
-- cadastrar contas.

begin;

update public.salario_lancamentos
set conta_pagar_id = null, data_ocorrencia = null
where conta_pagar_id in (select id from public.contas_pagar where pessoal);

update public.caixa_casa_lancamentos
set conta_pagar_id = null, data_ocorrencia = null
where conta_pagar_id in (select id from public.contas_pagar where pessoal);

update public.roberta_lancamentos
set conta_pagar_id = null, data_ocorrencia = null
where conta_pagar_id in (select id from public.contas_pagar where pessoal);

delete from public.contas_pagar where pessoal;

alter table public.contas_pagar drop column pessoal;

commit;
