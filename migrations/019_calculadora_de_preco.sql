-- Migration 019: dados para a calculadora de preço.
--
-- Cada conta passa a dizer que tipo de gasto ela é, para a calculadora separar
-- custos fixos, impostos e compras de mercadoria a partir do histórico real.
-- As contas existentes são classificadas pelo nome; as demais ficam como fixa.
--
-- calculadora_config guarda, numa linha única, as taxas da maquininha, a
-- proporção das vendas em crédito e débito e as categorias de produto com o
-- lucro desejado de cada uma.

alter table public.contas_pagar
  add column categoria text not null default 'fixa'
    check (categoria in ('fixa', 'imposto', 'mercadoria'));

update public.contas_pagar set categoria = 'imposto'
where lower(btrim(descricao)) in ('das', 'dare');

update public.contas_pagar set categoria = 'mercadoria'
where lower(btrim(descricao)) in ('bello festas', 'darnel', 'junco');

create table public.calculadora_config (
  id            boolean primary key default true check (id),
  taxa_credito  numeric(5,2) not null default 3.15 check (taxa_credito >= 0 and taxa_credito < 100),
  taxa_debito   numeric(5,2) not null default 1.37 check (taxa_debito >= 0 and taxa_debito < 100),
  mix_credito   numeric(5,2) not null default 100,
  mix_debito    numeric(5,2) not null default 0,
  categorias    jsonb not null default '[]'::jsonb,
  updated_at    timestamptz not null default now(),
  constraint calculadora_config_mix_valido check (
    mix_credito >= 0 and mix_debito >= 0 and mix_credito + mix_debito <= 100
  )
);

insert into public.calculadora_config (categorias) values ('[
  {"nome": "Doces", "lucro": 15},
  {"nome": "Festa e decoração", "lucro": 15},
  {"nome": "Descartáveis e embalagens", "lucro": 5}
]'::jsonb);

alter table public.calculadora_config enable row level security;

revoke all on table public.calculadora_config from anon;
grant select, insert, update on table public.calculadora_config to authenticated;

create policy "auth_all" on public.calculadora_config
  for all to authenticated using (true) with check (true);

create trigger auditoria_linha
  after insert or update or delete on public.calculadora_config
  for each row execute function audit_private.registrar_auditoria_linha();
