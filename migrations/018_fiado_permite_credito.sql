-- Migration 018: o Fiado passa a aceitar crédito do cliente.
--
-- Um pagamento maior que a dívida deixa o saldo da pessoa negativo, o que
-- representa crédito dela com a loja, abatido pelas próximas vendas. Remover
-- uma venda também pode deixar o saldo negativo. O trigger da migration 013
-- impedia os dois casos e deixa de existir.

drop trigger validar_saldo_fiado_lancamento on public.fiado_lancamentos;
drop function public.validar_saldo_fiado_lancamento();
