-- Migration 020: vencimentos de Empréstimo e Cartão nos cards semanais.
--
-- O Cartão vence todo mês no mesmo dia: o app usa o dia_vencimento do
-- movimento mais recente que o tiver preenchido (o usuário define por UPDATE).
-- O Empréstimo vence de uma vez: a data de finalização é gravada na dívida
-- criada quando o valor atual informado passa do saldo devido. Movimentos
-- existentes ficam NULL e, enquanto nenhum tiver o campo, nada entra nos cards.

alter table public.cartao_credito_lancamentos
  add column if not exists dia_vencimento smallint
    check (dia_vencimento between 1 and 31);

alter table public.emprestimo_lancamentos
  add column if not exists data_vencimento date
    check (data_vencimento is null or tipo = 'divida');
