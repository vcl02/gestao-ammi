-- Migration 009: valores parciais nas baixas de Contas a Pagar.
--
-- A linha de pagamento continua única por ocorrência. valor_pago guarda o
-- acumulado já quitado e valor_caixa guarda a parte desse acumulado que saiu
-- do Caixa Casa. As baixas antigas são preenchidas com o valor integral da
-- ocorrência para preservar o comportamento existente.

alter table public.contas_pagar_pagamentos
  add column valor_pago numeric(12,2),
  add column valor_caixa numeric(12,2) not null default 0;

update public.contas_pagar_pagamentos as pagamento
set valor_pago = case
  when conta.tipo = 'parcelado' then (
    select parcela.valor
    from public.contas_pagar_parcelas as parcela
    where parcela.conta_id = pagamento.conta_id
      and parcela.data = pagamento.data
  )
  else coalesce(
    (
      select ajuste.valor
      from public.contas_pagar_ajustes as ajuste
      where ajuste.conta_id = pagamento.conta_id
        and ajuste.data = pagamento.data
    ),
    conta.valor
  )
end
from public.contas_pagar as conta
where conta.id = pagamento.conta_id;

update public.contas_pagar_pagamentos as pagamento
set valor_caixa = saida.valor
from public.caixa_casa_lancamentos as saida
where saida.conta_pagar_id = pagamento.conta_id
  and saida.data_ocorrencia = pagamento.data;

alter table public.contas_pagar_pagamentos
  alter column valor_pago set not null,
  add constraint contas_pagar_pagamentos_valor_pago_positivo check (valor_pago > 0),
  add constraint contas_pagar_pagamentos_valor_caixa_valido check (
    valor_caixa >= 0 and valor_caixa <= valor_pago
  );
