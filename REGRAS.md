# Regras de negócio — Gestão Ammi

Documento de referência das **regras, cálculos e decisões** do sistema.
Não trata de stack, setup ou como rodar — só do que o sistema faz e por quê.
O objetivo é que essas regras não se percam com o tempo, já que boa parte
delas não é óbvia lendo o código e nenhuma está registrada em outro lugar.

Última revisão: 2026-10-07 (correção de identificação do pagamento da ocorrência).

---

## Índice

- [Conceitos gerais](#conceitos-gerais)
- [Módulo: Caixa Casa](#módulo-caixa-casa)
- [Módulo: Salário](#módulo-salário)
- [Módulo: Contas a Pagar](#módulo-contas-a-pagar)
  - [Conta Mensal (recorrente)](#conta-mensal-recorrente)
  - [Conta Parcelada](#conta-parcelada)
  - [Contas pessoais](#contas-pessoais)
  - [Cartão de Crédito](#cartão-de-crédito)
  - [Seleção para soma](#seleção-para-soma)
  - [Pagamento de ocorrências](#pagamento-de-ocorrências)
  - [Pular ocorrência](#pular-ocorrência)
  - [Ajuste de valor](#ajuste-de-valor)
  - [Atrasadas](#atrasadas)
  - [Card do topo: esta semana e a próxima](#card-do-topo-esta-semana-e-a-próxima)
  - [Agrupamento por semana](#agrupamento-por-semana)
- [Módulo: Fiado](#módulo-fiado)
- [Regras transversais](#regras-transversais)
  - [Auditoria do banco](#auditoria-do-banco)
- [Testes de regressão](#testes-de-regressão)
- [Comportamentos conhecidos e limitações](#comportamentos-conhecidos-e-limitações)

---

## Conceitos gerais

### Integrações entre os módulos

Caixa Casa e Contas a Pagar se comunicam na exibição do primeiro aluguel
aberto, conforme a regra documentada em [Abatimento do Caixa Casa no
aluguel](#abatimento-do-caixa-casa-no-aluguel).

Uma venda lançada no módulo Salário cria apenas a comissão salarial. Ela não
movimenta o Empréstimo, que é controlado manualmente em seu próprio bloco.

Pagar uma conta em Contas a Pagar pode criar lançamentos automáticos: contas
pessoais geram pagamento no Salário; o Aluguel gera saída no Caixa Casa; e as
demais contas perguntam no momento da baixa se foi usado dinheiro do Caixa.

### Dinheiro

- Todo valor é `numeric(12,2)` no banco e sempre **positivo** (`check (valor > 0)`).
- O sinal (entrada/saída) vem do campo `tipo`, nunca do sinal do número.
- Arredondamento sempre a 2 casas, via `Math.round(n * 100) / 100`.
- Entrada do usuário aceita o formato brasileiro (`1.234,56`): o ponto é
  separador de milhar e a vírgula é decimal. A máscara aplica isso enquanto
  a pessoa digita, tratando os dígitos como centavos da direita para a
  esquerda (digitar `12345` resulta em `123,45`).
- Campos abertos em prompts, como Aporte e ajuste de valor, também aceitam
  ponto seguido de uma ou duas casas decimais (`77.62` resulta em `77,62`).
  Um ponto seguido de três casas continua sendo interpretado como milhar
  (`1.234` resulta em `1.234,00`).

### Datas

- Datas são sempre `YYYY-MM-DD` (string), nunca objeto `Date` serializado.
  Isso permite comparar datas com comparação de string (`data < hoje`), que
  é usada em várias regras.
- "Hoje" é sempre calculado no fuso **America/Sao_Paulo**, não no fuso do
  dispositivo. Um celular configurado em outro fuso continua vendo o mesmo
  "hoje" que o sistema considera.
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
"Duplicar no Salário" foi removida: despesas pessoais agora são identificadas
no cadastro de Contas a Pagar e integradas ao Salário quando são pagas.

### Saldo

```
saldo = Σ(entradas) − Σ(saídas)
```

Calculado **sobre os lançamentos carregados**, que são os 50 mais recentes
(ver [Comportamentos conhecidos](#comportamentos-conhecidos-e-limitações)).

Saldo negativo é exibido em vermelho. Não há bloqueio para saldo negativo —
o sistema registra o que aconteceu, não impede lançamentos.

O card mostra dois valores:

- **Após aluguel** — valor principal, calculado como
  `max(saldo − primeiro aluguel aberto, 0)`.
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
comissão = valor_da_venda × 0,25
```

O percentual é fixo em **25%** (`PERCENTUAL_COMISSAO`), definido no código.
Não há como alterar pela interface — mudar exige editar o código.

Quando você lança uma venda:

- O campo "Valor" é o **total vendido**, não a comissão.
- O sistema calcula a comissão e é **ela** que vai para `valor` no banco.
- O total vendido é preservado em `venda_base`, para rastreabilidade.

O botão "Salvar" mostra em tempo real a comissão que será gravada
(`Salvar — R$ 25,00`), para conferência antes de confirmar.

### Sem movimento no Empréstimo ao salvar uma venda

Salvar uma venda registra somente a comissão da gerente. O valor bruto da venda
não é usado para reduzir nenhum Empréstimo. Os movimentos do Empréstimo são
registrados manualmente em seu bloco próprio.

### Pagamento

Um pagamento é dinheiro entregue à gerente, que **abate** o saldo devido.
Descrição tem default `Saque` e é obrigatória (se esvaziada, volta a `Saque`).
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
25% ao Salário e avança para o próximo dia faltante, em ordem cronológica, até
chegar ao mais recente.

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

### Contas pessoais

Ao cadastrar uma conta Mensal ou Parcelada, a opção **Conta pessoal** grava
`contas_pagar.pessoal = true`. A marcação aparece em "Contas cadastradas" e
cada ocorrência dessa conta exibe a tag **Pessoal** junto ao nome.

Contas pessoais não ficam nos grupos semanais nem recebem atraso visual. Elas
aparecem em um bloco próprio, como Empréstimo, e mostram somente a **data de
cadastro** no fuso America/Sao_Paulo — não há vencimento visível. A data
interna da parcela ou recorrência continua existindo somente para preservar os
vínculos de pagamento e os cálculos já registrados.

Ao clicar no checkbox de uma ocorrência pessoal aberta, o sistema pergunta o
valor pago. O campo começa preenchido com todo o saldo restante, mas aceita um
valor menor. Cada novo pagamento se acumula no mesmo registro até atingir o
valor real da ocorrência. Em conta Mensal, um ajuste pontual já existente faz
parte desse valor. O abatimento do Caixa Casa no Aluguel é apenas visual e não
reduz o pagamento criado no Salário.

O total acumulado pago também é o valor do `pagamento` automático no Salário.
Enquanto houver saldo, a ocorrência permanece aberta, exibe a tag **Parcial**,
mostra quanto já foi pago e mantém o checkbox em estado intermediário. O valor
principal da linha e os totais pendentes mostram somente o saldo restante.

O pagamento do Salário fica vinculado a `(conta_id, data)` da ocorrência e
existe no máximo uma vez. Desmarcar o pagamento em Contas a Pagar apaga por
cascata somente esse lançamento automático. Excluir a conta também o apaga;
pagamentos manuais do Salário, sem esse vínculo, nunca são afetados.

Uma conta pessoal também pode ter sido paga com dinheiro do Caixa Casa. Nesse
caso, a mesma baixa cria o pagamento no Salário e a saída no Caixa, pois são
efeitos independentes.

Se não for possível criar algum lançamento automático, o sistema tenta
desfazer a marcação de pago; a cascata também desfaz outro lançamento
automático que já tenha sido criado para aquela ocorrência.

---

### Empréstimo

O Empréstimo é independente de Contas a Pagar, igual ao Cartão de Crédito.
Ele aparece sempre em um bloco próprio nas Ocorrências, antes do Cartão, sem
vencimento, atraso, data de cadastro, cards semanais ou resumo mensal.

Cada movimento fica em `emprestimo_lancamentos`, com valor sempre positivo e
um tipo que define o sinal:

| Ação | Tipo no banco | Efeito no saldo |
|---|---|---|
| `+` Adicionar dívida | `divida` | aumenta o saldo devedor |
| `−` Abater dívida | `abatimento` | reduz o saldo devedor |

```
saldo do empréstimo = Σ(dívidas) − Σ(abatimentos)
```

O botão `−` sugere o saldo atual e limita o valor ao necessário para zerar,
portanto o saldo não fica negativo pela interface. Cada movimento mostra data,
tipo e valor; pode ser excluído individualmente após confirmação. A conversão
do modelo antigo preservou cada dívida e aporte como movimentos equivalentes.

---

### Cartão de Crédito

O Cartão de Crédito aparece **sempre** em um bloco próprio nas Ocorrências,
logo após o Empréstimo. Ele é independente de Contas a Pagar: não possui
vencimento, não atrasa, não entra nos cards semanais ou no resumo mensal e
nasce com saldo `R$ 0,00`.

Cada movimento é registrado em `cartao_credito_lancamentos`, com valor sempre
positivo e um tipo que define o sinal:

| Ação | Tipo no banco | Efeito no saldo |
|---|---|---|
| `+` Adicionar dívida | `divida` | aumenta o saldo devedor |
| `−` Abater dívida | `abatimento` | reduz o saldo devedor |

```
saldo do cartão = Σ(dívidas) − Σ(abatimentos)
```

O botão `−` já traz o saldo atual como sugestão e limita o valor ao necessário
para zerar; portanto o saldo nunca fica negativo pela interface. Cada
movimento mostra data, tipo, valor e pode ser excluído individualmente após
confirmação. Excluir recalcula o saldo; o histórico permanece auditado linha a
linha como os demais lançamentos.

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

Um `dia_vencimento` de 31 não existe em todos os meses. A regra é
**ancorar no último dia do mês**:

```
dia_efetivo = min(dia_vencimento, último_dia_do_mês)
```

Dia 31 vira 30 em abril e 28 (ou 29) em fevereiro. O `dia_vencimento` da
conta permanece 31 — a redução acontece só no cálculo da ocorrência, então
março seguinte volta a cair no dia 31.

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

Na divisão, cada parcela recebe o valor truncado para baixo em centavos, e
**a diferença acumulada vai toda para a última parcela**. Isso garante que
a soma das parcelas seja exatamente igual ao total informado, sem perder
nem criar centavos.

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
ocorrência ao consultar o pagamento na lista. A linha guarda `valor_pago`, com
o acumulado quitado, e `valor_caixa`, com a parte desse acumulado que saiu do
Caixa Casa.

Marcar como paga **não altera** a conta nem a parcela. Nas contas pessoais,
o valor informado pode ser menor que o saldo e novos pagamentos acumulam até
quitá-lo. Nas demais contas, o checkbox continua registrando o valor integral.
Desmarcar uma ocorrência quitada apaga o registro e ela volta a contar como
totalmente pendente.

Em contas marcadas como pessoais, esse mesmo checkbox também segue a regra de
[Contas pessoais](#contas-pessoais), criando ou removendo o pagamento vinculado
no Salário.

Se a descrição da conta for exatamente **Aluguel** (ignorando maiúsculas,
minúsculas e espaços nas pontas), marcar como paga sempre cria uma saída no
Caixa Casa com o valor real, data e descrição da ocorrência. Para qualquer
outra conta, o sistema pergunta se ela foi paga com dinheiro do Caixa Casa;
respondendo sim, cria a mesma saída vinculada. Em pagamentos parciais, a saída
acumula apenas as partes que efetivamente usaram o Caixa. Respondendo não,
apenas registra a baixa e as demais integrações aplicáveis, como a do Salário
para conta pessoal.

Desmarcar a ocorrência remove por cascata os lançamentos automáticos vinculados
no Salário e no Caixa Casa. Lançamentos manuais desses módulos não possuem o
vínculo e não são afetados.

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
semana. Se a mesma semana estiver em um dos dois números do card do topo, o
card também usa o valor líquido. Quando o primeiro aluguel aberto pertence ao
mês corrente, o resumo mensal também usa o valor líquido.

O saldo do Caixa Casa usado no abatimento segue a regra atual do módulo: é
calculado sobre os 50 lançamentos mais recentes. Nenhum lançamento é criado
ou alterado automaticamente por esse abatimento.

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

Pendências **atrasadas** de contas comuns são somadas ao primeiro número,
junto com a semana encontrada. Havendo alguma, o rótulo passa a começar por
"Atrasadas +". Contas pessoais, Empréstimo e Cartão de Crédito continuam fora
dos dois cards.

#### Os dois números avançam quando não há pendência

Se a semana que contém a data de hoje **não tiver nenhuma pendência** (tudo
pago, ou nenhuma ocorrência cai nela), o primeiro número **avança** para a
próxima semana que tiver algo pendente. O segundo número é sempre a semana
seguinte à do primeiro, buscada da mesma forma — então se o primeiro virou
"Em 2 semanas", o segundo busca a partir da semana 3 e pode virar "Em 3
semanas", "Em 4 semanas", etc.

A busca avança semana a semana até achar uma pendência entre as ocorrências
comuns carregadas. **Empréstimo, Cartão de Crédito e contas pessoais nunca
entram nesses dois cards semanais**, pois já ficam em blocos separados. Se não existir nenhuma
pendência comum naquela semana nem depois dela, o card mostra `R$ 0,00`; isso
também impede uma busca infinita quando existem somente contas parceladas
antigas, pessoais ou Empréstimo.

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

Semana de **calendário real, começando no domingo** (não blocos fixos de 7
dias a partir do dia 1).

Consequência: a Semana 1 pode ter menos de 7 dias. Se o mês começa numa
terça, a Semana 1 tem 5 dias (terça a sábado), porque o domingo daquela
semana ficou no mês anterior.

Ao procurar a próxima semana com pendências, o avanço é até o **próximo
domingo**. Assim, em uma sexta-feira 25/09, a próxima semana é a Semana 5 de
setembro (27 a 30/09), e não uma semana calculada a partir de 02/10.

#### Agrupamento é por mês da data

Uma semana que atravessa a virada do mês é **cortada**: uma ocorrência em
30/09 fica na última semana de *setembro*, mesmo que essa semana continue
até 03/10. Cada mês fecha suas próprias semanas.

Isso evita que um bloco misture datas de dois meses diferentes. Como
consequência, a última semana de um mês pode ter poucos dias (às vezes só
1) — e ainda assim **sempre aparece como bloco próprio**, sem fundir com a
semana anterior. A antiga regra de fusão (que juntava a última semana com
a penúltima quando tinha 3 dias ou menos) foi removida por decisão do
usuário: prefere ver a semana curta separada a arriscar perder alguma
ocorrência de vista dentro de um bloco maior.

#### Destaque da semana atual

O cabeçalho da semana que contém a data de hoje ganha uma cor de destaque e
um pontinho ao lado — discreto, mas suficiente para localizar rapidamente
"onde estou" na lista.

#### Total por semana

Cada bloco mostra, no cabeçalho, a soma dos valores de todas as suas
ocorrências (pagas e não pagas), alinhada à direita. Não distingue pago de
não pago — é o total do que está programado para aquela semana.

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
tabela `fiado_lancamentos`. O saldo devido é:

```
saldo da pessoa = soma das vendas − soma dos pagamentos
```

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
pagamento, é obrigatório escolher um nome distinto que possua saldo aberto.
O pagamento não cria nome novo: uma pessoa passa a existir no Fiado pela sua
primeira venda.

Pagamentos podem ser parciais e ficam misturados às vendas no histórico da
pessoa, ordenados por data. O valor do pagamento deve ser positivo e não pode
ultrapassar o saldo atual da pessoa; portanto, o Fiado não registra crédito
adiantado nem deixa o saldo negativo. Essa proteção existe também no banco,
inclusive contra inserções diretas por SQL.

A descrição do pagamento é opcional e usa `Pagamento` como padrão.

### Total geral

O card do topo (`Total fiado`) soma o saldo devido de **todas** as pessoas:
soma das vendas menos soma dos pagamentos, sem filtro de data.

### Exclusão

- Remover uma **venda** apaga só aquela linha, desde que as vendas restantes
  ainda cubram todos os pagamentos registrados. Caso contrário, a remoção é
  bloqueada até que o pagamento necessário seja removido.
- Remover um **pagamento** apaga só aquela linha e devolve o valor ao saldo
  devido da pessoa.
- Não há exclusão de pessoa separada: sem tabela de cadastro, o nome deixa de
  aparecer automaticamente quando seus últimos lançamentos forem removidos.

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

Lançamentos de Caixa Casa, Salário e movimentos do Cartão de Crédito não podem
ser editados, mas podem ser excluídos pela lixeira de cada linha, após
confirmação. Uma venda excluída
retira sua comissão do saldo do Salário; excluir um pagamento devolve o valor
ao saldo; e excluir uma entrada ou saída recalcula o Caixa Casa.

Se a linha foi criada automaticamente ao pagar uma conta, a lixeira desmarca
a ocorrência em Contas a Pagar. A cascata remove todos os efeitos automáticos
daquela baixa, inclusive Salário e Caixa Casa quando os dois existirem. Isso
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

As verificações automatizadas cobrem as regras determinísticas mais sensíveis:

- leitura e arredondamento de dinheiro;
- saldo do Caixa, abatimento do aluguel, limite em zero e saída vinculada de
  conta paga com seu dinheiro;
- comissão e saldo do Salário, inclusive o payload de uma venda esquecida;
- criação vinculada e reversão por cascata do pagamento de uma conta pessoal;
- limite, saldo restante e payload acumulado dos pagamentos parciais;
- exibição de contas Pessoais pela data de cadastro, fora dos grupos semanais
  e sem atraso visual;
- identificação visual de contas pessoais e destino correto da exclusão de
  lançamentos manuais ou vinculados, incluindo o respiro visual após a
  descrição no formulário;
- saldo, limite de abatimento, payload e presença permanente de Empréstimo e Cartão de Crédito;
- exclusão de contas pessoais dos cards semanais;
- soma de contas comuns atrasadas no primeiro card semanal;
- saldo, limite de pagamento e proteção ao remover vendas do Fiado;
- nomes distintos do Fiado, reaproveitamento de grafia e criação direta pela venda;
- repetição, divisão, centavos, limite de 24 parcelas e reabertura do campo
  de quantidade após salvar uma conta parcelada;
- destino inicial no mobile para a aba Pagamento do Salário;
- datas, meses sem dia 31 e ano bissexto;
- semanas iniciadas no domingo e corte na virada do mês;
- abertura inicial por pendência e preservação do estado das semanas e do
  Empréstimo ao atualizar a lista;
- recorrências, exdates e ocupação das três vagas futuras;
- escolha exata do primeiro `Aluguel` aberto;
- contratos essenciais do HTML, como os ícones de início e os dois saldos do
  Caixa Casa, o formulário do aviso de venda e a declaração do manifesto PWA.

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

### Comissão de 25% é fixa no código

Alterar exige mudar `PERCENTUAL_COMISSAO` e republicar. Lançamentos antigos
mantêm a comissão já calculada — a mudança não é retroativa, o que é o
comportamento correto, mas significa que o histórico pode ter percentuais
mistos sem nenhuma indicação de qual foi usado.

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

### Pular parcela é destrutivo

Já mencionado acima, mas vale repetir por ser assimétrico com o
comportamento de conta mensal: em conta parcelada não existe "exdate", a
parcela é apagada de verdade.

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
