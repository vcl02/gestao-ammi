-- Migration 017: permite registrar venda de R$ 0 no Salário.
--
-- Uma venda esquecida lançada com valor 0 sinaliza que a loja não abriu
-- naquele dia: o dia deixa de ser cobrado pelo aviso de vendas faltando e não
-- gera comissão. Pagamentos continuam exigindo valor positivo.

alter table public.salario_lancamentos
  drop constraint salario_lancamentos_valor_check,
  add constraint salario_lancamentos_valor_check check (
    valor > 0 or (tipo = 'venda' and valor = 0)
  );
