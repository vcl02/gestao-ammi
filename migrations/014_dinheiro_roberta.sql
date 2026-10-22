-- Migration 014: pagar contas com o dinheiro da Roberta.
--
-- A baixa de uma ocorrência passa a registrar também a parte do acumulado
-- paga com dinheiro da Roberta. Essa parte vira uma dívida vinculada no novo
-- livro da Roberta, com o mesmo vínculo (conta_pagar_id, data_ocorrencia) já
-- usado por Salário e Caixa Casa: desmarcar a ocorrência remove a dívida por
-- cascade. Dívidas e abatimentos manuais ficam com as duas colunas nulas.

alter table public.contas_pagar_pagamentos
  add column valor_roberta numeric(12,2) not null default 0,
  add constraint contas_pagar_pagamentos_valor_roberta_valido check (
    valor_roberta >= 0 and valor_caixa + valor_roberta <= valor_pago
  );

create table public.roberta_lancamentos (
  id               uuid primary key default gen_random_uuid(),
  tipo             text not null check (tipo in ('divida', 'abatimento')),
  valor            numeric(12,2) not null check (valor > 0),
  data             date not null,
  descricao        text,
  conta_pagar_id   uuid,
  data_ocorrencia  date,
  created_at       timestamptz not null default now(),
  constraint roberta_conta_paga_vinculo_completo check (
    (conta_pagar_id is null and data_ocorrencia is null) or
    (
      conta_pagar_id is not null and
      data_ocorrencia is not null and
      tipo = 'divida' and
      data = data_ocorrencia
    )
  ),
  constraint roberta_conta_paga_pagamento_fkey foreign key (conta_pagar_id, data_ocorrencia)
    references public.contas_pagar_pagamentos (conta_id, data) on delete cascade,
  constraint roberta_conta_paga_pagamento_unique unique (conta_pagar_id, data_ocorrencia)
);

create index roberta_lancamentos_data
  on public.roberta_lancamentos (data desc, created_at desc);

alter table public.roberta_lancamentos enable row level security;

revoke all on table public.roberta_lancamentos from anon;
grant select, insert, update, delete on table public.roberta_lancamentos to authenticated;

create policy "auth_all" on public.roberta_lancamentos
  for all to authenticated using (true) with check (true);

create trigger auditoria_linha
  after insert or update or delete on public.roberta_lancamentos
  for each row execute function audit_private.registrar_auditoria_linha();
