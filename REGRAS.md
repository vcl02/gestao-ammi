# Regras de negócio — Gestão Ammi

Documento de referência das **regras, cálculos e decisões** do sistema.
Não trata de stack, setup ou como rodar — só do que o sistema faz e por quê.
O objetivo é que essas regras não se percam com o tempo, já que boa parte
delas não é óbvia lendo o código e nenhuma está registrada em outro lugar.

Última revisão: 2026-11-28 (saldo da InfinitePay descontado do card de Contas a Pagar).

---

## Índice

- [Conceitos gerais](#conceitos-gerais)
- [Saldo da InfinitePay](#saldo-da-infinitepay)
- [Módulo: Caixa Casa](#módulo-caixa-casa)
- [Módulo: Salário](#módulo-salário)
- [Módulo: Contas a Pagar](#módulo-contas-a-pagar)
  - [Conta Mensal (recorrente)](#conta-mensal-recorrente)
  - [Conta Parcelada](#conta-parcelada)
  - [Seleção para soma](#seleção-para-soma)
  - [Pagamento de ocorrências](#pagamento-de-ocorrências)
  - [Pular ocorrência](#pular-ocorrência)
  - [Ajuste de valor](#ajuste-de-valor)
  - [Atrasadas](#atrasadas)
  - [Abatimento do Caixa Casa no aluguel](#abatimento-do-caixa-casa-no-aluguel)
  - [Card do topo: esta semana e a próxima](#card-do-topo-esta-semana-e-a-próxima)
  - [Agrupamento por semana](#agrupamento-por-semana)
- [Blocos independentes: Empréstimo, Cartão de Crédito e Roberta](#blocos-independentes-empréstimo-cartão-de-crédito-e-roberta)
  - [Vencimento de Empréstimo e Cartão nos cards semanais](#vencimento-de-empréstimo-e-cartão-nos-cards-semanais)
  - [Empréstimo](#empréstimo)
  - [Cartão de Crédito](#cartão-de-crédito)
  - [Roberta](#roberta)
- [Módulo: Fiado](#módulo-fiado)
- [Funcionalidades removidas](#funcionalidades-removidas)
- [Regras transversais](#regras-transversais)
  - [Auditoria do banco](#auditoria-do-banco)
  - [Edição e exclusão de lançamentos](#edição-e-exclusão-de-lançamentos)
  - [Exclusão de conta é em cascata](#exclusão-de-conta-é-em-cascata)
- [Testes de regressão](#testes-de-regressão)
- [Comportamentos conhecidos e limitações](#comportamentos-conhecidos-e-limitações)

---

## Conceitos gerais

### Identificação da empresa

O CNPJ da empresa, `47.154.673/0001-60`, aparece em texto discreto: no desktop,
numa linha no topo acima dos quatro painéis, alinhada ao botão Sair, em
tamanho do título dos painéis; no
mobile, abaixo do menu da tela inicial. É só exibição, sem uso em cálculos.

### Integrações entre os módulos

Caixa Casa e Contas a Pagar se comunicam na exibição do primeiro aluguel
aberto, conforme a regra documentada em [Abatimento do Caixa Casa no
aluguel](#abatimento-do-caixa-casa-no-aluguel).

Uma venda lançada no módulo Salário cria apenas a comissão salarial. Ela não
movimenta o Empréstimo, que é controlado manualmente em seu próprio bloco.

Pagar uma conta em Contas a Pagar pode criar lançamentos automáticos: pagar
com o Caixa Casa gera saída no Caixa, e pagar com o Dinheiro Roberta gera
dívida no bloco Roberta. A origem do dinheiro é escolhida em cada pagamento.
Contas a Pagar não cria lançamentos no Salário.

### Dinheiro

- Todo valor é `numeric(12,2)` no banco e sempre **positivo** (`check (valor > 0)`).
  Única exceção: venda do Salário com valor `0`, que marca dia de loja fechada.
- O sinal (entrada/saída) vem do campo `tipo`, nunca do sinal do número.
- Arredondamento sempre a 2 casas, via `Math.round(n * 100) / 100`.
- Entrada do usuário aceita o formato brasileiro (`1.234,56`): o ponto é
  separador de milhar e a vírgula é decimal. A máscara aplica isso enquanto
  a pessoa digita, tratando os dígitos como centavos da direita para a
  esquerda (digitar `12345` resulta em `123,45`).
- **Todo campo de valor usa essa máscara**, inclusive os que abrem em janela:
  valor atual do Empréstimo, `+`/`−` do Cartão de Crédito e da Roberta, e o
  lápis que edita o valor de uma ocorrência. Essas janelas são do próprio app
  (não o `prompt()` do navegador), vêm preenchidas quando há um valor sugerido
  e mostram o erro na própria janela; fechar (×, Esc) cancela sem gravar. Só o
  valor atual do Empréstimo aceita `0,00`. Todas as janelas do app ficam fixas
  e centralizadas na tela visível: abrir ou fechar não rola a página.
- A leitura aceita também o formato com ponto decimal (`77.62`); a regra
  exata está no comentário de `parseMoney`, no `app.js`.

### Datas

- Datas são sempre `YYYY-MM-DD` (string) e "hoje" é sempre o de
  **America/Sao_Paulo**, não o do aparelho. Os motivos estão no comentário de
  `hojeISO`, no `app.js`.
- Exibição é sempre `DD/MM/AAAA`.

### Acesso

Todos os usuários autenticados veem e editam **os mesmos dados**. Não há
separação por usuário, nem papéis/permissões diferentes. Quem tem login vê
tudo. O cadastro público de novos usuários fica desativado no Supabase, e
os logins são criados manualmente — essa é a única barreira de acesso.

A sessão é limitada a **9 horas** (configurado no painel do Supabase, em
*Authentication → Sessions → Time-box user sessions*). Sem esse ajuste, o
Supabase renovaria o token indefinidamente e a sessão nunca expiraria.

No mobile, após entrar ou restaurar uma sessão, a tela inicial é o formulário
**Pagamento** do Salário, já na aba de saque. No desktop, a tela inicial
continua sendo a Home com os quatro módulos.

### Aplicação instalável

O sistema pode ser instalado pelo Chrome como aplicativo. A instalação usa o
mesmo endereço e dados da versão web; a interface tenta sempre buscar a versão
publicada mais recente e usa o cache local apenas quando não há conexão. Login
e dados financeiros continuam dependendo do Supabase. O modo instalado não
cria uma base de dados local nem permite registrar alterações offline. Os
ícones instaláveis usam versões quadradas de 192 e 512 px do logo da Ammi; a
versão de 192 px também é usada como favicon no navegador.

A chave usada no frontend é a pública (*anon* / *publishable*) e pode ficar
exposta no código — a proteção real vem das políticas de RLS, que exigem
usuário autenticado para qualquer leitura ou escrita.

---

## Saldo da InfinitePay

A Home (mobile) e o topo do desktop mostram o **Saldo** da conta InfinitePay
num bloco em destaque. Ele é consultado ao abrir a Home ou Contas a Pagar e
pelo botão de atualizar, que fica ao lado esquerdo do Sair, no mesmo estilo e
na cor da marca. Esse botão busca só o saldo de novo, sem recarregar a página.

- **Desconto em Contas a Pagar:** do mesmo jeito que o Caixa Casa abate o
  primeiro aluguel aberto, o Saldo é descontado do **primeiro número** do card
  de Contas a Pagar (o que está em destaque: atrasadas + semana mostrada). Logo
  abaixo do número, uma etiqueta mostra quanto foi descontado
  (*−R$ X do Saldo*):

  ```
  desconto  = min(max(saldo_infinitepay, 0), primeiro_card)
  exibido   = primeiro_card − desconto
  ```

  O número que fica é quanto a loja ainda precisa vender. Como usa o mesmo
  valor do card, se o card avançou para outra semana, o desconto acompanha.
  Sem saldo disponível (sessão vencida, erro), o card mostra o valor cheio e a
  etiqueta some. O segundo número (próxima semana) não muda. Não desconta
  taxas de venda da InfinitePay.
- **Validade da sessão:** abaixo do saldo, só aparece quando a sessão vence em
  até 3 dias (amarelo) ou já venceu (vermelho); usa a data que vence primeiro
  entre `ifp_token_exp` e o `ipdashboard_session`. A janela da sessão lista as
  duas (verde com mais de 3 dias) e a do JWT (que renova sozinho; amarelo a
  menos de 5 minutos).

A InfinitePay não tem API pública para isso. A Edge Function
`infinitepay-saldo` reproduz as requisições do painel web: a do `read-token`
(com o cookie de sessão) gera um token de leitura de ~30 min, guardado em
cache no servidor, e a do `balance` usa esse token como Bearer. O saldo
exibido é o campo `free` do `balance`, que corresponde ao *Seu saldo* do painel;
a API devolve em centavos e a função converte para reais.

- **Atualizar a sessão:** tocar no saldo abre a janela *Sessão InfinitePay*.
  Cola-se no campo de texto o cURL das requisições `read-token` e/ou `balance`
  (DevTools → Network → *Copy as cURL*, bash ou cmd; as duas juntas valem). O
  servidor valida o básico: só endereços `https://app.infinitepay.io`, o
  read-token precisa de cookie e de `user_id` no corpo, e o balance de Bearer.
  O que não for colado mantém o que já estava guardado; na primeira vez o
  read-token é obrigatório.
- **Sigilo:** as requisições e o token ficam só na tabela `infinitepay_sessao`,
  que o app não consegue ler (RLS sem policy e sem permissões para os
  usuários) e que fica fora da auditoria. A função devolve só o saldo e as
  datas. O campo é limpo após salvar.
- **Expiração:** a sessão da InfinitePay dura cerca de 7 a 14 dias. Quando ela
  recusa o cookie, o lugar do saldo mostra em vermelho *Sessão expirada, cole o
  cURL de novo*. Outros avisos possíveis: cURL inválido, bloqueio pela
  Cloudflare, resposta em formato desconhecido ou erro na consulta.

---

## Módulo: Caixa Casa

Controla o dinheiro retirado do caixa da loja e guardado fisicamente em casa.

### Lançamentos

Cada lançamento é `entrada` ou `saida`, com valor, data e descrição.

| Campo | Regra |
|---|---|
| `valor` | Obrigatório, maior que zero |
| `data` | Obrigatória, default = hoje |
| `descricao` | **Obrigatória em saídas**, opcional em entradas |

A descrição é obrigatória só para saídas porque a intenção é sempre saber
para onde o dinheiro foi. Entrada sem descrição é aceitável (é só dinheiro
entrando), e nesse caso a lista exibe "Entrada" como rótulo.

### Descrições pré-preenchidas

Ao alternar o tipo, o campo de descrição é **sobrescrito** com um valor padrão:

- Entrada → `Suprimento`
- Saída → `Aluguel`

São os casos mais frequentes na prática. O campo continua editável — o
padrão é só para economizar digitação, não uma categoria fixa.

Atenção: alternar o tipo sobrescreve o que já estava digitado no campo.

### Sem duplicação para o Salário neste formulário

O formulário do Caixa Casa grava apenas no próprio Caixa. A antiga opção
"Duplicar no Salário" foi removida.

### Saldo

```
saldo = Σ(entradas) − Σ(saídas)
```

Calculado **sobre os 50 lançamentos mais recentes**, não sobre o histórico todo
(ver [Comportamentos conhecidos](#comportamentos-conhecidos-e-limitações)).

Saldo negativo é exibido em vermelho. Não há bloqueio para saldo negativo —
o sistema registra o que aconteceu, não impede lançamentos.

O card mostra dois valores:

- **Após aluguel** — valor principal, calculado como
  `max(saldo − primeiro aluguel aberto, 0)`. Abaixo dele, uma etiqueta no
  mesmo estilo da de Contas a Pagar mostra quanto foi descontado
  (*−R$ X do Aluguel*, que é `min(max(saldo, 0), aluguel)`); some quando não
  há aluguel aberto ou o caixa não tem saldo positivo.
- **Total no caixa** — valor secundário, mostra o saldo original sem o
  abatimento do aluguel.

O aluguel usado nessa projeção segue a mesma definição de primeiro aluguel
aberto do módulo Contas a Pagar. O cálculo não cria saída no Caixa Casa.

---

## Módulo: Salário

Controla a remuneração da gerente: comissão sobre vendas menos os pagamentos
já feitos a ela. O saldo representa **quanto ainda é devido**.

### Comissão

```
comissão = valor_da_venda × 0,15
```

O percentual é fixo em **15%** (`PERCENTUAL_COMISSAO`), definido no código.
Até 2026-11-15 era 25%; vendas lançadas antes disso mantêm a comissão de 25%
já gravada.

#### Teto mensal de R$ 800

A comissão somada de um mês nunca passa de **R$ 800** (`TETO_COMISSAO_MES`),
valor definido a partir dos custos mensais da Isabella (~R$ 593: unha, cílios,
Senac e almoços) mais uma folga para ela. Ao salvar uma venda, o sistema busca
no banco a comissão já gravada no **mês da data da venda** e grava:

```
comissão = mínimo(15% da venda, R$ 800 − comissão já gravada no mês)
```

Batido o teto, as vendas seguintes daquele mês são registradas com comissão
`R$ 0,00` (o valor vendido continua em `venda_base`). Vale para o formulário de
venda e para a venda esquecida.

O teto vale para vendas com data a partir de **01/12/2026**
(`TETO_COMISSAO_INICIO`). Vendas de novembro/2026 ou antes têm 15% sem limite:
novembro começou com comissão de 25% e, contando essas comissões, o teto já
estava praticamente batido no dia 20.
Não há como alterar pela interface — mudar exige editar o código.

Quando você lança uma venda:

- O campo "Valor" é o **total vendido**, não a comissão.
- O sistema calcula a comissão e é **ela** que vai para `valor` no banco.
- O total vendido é preservado em `venda_base`, para rastreabilidade.

O botão "Salvar" mostra em tempo real a comissão que será gravada
(ex.: venda de R$ 100,00 mostra `Salvar — R$ 15,00`), para conferência antes de confirmar.

### Sem movimento no Empréstimo ao salvar uma venda

Salvar uma venda registra somente a comissão da gerente. O valor bruto da venda
não é usado para reduzir nenhum Empréstimo. Os movimentos do Empréstimo são
registrados manualmente em seu bloco próprio.

### Pagamento

Um pagamento é dinheiro entregue à gerente, que **abate** o saldo devido.
Descrição tem default `Pagamento` e é obrigatória (se esvaziada, volta a `Pagamento`).

O link **Pagar tudo**, ao lado do campo Valor, preenche o valor com o saldo
atual do Salário, já no formato digitado (ex.: `1.234,50`). Ele não grava nada:
data e descrição continuam editáveis e o pagamento só é registrado ao clicar em
Salvar. Com saldo zerado ou negativo, o link não aparece.
No mobile, esta é a aba aberta automaticamente ao entrar no sistema.

### Saldo

```
saldo = Σ(comissões) − Σ(pagamentos)
```

Interpretação: **saldo positivo = ainda se deve à gerente**. Saldo negativo
significa que ela recebeu adiantado, além do que foi comissionado até então.
O saldo considera **todo o histórico** de lançamentos, inclusive quando a
lista da tela está limitada aos 50 mais recentes.

### Rótulo na lista

Uma venda sem descrição aparece como `Comissão (venda de R$ X)`, onde X é o
`venda_base`. Com descrição preenchida, a descrição substitui esse texto —
e o valor da venda base deixa de aparecer na lista.

### Aviso de dias sem venda

Desde a data da primeira venda registrada, o sistema verifica todos os dias
até **ontem**, exceto domingos. O dia em andamento nunca é avisado, pois a
venda ainda pode ser registrada. Se algum dos demais dias não possuir venda,
mostra um modal começando pelo dia faltante mais antigo. A data é preenchida e
exibida automaticamente; o usuário informa apenas o valor bruto vendido. Ao
salvar, o sistema registra uma venda naquela data, acrescenta sua comissão de
15% ao Salário e avança para o próximo dia faltante, em ordem cronológica, até
chegar ao mais recente.

Se a loja **não abriu** naquele dia, informa-se `0`. O botão passa a dizer
"Salvar — loja fechada" e grava uma venda de valor e comissão `R$ 0,00`, com a
descrição `Loja fechada`. Ela não muda o saldo, mas registra o dia: ele deixa de
ser cobrado pelo aviso nas próximas sessões. O banco aceita valor `0` somente em
vendas (migration 017); pagamentos continuam exigindo valor positivo.

O botão de salvar mostra previamente o valor da comissão. O modal pode ser
fechado sem preencher todos os dias e aparece no máximo uma vez por sessão.

---

## Módulo: Contas a Pagar

Controla contas futuras. Diferente dos outros dois módulos, aqui não se
registra o que já aconteceu — se registra o que **vai** acontecer, e depois
marca-se o que foi pago.

### Princípio central: regra vs. ocorrência

Esta é a decisão de arquitetura mais importante do módulo, e a que menos se
deduz olhando a tela:

> **Ocorrências futuras não são gravadas no banco.** O banco guarda a *regra*
> (ou a lista de parcelas); as datas concretas são calculadas em memória,
> toda vez que a tela carrega.

Por isso uma conta mensal "sem fim" não gera linhas infinitas — ela é uma
linha só, e a lista de datas é derivada dela.

Tudo que é **exceção** à regra (pular, pagar, ajustar valor) vive em tabelas
auxiliares separadas, indexadas por `(conta_id, data)`. A regra original
nunca é alterada por essas ações. O modelo é inspirado no `EXDATE` do
iCalendar, onde a recorrência é uma regra e as exceções são uma lista à parte.

### Os dois tipos de conta

Uma conta é **`recorrente`** (exibida como "Mensal") ou **`parcelado`**.
São mutuamente exclusivos e o banco garante isso por constraint:

| Campo | `recorrente` | `parcelado` |
|---|---|---|
| `valor` | Obrigatório | **Sempre nulo** |
| `dia_vencimento` | Obrigatório (1–31) | **Sempre nulo** |
| `data_inicio` | Data escolhida | Menor data entre as parcelas |
| Datas das ocorrências | Calculadas da regra | Linhas em `contas_pagar_parcelas` |
| Onde mora o valor | `contas_pagar.valor` | `contas_pagar_parcelas.valor` |

---

### Conta Mensal (recorrente)

Repete todo mês no mesmo dia, **sem data de fim**. Não existe recorrência
mensal com prazo — para isso, use Parcelado.

#### Dia do vencimento é derivado, não digitado

O `dia_vencimento` é extraído do dia da data informada em "Data". Escolher
15/03 cria uma conta que vence todo dia 15. Não existe campo separado para
o dia — ele existiria apenas para poder divergir da data, o que seria
contraditório.

#### Meses que não têm o dia

Um `dia_vencimento` de 31 é **ancorado no último dia do mês**: vira 30 em
abril e 28 (ou 29) em fevereiro. A conta continua com dia 31; só a ocorrência
é reduzida (detalhe no comentário de `montarDataOcorrencia`).

#### Quantas ocorrências aparecem

A lista mostra, por conta:

- **Todas** as ocorrências vencidas, pagas ou não (sem limite, desde `data_inicio`)
- As **3 próximas** a partir de hoje (inclusive)

O limite de 3 é sobre as futuras, não sobre o total. Uma conta com 5 meses
de atraso mostra 5 atrasadas + 3 futuras = 8 linhas; as ocorrências já
quitadas também permanecem no respectivo grupo semanal como histórico.

Uma ocorrência já paga **continua aparecendo** (com o checkbox marcado),
inclusive depois do vencimento, e ocupa uma das 3 vagas quando for futura.
Isso é intencional: preserva o histórico do valor ajustado e permite
desmarcar um pagamento feito por engano direto na lista, sem precisar
procurar em outro lugar.

---

### Conta Parcelada

Um número fixo de parcelas com **datas escolhidas manualmente, uma a uma**.
Não há padrão de recorrência: 3 parcelas podem ser 01/01, 15/01 e 01/03.

Isso existe porque nem toda conta parcelada segue um ritmo previsível —
forçá-las num modelo de recorrência exigiria exceções demais.

#### Fluxo

Informa-se a quantidade de parcelas, e o formulário gera esse número de
campos de data para preencher. **Limite: 24 parcelas.** Reduzir a
quantidade remove os campos do fim; aumentar acrescenta campos vazios.

`data_inicio` da conta é preenchida automaticamente com a **menor** data
entre as parcelas (não a primeira digitada — a cronologicamente menor).

#### Repetir vs. Dividir

O switch ao lado do campo Valor define como interpretar o número digitado:

**Repetir** — o valor é de **cada** parcela.
```
3 parcelas, valor 100  →  100, 100, 100   (total 300)
```

**Dividir** — o valor é o **total**, rateado entre as parcelas.
```
3 parcelas, valor 100  →  33,33, 33,33, 33,34   (total 100)
```

Na divisão, a diferença de centavos vai para a última parcela, para a soma
bater exatamente com o total (veja `calcularValoresParcelas`).

O modo escolhido **não é gravado**. Após o cálculo, o banco só guarda o
valor final de cada parcela — não há como saber depois se foi repetido ou
dividido, nem "recalcular" alterando o total.

---

### Seleção para soma

Clicar no **nome** de uma ocorrência apenas a seleciona para soma visual; não
marca nem desmarca o checkbox de pagamento, nem grava qualquer dado. A barra
flutuante mostra a ocorrência única ou a soma de várias ocorrências
selecionadas, identificadas como "N itens". Com duas ou mais, aparece
**Limpar** para remover toda a seleção.
O comportamento é o mesmo no mobile e no desktop. A seleção é só da tela
logada e é limpa ao voltar para o login.

---

### Pagamento de ocorrências

O checkbox grava/apaga uma linha em `contas_pagar_pagamentos` para aquele
`(conta_id, data)`. A combinação desses dois campos também identifica cada
ocorrência ao consultar o pagamento na lista. A linha guarda:

- `valor_pago`: o acumulado quitado;
- `valor_caixa`: a parte desse acumulado que saiu do Caixa Casa;
- `valor_roberta`: a parte desse acumulado paga com dinheiro da Roberta.

`valor_caixa + valor_roberta` nunca passa de `valor_pago`; o restante foi
pago com o próprio dinheiro.

Marcar como paga **não altera** a conta nem a parcela, exceto quando o pagamento
passa do valor da ocorrência (veja abaixo). Ao clicar no checkbox de
qualquer ocorrência aberta — Mensal ou Parcelada — abre uma
janela que pede:

1. **Valor deste pagamento** — começa preenchido com todo o saldo restante e
   aceita um valor menor ou **maior**. Abaixo de R$ 0,01, a janela mostra o
   erro e não grava nada.
2. **Dinheiro usado** — Meu dinheiro, Caixa Casa ou Dinheiro Roberta. Vem
   marcado Meu dinheiro, exceto no **Aluguel** (descrição exatamente
   "Aluguel", ignorando maiúsculas, minúsculas e espaços nas pontas), que vem
   com Caixa Casa marcado, mas pode ser trocado como em qualquer conta.

#### Pagamento acima do valor

Juros, multa ou um valor anotado errado fazem a conta custar mais do que o
cadastrado. Se o total pago (o já pago mais este pagamento) passar do valor da
ocorrência, a janela avisa enquanto se digita — "ela passa de R$ X para R$ Y e
fica quitada" — e, ao pagar, a ocorrência é atualizada para esse total antes de
registrar o pagamento, usando a mesma gravação do
[Ajuste de valor](#ajuste-de-valor):

- Mensal: ajuste pontual em `contas_pagar_ajustes`, só naquela data; o valor
  padrão da conta e os meses seguintes não mudam;
- Parcelada: `UPDATE` do valor daquela parcela.

A ocorrência fica quitada com o novo valor, e os lançamentos vinculados
(Caixa, Roberta) usam o valor efetivamente pago. Se o pagamento
falhar, o valor anterior da ocorrência é restaurado. Desmarcar depois apaga só
o pagamento: a ocorrência mantém o valor atualizado, que pode ser corrigido
pelo lápis.

Fechar a janela (×, Esc) cancela sem gravar. Cada novo pagamento se acumula no
mesmo registro até atingir o valor real da ocorrência, e cada parte pode usar
uma origem diferente. Em conta Mensal, um ajuste pontual já existente faz
parte desse valor.

Enquanto houver saldo, a ocorrência permanece aberta, exibe a tag **Parcial**,
mostra quanto já foi pago e mantém o checkbox em estado intermediário; clicar
nele registra mais um pagamento. O valor principal da linha e os totais
pendentes mostram somente o saldo restante. Os botões de editar valor e pular
somem assim que existe algum pagamento.

Efeitos de cada pagamento, conforme a origem escolhida:

| Origem | Lançamento vinculado |
|---|---|
| Meu dinheiro | nenhum |
| Caixa Casa | saída no Caixa Casa com o acumulado pago pelo Caixa |
| Dinheiro Roberta | dívida no bloco [Roberta](#roberta) com o acumulado pago com o dinheiro dela |

Desmarcar uma ocorrência quitada apaga o registro, ela volta a contar como
totalmente pendente e a cascata remove os lançamentos automáticos vinculados
no Caixa Casa e na Roberta. Lançamentos manuais desses módulos não
possuem o vínculo e não são afetados. Um pagamento parcial é desfeito pela
lixeira de um lançamento vinculado a ele (Caixa ou Roberta), que
desmarca a ocorrência inteira; se o pagamento parcial não tiver nenhum
lançamento vinculado (pago só com o próprio dinheiro),
não há como desfazê-lo pela interface sem antes quitar e desmarcar.

Ocorrências pagas ficam misturadas no mesmo bloco de semana das não pagas,
ordenadas por data como as demais — não há seção separada. A única
diferença visual é o checkbox já vir marcado, e os botões de editar valor
e pular não aparecem numa ocorrência já paga.

---

### Pular ocorrência

O botão "×" remove uma ocorrência específica, mas o efeito **difere por tipo**:

| Tipo | O que acontece | Reversível? |
|---|---|---|
| Mensal | Insere em `contas_pagar_exdates`. A regra continua; só aquela data é omitida. | Só apagando a linha direto no banco |
| Parcelado | **Apaga a parcela** de `contas_pagar_parcelas`. | Não — o dado some |

Em conta Mensal, pular é o mecanismo para "esse mês não teve" sem quebrar a
recorrência dos meses seguintes.

Em conta Parcelada, pular é destrutivo: a parcela deixa de existir e o total
da conta diminui. É a única forma de encurtar um parcelamento.

---

### Ajuste de valor

Permite corrigir o valor de uma ocorrência quando o valor cadastrado era uma
aproximação (conta de luz, água, etc.).

| Tipo | Onde grava | Efeito |
|---|---|---|
| Mensal | `contas_pagar_ajustes` (upsert em `conta_id`+`data`) | Só aquela data. Demais ocorrências seguem com `contas_pagar.valor` |
| Parcelado | `UPDATE` em `contas_pagar_parcelas.valor` | Altera a parcela em definitivo |

Em conta Mensal, o ajuste é **sempre pontual**: nunca altera o valor padrão
da conta nem afeta meses seguintes. Para mudar o valor "de verdade" de uma
conta mensal, não há caminho pela interface — seria preciso recriar a conta.

Na exibição, o valor de cada ocorrência é `ajuste ?? valor_padrão` — o ajuste
tem precedência quando existe.

---

### Atrasadas

Uma ocorrência é **atrasada** quando:

```
data < hoje  E  não está marcada como paga
```

Atrasadas aparecem com borda vermelha e a tag "Atrasada", e **não têm limite
de quantidade** — todas são exibidas, desde a `data_inicio` da conta.

Elas continuam aparecendo indefinidamente até serem pagas ou puladas. É
proposital: uma conta vencida não some da vista sozinha.

---

### Abatimento do Caixa Casa no aluguel

A primeira ocorrência não paga, em ordem de data, cuja descrição da conta
seja exatamente `Aluguel` (sem diferenciar maiúsculas de minúsculas) recebe
um abatimento igual ao saldo positivo do Caixa Casa. O valor exibido nunca
fica abaixo de zero:

```
aluguel_exibido = max(valor_do_aluguel − saldo_do_caixa, 0)
```

Esse valor líquido aparece na linha da ocorrência e no total do seu bloco de
semana. Na linha, ao lado da data, uma etiqueta no mesmo estilo das outras
mostra quanto foi descontado (*−R$ X do Caixa Casa*). Se a mesma semana estiver em um dos dois números do card do topo, o
card também usa o valor líquido. Quando o primeiro aluguel aberto pertence ao
mês corrente, o resumo mensal também usa o valor líquido.

O saldo usado é o do Caixa Casa (50 lançamentos mais recentes). Nenhum
lançamento é criado ou alterado automaticamente por esse abatimento.

### Card do topo: esta semana e a próxima

O topo do módulo mostra dois números lado a lado, ambos representando
**quanto falta pagar** (ocorrências não pagas):

- **Primeiro número** — em destaque, é o principal.
- **Segundo número** — ao lado, em cinza, secundário.

Abaixo, um subtítulo menor mostra o resumo do mês inteiro:

```
R$ X pago de R$ Y no mês
```

```
X = soma das ocorrências do mês corrente que ESTÃO pagas
Y = X + soma das ocorrências do mês corrente que NÃO estão pagas
```

O valor de X (pago) aparece em itálico e branco no subtítulo; o resto do
texto fica na cor discreta padrão.

#### O rótulo reflete a distância real de hoje — nunca mente

Cada número tem um rótulo que muda conforme a distância real da semana
mostrada até hoje:

| Distância | Rótulo |
|---|---|
| 0 semanas | "Esta semana" |
| 1 semana | "Próxima semana" |
| 2+ semanas | "Em N semanas" |

Isso existe porque, quando o card avança (ver abaixo), continuar chamando
uma semana distante de "Esta semana" seria enganoso. O rótulo sempre diz a
verdade sobre quão longe está o que ele mostra.

O primeiro número já sai com o Saldo InfinitePay descontado (ver [Saldo da
InfinitePay](#saldo-da-infinitepay)).

Pendências **atrasadas** de contas comuns são somadas ao primeiro número,
junto com a semana encontrada. Havendo alguma, o rótulo passa a começar por
"Atrasadas +". Empréstimo e Cartão de Crédito entram pelo vencimento (ver
[Vencimento de Empréstimo e Cartão nos cards
semanais](#vencimento-de-empréstimo-e-cartão-nos-cards-semanais)); a Roberta
continua fora dos dois cards.

#### Os dois números avançam quando não há pendência

Se a semana que contém a data de hoje **não tiver nenhuma pendência** (tudo
pago, ou nenhuma ocorrência cai nela), o primeiro número **avança** para a
próxima semana que tiver algo pendente. O segundo número é sempre a semana
seguinte à do primeiro, buscada da mesma forma — então se o primeiro virou
"Em 2 semanas", o segundo busca a partir da semana 3 e pode virar "Em 3
semanas", "Em 4 semanas", etc.

A busca avança semana a semana até achar uma pendência entre as ocorrências
carregadas, incluindo o vencimento de Empréstimo e Cartão. **A Roberta nunca
entra nesses dois cards semanais.** Se não existir nenhuma
pendência comum naquela semana nem depois dela, o card mostra `R$ 0,00`; isso
também impede uma busca infinita quando existem somente contas parceladas
antigas ou Empréstimo.

Enquanto houver pendências futuras carregadas, o card continua respondendo
"o que eu preciso resolver agora" e avança até a primeira delas.

Consequência para a lista abaixo do card: o destaque visual de "semana
atual" nos cabeçalhos (ver [Agrupamento por
semana](#agrupamento-por-semana)) acompanha essa mesma semana "avançada",
não a semana literal de hoje.

#### O total do mês é independente

O subtítulo (`R$ X pago de R$ Y no mês`) **não avança** — é sempre sobre o
mês corrente, mesmo que o card acima esteja mostrando uma semana de outro
mês.

Implicações que não são óbvias:

- **Atrasadas de meses anteriores não entram em nenhum dos dois números do
  subtítulo**, mesmo aparecendo na lista principal. O cálculo é
  estritamente do mês corrente (comparação por `AAAA-MM`).
- Usa o valor efetivo de cada ocorrência (com ajuste aplicado, se houver).

---

### Agrupamento por semana

A lista de ocorrências é dividida em blocos com cabeçalho `Mês — Semana N`.
Cada cabeçalho pode ser acionado para colapsar ou expandir as ocorrências daquela
semana, sem alterar os totais nem os pagamentos. Ao abrir a lista, a semana
destacada como atual começa expandida mesmo se estiver toda paga. Outras
semanas começam expandidas somente se tiverem ocorrências não pagas, inclusive
as futuras ou atrasadas; semanas totalmente pagas começam colapsadas. O bloco
de Empréstimo segue a mesma regra de pendência, mas não a exceção da semana
atual. Ao recarregar a lista após um pagamento, os blocos sem pendências
passam a começar fechados. Uma abertura ou um fechamento feito manualmente
prevalece durante a sessão, mesmo após atualizar a lista.

#### Definição de semana

Semana de **calendário real, começando no domingo**; a Semana 1 pode ter menos
de 7 dias. Ao procurar a próxima semana com pendências, o avanço é até o
**próximo domingo** (em sexta 25/09, a próxima é a Semana 5 de setembro, 27 a
30/09). Os detalhes estão nos comentários de `semanaDoMes` e
`chaveSemanaSeguinte`.

#### Agrupamento é por mês da data

Uma semana que atravessa a virada do mês é **cortada**: 30/09 fica na última
semana de *setembro*, e cada mês fecha suas próprias semanas. A última semana
pode ter poucos dias e **sempre aparece como bloco próprio**. A antiga fusão
das semanas curtas foi removida por decisão do usuário, que prefere vê-las
separadas a perder uma ocorrência de vista.

#### Destaque da semana atual

O cabeçalho da semana que contém a data de hoje ganha uma cor de destaque e
um pontinho ao lado — discreto, mas suficiente para localizar rapidamente
"onde estou" na lista.

#### Total por semana

Cada bloco mostra, no cabeçalho, a soma dos valores de todas as suas
ocorrências (pagas e não pagas), alinhada à direita. Não distingue pago de
não pago — é o total do que está programado para aquela semana.

---

## Blocos independentes: Empréstimo, Cartão de Crédito e Roberta

Aparecem na tela de Contas a Pagar, dentro das Ocorrências, mas **não são
contas**: não entram no resumo mensal e não dependem das regras de
recorrência. Cada um tem a própria tabela de movimentos. A ligação com as
contas é o vencimento de Empréstimo e Cartão, descrito abaixo; a Roberta não
tem vencimento.

### Vencimento de Empréstimo e Cartão nos cards semanais

Empréstimo e Cartão com saldo maior que zero entram com o **saldo inteiro** na
semana em que cai o vencimento (`pendenciasDividasNoResumoSemanal`): viram uma
linha nessa semana da lista de Ocorrências, somam no total do cabeçalho da
semana e entram nos dois números do topo (esta semana / próxima), inclusive
para o card avançar até a próxima semana com pendência. Sem vencimento
preenchido ou com saldo zero, não entram. Continuam fora do resumo "pago de …
no mês".

A linha (`renderizarItemDividaOcorrencia`) segue o visual das outras contas:

- **Checkbox:** quita o saldo inteiro, após confirmação, gravando um
  `abatimento` desse valor. Não pergunta a origem do dinheiro e não lança nada
  no Caixa nem na Roberta. Com o saldo zerado, a linha some.
- **Lápis:** abre o mesmo "Atualizar valor atual" do bloco (valor total da
  dívida).
- Empréstimo com data já passada mostra a tag "Atrasada".

- **Cartão:** vence todo mês no mesmo dia. O dia fica em
  `cartao_credito_lancamentos.dia_vencimento` e o app usa o do movimento mais
  recente que o tiver preenchido. Não há campo na tela: o dia é definido por
  UPDATE no banco. A data usada é a próxima ocorrência desse dia a partir de
  hoje (inclusive); dia inexistente no mês vira o último dia, como nas contas
  mensais. Por isso o Cartão nunca fica atrasado: passado o dia, ele vai para
  o mês seguinte.
- **Empréstimo:** vence de uma vez, na data de finalização. A data fica em
  `emprestimo_lancamentos.data_vencimento`, só em movimentos `divida`, e vale
  a do movimento mais recente que a tiver. Passada a data com saldo, ele entra
  nas **atrasadas** e aparece toda semana em "Atrasadas +" até zerar.

Os movimentos anteriores à migration 020 ficam com os dois campos nulos.

### Empréstimo

O Empréstimo é independente de Contas a Pagar, igual ao Cartão de Crédito.
Ele aparece sempre em um bloco próprio nas Ocorrências, antes do Cartão, sem
data de cadastro nem resumo mensal. Só a data de finalização o liga à lista de
semanas e aos cards semanais.

Cada movimento fica em `emprestimo_lancamentos`, com valor sempre positivo e
um tipo que define o sinal:

| Tipo no banco | Efeito no saldo |
|---|---|
| `divida` | aumenta o saldo devedor |
| `abatimento` | reduz o saldo devedor |

```
saldo do empréstimo = Σ(dívidas) − Σ(abatimentos)
```

**Diferente do Cartão de Crédito, o Empréstimo não pede o valor do
movimento — pede o valor atual da dívida.** O único botão do bloco
("Atualizar valor atual") sugere o saldo de hoje e pergunta qual é o valor
atual do empréstimo. O app calcula a diferença entre o valor informado e o
saldo anterior (`dadosAtualizacaoValorDivida`) e grava, sozinho, um único
movimento equivalente:

- valor informado **maior** que o saldo → grava `divida` com a diferença;
- valor informado **menor** que o saldo → grava `abatimento` com a diferença;
- valor informado **igual** ao saldo → nenhum movimento é gravado.

Enquanto o valor digitado estiver **acima** do saldo devido, a janela mostra o
campo **Data de finalização**, que passa a ser obrigatório. A comparação é
feita na hora, enquanto se digita. Valor maior significa que a dívida anterior
foi quitada e outra foi contraída, ou que o empréstimo saiu do zero. A data é
gravada na dívida criada e aparece no histórico como "vence dd/mm/aaaa".
Valores iguais ou menores não pedem data.

Isso evita o usuário ter que calcular manualmente quanto pagou ou quanto
contraiu a mais; ele só informa o total atual da dívida. Cada movimento
gravado mostra data, tipo e valor no histórico, e pode ser excluído
individualmente após confirmação — excluir não refaz o cálculo, só remove
aquele lançamento do histórico. A conversão do modelo antigo preservou cada
dívida e aporte como movimentos equivalentes.

---

### Cartão de Crédito

O Cartão de Crédito aparece **sempre** em um bloco próprio nas Ocorrências,
logo após o Empréstimo. Ele é independente de Contas a Pagar: não atrasa, não
entra no resumo mensal e nasce com saldo `R$ 0,00`. O dia de vencimento mensal
só o liga à lista de semanas e aos cards semanais.

Cada movimento é registrado em `cartao_credito_lancamentos`, com valor sempre
positivo e um tipo que define o sinal (`divida` aumenta, `abatimento` reduz):

```
saldo do cartão = Σ(dívidas) − Σ(abatimentos)
```

**Igual ao Empréstimo, o Cartão pede o valor total atual da fatura**, não o
valor do movimento. O único botão do bloco é "Atualizar valor atual", e a
diferença para o saldo vira um único movimento pela mesma regra do Empréstimo
(`dadosAtualizacaoValorDivida`). Diferente do Empréstimo, ele **nunca pede
data**: o vencimento é o dia fixo do mês. Os antigos botões `+`/`−` foram
removidos para padronizar; compras individuais não ficam mais registradas uma
a uma, só os ajustes do total. Cada movimento mostra data, tipo, valor e pode
ser excluído individualmente após confirmação. Excluir recalcula o saldo; o
histórico permanece auditado linha a linha como os demais lançamentos.

---

### Roberta

O bloco **Roberta** registra quanto se deve à Roberta por ter usado o
dinheiro dela. Ele aparece **sempre** nas Ocorrências, logo após o Cartão de
Crédito, e segue as mesmas regras de bloco do Cartão: sem vencimento, sem
atraso, fora dos cards semanais e do resumo mensal, saldo inicial `R$ 0,00`.

Cada movimento fica em `roberta_lancamentos`, com valor sempre positivo:

| Origem | Tipo no banco | Efeito no saldo |
|---|---|---|
| Pagar uma conta com **Dinheiro Roberta** | `divida` vinculada | aumenta o saldo devedor |
| `+` Adicionar dívida | `divida` manual | aumenta o saldo devedor |
| `−` Abater dívida (quando você devolve) | `abatimento` | reduz o saldo devedor |

```
saldo da Roberta = Σ(dívidas) − Σ(abatimentos)
```

A dívida criada por um pagamento fica vinculada a `(conta_id, data)` da
ocorrência, como as saídas automáticas do Caixa, e mostra a descrição da conta
paga. Ela existe no máximo uma vez por ocorrência e guarda o acumulado pago
com dinheiro da Roberta: dois pagamentos parciais de R$ 40 com esse dinheiro
viram uma única dívida de R$ 80. Desmarcar a ocorrência apaga a dívida por
cascata, e excluir essa dívida pela lixeira desmarca a ocorrência.

O botão `−` sugere o saldo atual e limita o valor ao necessário para zerar.

---

## Módulo: Fiado

Registro de vendas fiadas e pagamentos por pessoa. Existe para documentar
quem deve, o que foi vendido e os abatimentos realizados ao longo do tempo.

### Sem ligação com nada

Fiado não se comunica com nenhum outro módulo. Registrar um pagamento não
movimenta Caixa Casa nem Salário; ele apenas reduz o saldo devido pela pessoa
dentro do próprio Fiado.

### Lançamentos por pessoa

Não existe tabela de cadastro de pessoas. Cada venda e pagamento guarda
diretamente `pessoa_nome`, além de tipo, valor, descrição e data, em uma única
tabela `fiado_lancamentos`. O saldo é:

```
saldo da pessoa = soma das vendas − soma dos pagamentos
```

Saldo positivo é dívida da pessoa. Saldo **negativo é crédito** dela com a loja
e aparece como valor positivo, sem sinal nem rótulo, em verde ao lado do nome
(dívida fica em vermelho) e na lista do pagamento; a
próxima venda abate esse crédito automaticamente (crédito de 30, venda de 45,
passa a dever 15).

#### Escolha ou criação pelo nome

Ao lançar uma venda, o campo "Pessoa" é um texto livre com autocomplete
(sugestões distintas de todos os nomes já usados). No momento de salvar:

- Se já existir nome equivalente sem diferenciar maiúsculas/minúsculas, a
  venda reaproveita a grafia já registrada.
- Caso contrário, a própria venda cria o novo nome no histórico.

O banco exige nome não vazio e sem espaços nas pontas. Não há telefone,
endereço ou outro cadastro separado: o modelo é deliberadamente só o nome.
O tipo `venda` aumenta a dívida e `pagamento` a reduz; ambos mantêm valor
positivo para o sinal vir somente do tipo.

### Pagamentos

O formulário possui as abas **Venda** e **Pagamento**. Ao registrar um
pagamento, é obrigatório escolher um dos nomes já existentes, devendo ou não:
quem está zerado ou com crédito também aparece, para permitir pagamento
adiantado.
O pagamento não cria nome novo: uma pessoa passa a existir no Fiado pela sua
primeira venda.

Pagamentos podem ser parciais e ficam misturados às vendas no histórico da
pessoa, ordenados por data. O valor do pagamento deve ser positivo e **pode
passar da dívida**: o excedente vira crédito da pessoa. Até a migration 018
havia um trigger no banco impedindo saldo negativo; ele foi removido.

A descrição do pagamento é opcional e usa `Pagamento` como padrão.

### Total geral

O card do topo (`Total fiado`) é o saldo **líquido** de todas as pessoas: soma
das vendas menos soma dos pagamentos, sem filtro de data. O crédito de uma
pessoa reduz o total, que pode ficar negativo se os créditos superarem as
dívidas.

### Exclusão

- Remover uma **venda** apaga só aquela linha e reduz o saldo da pessoa,
  podendo deixá-la com crédito.
- Remover um **pagamento** apaga só aquela linha e devolve o valor ao saldo
  devido da pessoa.
- Não há exclusão de pessoa separada: sem tabela de cadastro, o nome deixa de
  aparecer automaticamente quando seus últimos lançamentos forem removidos.

---

## Funcionalidades removidas

Registradas para ninguém estranhar o que sobrou no banco.

### Contas pessoais (2026-10-30, migration 016)

A marcação **Conta pessoal** (bloco próprio, pagamento automático no Salário e
botão para somar valor) deixou de existir. As contas pessoais foram apagadas e a
coluna `contas_pagar.pessoal` foi removida. Os lançamentos que os pagamentos
delas tinham criado no Salário e no Caixa Casa foram mantidos como lançamentos
manuais, sem vínculo, para não alterar saldos. Toda conta agora é comum. As
colunas `conta_pagar_id`/`data_ocorrencia` de `salario_lancamentos` continuam no
banco, sem uso.

### Calculadora de preço (2026-11-15)

Sugeria preços por faixa de lucro a partir do histórico de vendas, contas fixas
e impostos. Saiu junto com o campo "Tipo de gasto" do cadastro de contas.
Ficaram no banco, sem uso, a coluna `contas_pagar.categoria` (padrão `fixa`) e a
tabela `calculadora_config` (migration 019).

---

## Regras transversais

### Auditoria do banco

A tabela `auditoria_db` registra uma linha para cada `INSERT`, `UPDATE` ou
`DELETE` ocorrido nas tabelas do aplicativo depois da aplicação da migration
008. Cada linha contém data e hora, transação, usuário autenticado quando
disponível, tabela, operação, identificação do registro, estado anterior,
estado novo e um JSON `diferencas` somente com os campos alterados.

A auditoria não registra leituras (`SELECT`), pois elas não modificam dados,
nem alterações de estrutura (`DDL`), que continuam documentadas pelos arquivos
e pelo histórico de migrations. A própria tabela de auditoria não gera logs de
si mesma, evitando recursão.

Usuários autenticados podem consultar a auditoria, mas não inserir, editar ou
apagar suas linhas diretamente. A gravação é feita apenas pelos triggers
internos das tabelas financeiras.

---

### Edição e exclusão de lançamentos

Lançamentos de Caixa Casa, Salário e movimentos do Cartão de Crédito e da
Roberta não podem ser editados, mas podem ser excluídos pela lixeira de cada linha, após
confirmação. Uma venda excluída
retira sua comissão do saldo do Salário; excluir um pagamento devolve o valor
ao saldo; e excluir uma entrada ou saída recalcula o Caixa Casa.

Se a linha foi criada automaticamente ao pagar uma conta, a lixeira desmarca
a ocorrência em Contas a Pagar. A cascata remove todos os efeitos automáticos
daquela baixa, inclusive Caixa Casa e a dívida da Roberta quando
existirem. Isso
evita deixar uma conta marcada como paga sem os lançamentos que a representam.

A única edição disponível em todo o sistema é o valor de uma ocorrência de
Contas a Pagar, e ainda assim porque ali o "lançamento" é uma previsão, não
um fato consumado.

### Exclusão de conta é em cascata

Remover uma conta em "Contas cadastradas" apaga também, por `on delete
cascade`, todas as suas parcelas, exdates, pagamentos e ajustes. Não há
lixeira nem desfazer. Por isso a ação pede confirmação.

### Valores na lista "Contas cadastradas"

O valor exibido ali tem significado **diferente** conforme o tipo:

- Mensal → o valor de **uma** ocorrência (o valor mensal)
- Parcelado → a **soma de todas** as parcelas (o total da conta)

Ajustes pontuais de contas mensais não aparecem nesse número — ele mostra
sempre o valor padrão da conta.

---

## Testes de regressão

A suíte fica no próprio `app.js`, sem framework ou dependência adicional. Para
executá-la, abra a aplicação acrescentando `?testes=1` ao endereço. Exemplo:

```
https://endereco-da-aplicacao/?testes=1
```

Esse modo não autentica, não consulta o Supabase e não altera dados. Ele exibe
uma lista com cada caso aprovado ou reprovado.

Os casos cobrem as regras determinísticas (dinheiro, saldos, comissão e teto,
pagamentos parciais, recorrência, semanas, Fiado, Empréstimo/Cartão/Roberta e
contratos essenciais do HTML). A lista fica nos próprios casos em `app.js`;
não é repetida aqui para não ficar desatualizada.

Continuam manuais as verificações que dependem do banco ou de interação real:
RLS, cascatas, constraints e triggers SQL, sessão de 9 horas, cadastro público
desativado, operações efetivas no Supabase, confirmações destrutivas e aparência
responsiva.
As migrations preservam essas garantias no banco, mas testá-las de verdade
exigiria um Supabase separado para testes — complexidade que este projeto ainda
não justifica.

---

## Comportamentos conhecidos e limitações

Coisas que funcionam assim de propósito, ou que são limitações aceitas.
Registradas aqui para não serem "descobertas" como bug no futuro.

### Limite de 50 lançamentos afeta o saldo do Caixa Casa

Caixa Casa carrega apenas os **50 lançamentos mais recentes**, e o saldo é
calculado sobre esses 50. Quando passar de 50 lançamentos, **o saldo exibido
deixa de ser o saldo real** — passa a ser o saldo dos últimos 50. No Salário,
a lista continua limitada a 50 itens, mas o saldo é calculado com o histórico
inteiro.

Se o Caixa Casa também precisar exibir o saldo histórico real, será necessário
separar a lista limitada do cálculo completo, como já ocorre no Salário.

### Comissão e teto são fixos no código

Alterar exige mudar `PERCENTUAL_COMISSAO` ou `TETO_COMISSAO_MES` e republicar.
A mudança não é retroativa: o histórico pode ter percentuais mistos sem
indicação de qual foi usado.

### Contas mensais não têm fim

Por decisão de escopo. Uma conta que precisa acabar deve ser cadastrada como
Parcelada. Se uma conta mensal precisar ser encerrada, a única saída é
removê-la — o que apaga também todo o histórico de pagamentos dela.

### Recorrência só mensal

Não existe recorrência semanal, quinzenal ou anual. Uma conta semanal teria
que ser cadastrada como parcelada com muitas datas (limite de 24).

### Ajuste de valor sem histórico

O ajuste sobrescreve (upsert). Não fica registro do valor anterior nem de
quando foi alterado.

### Ajustes órfãos

Se uma ocorrência mensal com ajuste for pulada (exdate), o ajuste
permanece na tabela sem nunca ser usado. Inofensivo — se a exdate for
removida algum dia, o ajuste volta a valer.

### Conta mensal sempre gera 3 futuras, custe o que custar

A busca pelas 3 próximas ocorrências percorre mês a mês até encontrar 3
datas válidas. Se a conta tiver `data_inicio` muito no futuro, ou muitos
meses seguidos com exdate, o cálculo percorre todos esses meses antes de
achar as 3. Não trava (sempre há um mês futuro válido), mas é um laço sem
limite superior de iterações.

### Chave primária impede duplicatas por data

Como todas as tabelas auxiliares têm PK `(conta_id, data)`, uma conta não
pode ter duas ocorrências no mesmo dia. Isso é irrelevante para contas
mensais (uma por mês), mas **impede cadastrar duas parcelas na mesma data**
dentro da mesma conta.
