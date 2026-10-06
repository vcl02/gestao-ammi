-- Migration 007: integrações automáticas ao pagar contas.
--
-- Uma conta pessoal cria um pagamento vinculado no Salário quando sua
-- ocorrência é marcada como paga. O vínculo composto garante no banco que:
-- - uma ocorrência gera no máximo um pagamento automático no Salário;
-- - desmarcar a ocorrência remove esse pagamento por cascade;
-- - pagamentos manuais do Salário, com as duas colunas nulas, não são afetados.
--
-- Uma conta paga com o Caixa Casa cria uma saída com o mesmo tipo de vínculo.
-- O Aluguel sempre usa o Caixa; nas demais contas a interface pergunta.

alter table public.contas_pagar
  add column pessoal boolean not null default false;

alter table public.salario_lancamentos
  add column conta_pagar_id uuid,
  add column data_ocorrencia date,
  add constraint salario_conta_pessoal_vinculo_completo check (
    (conta_pagar_id is null and data_ocorrencia is null) or
    (
      conta_pagar_id is not null and
      data_ocorrencia is not null and
      tipo = 'pagamento' and
      data = data_ocorrencia
    )
  ),
  add constraint salario_conta_pessoal_pagamento_fkey foreign key (conta_pagar_id, data_ocorrencia)
    references public.contas_pagar_pagamentos (conta_id, data) on delete cascade,
  add constraint salario_conta_pessoal_pagamento_unique unique (conta_pagar_id, data_ocorrencia);

alter table public.caixa_casa_lancamentos
  add column conta_pagar_id uuid,
  add column data_ocorrencia date,
  add constraint caixa_conta_paga_vinculo_completo check (
    (conta_pagar_id is null and data_ocorrencia is null) or
    (
      conta_pagar_id is not null and
      data_ocorrencia is not null and
      tipo = 'saida' and
      data = data_ocorrencia
    )
  ),
  add constraint caixa_conta_paga_pagamento_fkey foreign key (conta_pagar_id, data_ocorrencia)
    references public.contas_pagar_pagamentos (conta_id, data) on delete cascade,
  add constraint caixa_conta_paga_pagamento_unique unique (conta_pagar_id, data_ocorrencia);
