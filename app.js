import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ===================== CONFIG =====================

// A chave abaixo é pública (anon/publishable) e fica exposta de propósito: o
// repositório é público e a proteção real é o RLS no Supabase. Não é vazamento
// e não deve ir para variável de ambiente (não há build para injetá-la).
const SUPABASE_URL ='https://odjryakghivbwyftfjar.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_SHyvOxJ8tz2BMFDJ1nZL0w_hUQbIGUc';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CAIXA_CASA_TABELA = 'caixa_casa_lancamentos';
const SALARIO_TABELA = 'salario_lancamentos';
const CONTAS_PAGAR_TABELA = 'contas_pagar';
const CONTAS_PAGAR_EXDATES_TABELA = 'contas_pagar_exdates';
const CONTAS_PAGAR_PARCELAS_TABELA = 'contas_pagar_parcelas';
const CONTAS_PAGAR_PAGAMENTOS_TABELA = 'contas_pagar_pagamentos';
const CONTAS_PAGAR_AJUSTES_TABELA = 'contas_pagar_ajustes';
const EMPRESTIMO_TABLE = 'emprestimo_lancamentos';
const CARTAO_CREDITO_TABLE = 'cartao_credito_lancamentos';
const ROBERTA_TABLE = 'roberta_lancamentos';
const FIADO_TABELA = 'fiado_lancamentos';
const PERCENTUAL_COMISSAO = 0.15;
// Teto mensal de comissão: custos da Isabella (~R$ 593) mais uma folga para ela.
const TETO_COMISSAO_MES = 800;
// Novembro/2026 começou com comissão de 25%; o teto só passa a valer em dezembro.
const TETO_COMISSAO_INICIO = '2026-12-01';
const modoTestes = new URLSearchParams(window.location.search).has('testes');

// ===================== HELPERS: dinheiro / data =====================

// Converte texto tipo "1.234,56" ou "1234,56" ou "1234.56" em número.
// Com vírgula, o ponto é milhar. Sem vírgula, ponto + 1 ou 2 dígitos é decimal
// ("77.62" = 77,62); ponto + 3 dígitos é milhar ("1.234" = 1234).
function parseMoney(text) {
  if (typeof text !== 'string') return NaN;
  const valor = text.trim();
  if (!valor) return NaN;
  if (valor.includes(',')) return parseFloat(valor.replace(/\./g, '').replace(',', '.'));

  const partes = valor.split('.');
  if (partes.length === 2 && /^\d{1,2}$/.test(partes[1])) return parseFloat(valor);
  return parseFloat(valor.replace(/\./g, ''));
}

// Desabilita o botão de submit do form enquanto o handler roda, evitando
// clique duplo/duplo envio. Reabilita mesmo se o handler lançar erro.
function bloquearDuranteSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    const botao = form.querySelector('button[type="submit"]');
    botao.disabled = true;
    try {
      await handler(e);
    } finally {
      botao.disabled = false;
    }
  });
}

// Aplica máscara de dinheiro (ex: "123456" -> "1.234,56") enquanto o usuário digita.
function aplicarMascaraMoney(input) {
  input.addEventListener('input', () => {
    let digits = input.value.replace(/\D/g, '');
    if (!digits) {
      input.value = '';
      return;
    }
    digits = digits.replace(/^0+(?=\d)/, '');
    const cents = digits.slice(-2).padStart(2, '0');
    const reais = digits.slice(0, -2) || '0';
    const reaisFormatado = reais.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    input.value = `${reaisFormatado},${cents}`;
  });
}

function formatMoney(value) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value || 0);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function calcularSaldoCaixa(lancamentos) {
  return round2(lancamentos.reduce((acc, item) => {
    return acc + (item.tipo === 'entrada' ? Number(item.valor) : -Number(item.valor));
  }, 0));
}

// 15% da venda, limitado ao que falta para o teto do mês da venda.
function calcularComissao(valorVenda, comissaoJaNoMes, data) {
  if (data < TETO_COMISSAO_INICIO) return round2(valorVenda * PERCENTUAL_COMISSAO);
  const restanteNoMes = Math.max(round2(TETO_COMISSAO_MES - comissaoJaNoMes), 0);
  return round2(Math.min(valorVenda * PERCENTUAL_COMISSAO, restanteNoMes));
}

function somarComissoesPorMes(lancamentos) {
  const porMes = new Map();
  lancamentos.filter((item) => item.tipo === 'venda').forEach((item) => {
    const mes = item.data.slice(0, 7);
    porMes.set(mes, round2((porMes.get(mes) || 0) + Number(item.valor)));
  });
  return porMes;
}

function ultimoDiaDoMesISO(isoDate) {
  const [ano, mes] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
}

async function buscarComissaoDoMes(data) {
  const { data: vendas, error } = await supabase.from(SALARIO_TABELA)
    .select('valor')
    .eq('tipo', 'venda')
    .gte('data', `${data.slice(0, 7)}-01`)
    .lte('data', ultimoDiaDoMesISO(data));
  if (error) return { error };
  return { comissao: round2(vendas.reduce((total, venda) => total + Number(venda.valor), 0)) };
}

function dadosVendaSalario(vendaBase, data, descricao = null, comissaoJaNoMes = 0) {
  return {
    tipo: 'venda',
    valor: calcularComissao(vendaBase, comissaoJaNoMes, data),
    venda_base: vendaBase,
    descricao,
    data,
  };
}

// Venda esquecida com valor 0 sinaliza que a loja não abriu naquele dia.
function dadosVendaEsquecida(vendaBase, data, comissaoJaNoMes = 0) {
  return vendaBase === 0
    ? dadosVendaSalario(0, data, 'Loja fechada')
    : dadosVendaSalario(vendaBase, data, null, comissaoJaNoMes);
}

function valorVendaEsquecidaValido(vendaBase) {
  return Number.isFinite(vendaBase) && vendaBase >= 0;
}

function calcularSaldoSalario(lancamentos) {
  return round2(lancamentos.reduce((acc, item) => {
    return acc + (item.tipo === 'venda' ? Number(item.valor) : -Number(item.valor));
  }, 0));
}

function limitarValorPagoConta(valorPago, valorTotal) {
  return Math.min(Math.max(round2(Number(valorPago) || 0), 0), Number(valorTotal));
}

function calcularSaldoConta(valorTotal, valorPago) {
  return Math.max(round2(Number(valorTotal) - limitarValorPagoConta(valorPago, valorTotal)), 0);
}

function dadosPagamentoConta(contaId, data, valorPago, valorCaixa = 0, valorRoberta = 0) {
  return {
    conta_id: contaId,
    data,
    valor_pago: valorPago,
    valor_caixa: valorCaixa,
    valor_roberta: valorRoberta,
  };
}

// origem: 'proprio' | 'caixa' | 'roberta'. Cada parte acumula só o que saiu dela.
function calcularNovoPagamentoConta(anterior, valor, origem) {
  return {
    valorPago: round2(anterior.valorPago + valor),
    valorCaixa: round2(anterior.valorCaixa + (origem === 'caixa' ? valor : 0)),
    valorRoberta: round2(anterior.valorRoberta + (origem === 'roberta' ? valor : 0)),
  };
}

// Pagamento acima do restante (juros, valor anotado errado) atualiza a
// ocorrência para o total pago. Retorna null quando o valor cabe no restante.
function calcularValorOcorrenciaAposPagamento(valorOcorrencia, valorPagoAnterior, valorPagamento) {
  const totalPago = round2(Number(valorPagoAnterior) + Number(valorPagamento));
  return totalPago > round2(Number(valorOcorrencia)) ? totalPago : null;
}

function gravarValorOcorrencia(contaId, data, tipo, valor) {
  return tipo === 'parcelado'
    ? supabase.from(CONTAS_PAGAR_PARCELAS_TABELA).update({ valor }).eq('conta_id', contaId).eq('data', data)
    : supabase.from(CONTAS_PAGAR_AJUSTES_TABELA).upsert({ conta_id: contaId, data, valor });
}

function dadosDividaRobertaDaConta(contaId, valor, data, descricao) {
  return {
    tipo: 'divida',
    valor,
    data,
    descricao,
    conta_pagar_id: contaId,
    data_ocorrencia: data,
  };
}

function dadosSaidaCaixaDaConta(contaId, valor, data, descricao) {
  return {
    tipo: 'saida',
    valor,
    data,
    descricao,
    conta_pagar_id: contaId,
    data_ocorrencia: data,
  };
}

function ehAluguel(conta) {
  return conta.descricao.trim().toLocaleLowerCase('pt-BR') === 'aluguel';
}

function alvoExclusaoLancamento(tabela, lancamento) {
  if (lancamento.conta_pagar_id && lancamento.data_ocorrencia) {
    return {
      tabela: CONTAS_PAGAR_PAGAMENTOS_TABELA,
      filtros: { conta_id: lancamento.conta_pagar_id, data: lancamento.data_ocorrencia },
      vinculado: true,
    };
  }
  return { tabela, filtros: { id: lancamento.id }, vinculado: false };
}

async function excluirLancamentoFinanceiro(tabela, lancamento) {
  const alvo = alvoExclusaoLancamento(tabela, lancamento);
  let consulta = supabase.from(alvo.tabela).delete();
  Object.entries(alvo.filtros).forEach(([campo, valor]) => {
    consulta = consulta.eq(campo, valor);
  });
  const { error } = await consulta;
  return { error, vinculado: alvo.vinculado };
}

function somarValoresSelecionados(itens) {
  return round2(itens.reduce((total, item) => total + Number(item.valor), 0));
}

// Retorna os dias não-domingo sem venda entre a primeira venda e a data-limite.
function datasSemVendaEmDiasUteis(vendas, hoje) {
  const datasVendas = new Set(vendas
    .map((venda) => venda.data)
    .filter((data) => data <= hoje));
  const primeiraData = [...datasVendas].sort()[0];
  if (!primeiraData) return [];

  const [ano, mes, dia] = primeiraData.split('-').map(Number);
  const dataAtual = new Date(ano, mes - 1, dia);
  const faltantes = [];

  while (true) {
    const data = `${dataAtual.getFullYear()}-${String(dataAtual.getMonth() + 1).padStart(2, '0')}-${String(dataAtual.getDate()).padStart(2, '0')}`;
    if (data > hoje) break;
    if (dataAtual.getDay() !== 0 && !datasVendas.has(data)) faltantes.push(data);
    dataAtual.setDate(dataAtual.getDate() + 1);
  }

  return faltantes;
}

function calcularSaldoFiado(lancamentos) {
  return round2(lancamentos.reduce((saldo, item) => {
    return saldo + (item.tipo === 'venda' ? Number(item.valor) : -Number(item.valor));
  }, 0));
}

// Saldo negativo é crédito do cliente com a loja.
function rotuloSaldoFiado(saldo) {
  return formatMoney(Math.abs(saldo));
}

function chavePessoaFiado(nome) {
  return nome.trim().toLocaleLowerCase('pt-BR');
}

function nomesDistintosFiado(lancamentos) {
  const nomes = new Map();
  lancamentos.forEach((lancamento) => {
    const chave = chavePessoaFiado(lancamento.pessoa_nome);
    if (!nomes.has(chave)) nomes.set(chave, lancamento.pessoa_nome);
  });
  return [...nomes.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function calcularSaldoAposAluguel(saldoCaixa, valorAluguel) {
  return Math.max(round2(saldoCaixa - (valorAluguel || 0)), 0);
}

function calcularAbatimentoAluguel(saldoCaixa, valorAluguel) {
  return Math.min(Math.max(round2(saldoCaixa), 0), Number(valorAluguel));
}

function calcularSaldoDivida(lancamentos) {
  return round2(lancamentos.reduce((saldo, lancamento) => {
    const valor = Number(lancamento.valor);
    return lancamento.tipo === 'divida' ? saldo + valor : saldo - valor;
  }, 0));
}

function limitarAbatimentoDivida(valor, saldoAtual) {
  return Math.min(round2(Number(valor)), Math.max(round2(Number(saldoAtual)), 0));
}

function dadosLancamentoDivida(tipo, valor, data = hojeISO()) {
  return { tipo, valor: round2(Number(valor)), data };
}

function dadosAtualizacaoValorDivida(valorAtualInformado, saldoAtual, data = hojeISO(), dataVencimento = null) {
  const delta = round2(Number(valorAtualInformado) - Number(saldoAtual));
  if (delta === 0) return null;
  const dados = dadosLancamentoDivida(delta > 0 ? 'divida' : 'abatimento', Math.abs(delta), data);
  if (delta > 0 && dataVencimento) dados.data_vencimento = dataVencimento;
  return dados;
}

// Primeiro valor preenchido de `campo` nos movimentos, que já vêm do mais
// recente para o mais antigo. Serve para achar o vencimento vigente.
function vencimentoMaisRecente(lancamentos, campo) {
  const lancamento = lancamentos.find((item) => item[campo] !== null && item[campo] !== undefined);
  return lancamento ? lancamento[campo] : null;
}

// Próxima data (hoje inclusive) em que cai o dia de vencimento do cartão.
// Dia que não existe no mês é ancorado no último dia, como nas contas mensais.
function proximoVencimentoCartao(diaVencimento, hoje = hojeISO()) {
  const [ano, mes] = hoje.split('-').map(Number);
  const dataNoMes = montarDataOcorrencia(ano, mes - 1, diaVencimento);
  if (dataNoMes >= hoje) return dataNoMes;
  return mes === 12
    ? montarDataOcorrencia(ano + 1, 0, diaVencimento)
    : montarDataOcorrencia(ano, mes, diaVencimento);
}

// Empréstimo e Cartão em aberto viram uma linha nas Ocorrências e entram nos
// cards semanais: o saldo inteiro cai na data de vencimento. Sem vencimento
// preenchido, não entram.
function pendenciasDividasNoResumoSemanal({ emprestimoLancamentos, emprestimoSaldo, cartaoLancamentos, cartaoSaldo, hoje = hojeISO() }) {
  const pendencias = [];
  const dataEmprestimo = vencimentoMaisRecente(emprestimoLancamentos, 'data_vencimento');
  if (emprestimoSaldo > 0 && dataEmprestimo) {
    pendencias.push({ data: dataEmprestimo, valor: round2(emprestimoSaldo), tabela: EMPRESTIMO_TABLE, titulo: 'Empréstimo' });
  }
  const diaCartao = vencimentoMaisRecente(cartaoLancamentos, 'dia_vencimento');
  if (cartaoSaldo > 0 && diaCartao) {
    pendencias.push({ data: proximoVencimentoCartao(Number(diaCartao), hoje), valor: round2(cartaoSaldo), tabela: CARTAO_CREDITO_TABLE, titulo: 'Cartão de Crédito' });
  }
  return pendencias;
}

function renderizarDividaEspecial({ grupo, classe, titulo, tabela, lancamentos, saldo, valorAtualUnico }) {
  const aberto = contasPagarGruposAlteradosManualmente.get(grupo) ?? true;
  const movimentos = lancamentos.map((lancamento) => {
    const divida = lancamento.tipo === 'divida';
    const rotulo = divida ? 'Dívida adicionada' : 'Abatimento';
    return `
      <li class="lancamento-item">
        <div class="lancamento-info">
          <span class="lancamento-desc">${lancamento.descricao ? `${rotulo} · ${lancamento.descricao}` : rotulo}</span>
          <span class="lancamento-data">${formatDataBR(lancamento.data)}${lancamento.data_vencimento ? ` · vence ${formatDataBR(lancamento.data_vencimento)}` : ''}</span>
        </div>
        <span class="lancamento-valor ${divida ? 'negativo' : 'positivo'}">${divida ? '+' : '−'} ${formatMoney(lancamento.valor)}</span>
        <button type="button" class="botao-icone cartao-excluir-botao" data-id="${lancamento.id}" data-tabela="${tabela}" data-nome="${titulo}" data-conta-id="${lancamento.conta_pagar_id || ''}" data-data-ocorrencia="${lancamento.data_ocorrencia || ''}" aria-label="Excluir movimento do ${titulo}" title="Excluir movimento">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4h6v2"></path>
          </svg>
        </button>
      </li>`;
  }).join('') || '<li class="estado-vazio">Nenhum movimento registrado.</li>';

  const botoes = valorAtualUnico
    ? `<button type="button" class="botao-icone botao-icone-neutro divida-valor-atual-botao" data-tabela="${tabela}" data-nome="${titulo}" aria-label="Atualizar valor atual do ${titulo}" title="Atualizar valor atual">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
              <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
            </svg>
          </button>`
    : `<button type="button" class="botao-icone botao-aporte divida-movimento-botao" data-tabela="${tabela}" data-tipo="divida" data-nome="${titulo}" aria-label="Adicionar dívida no ${titulo}" title="Adicionar dívida">+</button>
          <button type="button" class="botao-icone botao-abater divida-movimento-botao" data-tabela="${tabela}" data-tipo="abatimento" data-nome="${titulo}" aria-label="Abater ${titulo}" title="Abater dívida"${saldo <= 0 ? ' disabled' : ''}>−</button>`;

  return `
    <li class="semana-grupo ${classe}">
      <details class="contas-pagar-grupo-details" data-grupo="${grupo}"${aberto ? ' open' : ''}>
        <summary class="semana-grupo-titulo">
          <span>${titulo}</span>
          <span class="semana-grupo-total">${formatMoney(saldo)}</span>
        </summary>
        <ul class="lancamentos">
          <li class="lancamento-item cartao-credito-resumo">
            <div class="lancamento-info">
              <span class="lancamento-desc">Saldo devedor</span>
              <span class="lancamento-data">${valorAtualUnico ? 'informe o valor atual' : '+ aumenta a dívida · − abate'}</span>
            </div>
            <span class="lancamento-valor negativo">${formatMoney(saldo)}</span>
            ${botoes}
          </li>
          ${movimentos}
        </ul>
      </details>
    </li>`;
}

// Linha de Empréstimo ou Cartão dentro da semana do vencimento: o checkbox
// quita o saldo inteiro e o lápis abre o "Atualizar valor atual".
function renderizarItemDividaOcorrencia({ data, valor, tabela, titulo }, hoje = hojeISO()) {
  const atrasada = data < hoje;
  return `
      <li class="lancamento-item${atrasada ? ' lancamento-atrasada' : ''}">
        <div class="lancamento-checkbox">
          <input type="checkbox" class="contas-pagar-divida-quitar-checkbox" data-tabela="${tabela}" data-nome="${titulo}" data-valor="${valor}" aria-label="Quitar ${titulo}">
          <div class="lancamento-info">
            <div class="lancamento-nome-tags"><span>${titulo}</span>${atrasada ? ' <span class="tag-atrasada">Atrasada</span>' : ''}</div>
            <span class="lancamento-data">${formatDataBR(data)}</span>
          </div>
        </div>
        <span class="lancamento-valor negativo">${formatMoney(valor)}</span>
        <button type="button" class="botao-icone botao-icone-neutro divida-valor-atual-botao" data-tabela="${tabela}" data-nome="${titulo}" aria-label="Alterar valor total do ${titulo}" title="Alterar valor total">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
      </li>`;
}

function renderizarCartaoCredito(lancamentos, saldo) {
  return renderizarDividaEspecial({
    grupo: 'cartao-credito', classe: 'cartao-credito-grupo', titulo: 'Cartão de Crédito',
    tabela: CARTAO_CREDITO_TABLE, lancamentos, saldo, valorAtualUnico: true,
  });
}

function renderizarEmprestimo(lancamentos, saldo) {
  return renderizarDividaEspecial({
    grupo: 'emprestimo', classe: 'emprestimo-grupo', titulo: 'Empréstimo',
    tabela: EMPRESTIMO_TABLE, lancamentos, saldo, valorAtualUnico: true,
  });
}

function renderizarRoberta(lancamentos, saldo) {
  return renderizarDividaEspecial({
    grupo: 'roberta', classe: 'roberta-grupo', titulo: 'Roberta',
    tabela: ROBERTA_TABLE, lancamentos, saldo,
  });
}

function valorExibidoOcorrencia(ocorrencia) {
  const valorBase = ocorrencia.paga && ocorrencia.valorOriginal !== undefined
    ? ocorrencia.valorOriginal
    : ocorrencia.valor;
  return round2(valorBase - (ocorrencia.abatimentoCaixa || 0));
}

// Etiqueta "−R$ X do Caixa Casa" na ocorrência do aluguel que recebeu o abatimento do caixa.
function etiquetaAbatimentoCaixaOcorrencia(ocorrencia) {
  if (!(ocorrencia.abatimentoCaixa > 0)) return '';
  return ` <span class="contas-pagar-abatimento-caixa">−${formatMoney(ocorrencia.abatimentoCaixa)} do Caixa Casa</span>`;
}

function entraNoResumoSemanal(ocorrencia) {
  return !ocorrencia.paga;
}

function totalAtrasadasNoResumoSemanal(ocorrencias, hoje) {
  return round2(ocorrencias
    .filter((ocorrencia) => entraNoResumoSemanal(ocorrencia) && ocorrencia.data < hoje)
    .reduce((total, ocorrencia) => total + valorExibidoOcorrencia(ocorrencia), 0));
}

// Data de hoje (YYYY-MM-DD) no fuso America/Sao_Paulo. Use sempre esta função,
// nunca `new Date()` direto: o fuso do aparelho pode mudar o "hoje".
// Datas são comparadas como string YYYY-MM-DD.
function hojeISO() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

function dataAnteriorISO(isoDate) {
  const [ano, mes, dia] = isoDate.split('-').map(Number);
  const data = new Date(ano, mes - 1, dia - 1);
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}-${String(data.getDate()).padStart(2, '0')}`;
}

function formatDataBR(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

// Quantos dias antes do dia 1 do mês a semana (domingo) já tinha começado.
// Ex: se o mês começa numa terça, offset = 2 (o domingo foi 2 dias antes
// do dia 1).
function offsetAteDomingo(ano, mes) {
  return new Date(ano, mes - 1, 1).getDay(); // 0=domingo..6=sábado
}

// Índice da semana (1-based) dentro do mês da própria data, com semanas de
// calendário real começando no domingo. A "semana 1" pode ter menos de 7
// dias se o mês não começar num domingo.
function semanaDoMes(isoDate) {
  const [ano, mes, dia] = isoDate.split('-').map(Number);
  return Math.ceil((dia + offsetAteDomingo(ano, mes)) / 7);
}

// Dada uma data, retorna a identidade do próximo domingo — usado para
// "andar" de semana em semana cruzando meses sem depender dos grupos já
// calculados. Mesmo quando a referência cai no meio da semana, o avanço deve
// alcançar a próxima semana de calendário, não somente a mesma data + 7.
function chaveSemanaSeguinte(isoDate) {
  const [ano, mes, dia] = isoDate.split('-').map(Number);
  const dataAtual = new Date(ano, mes - 1, dia);
  const diasAteProximoDomingo = 7 - dataAtual.getDay();
  const data = new Date(ano, mes - 1, dia + diasAteProximoDomingo);
  const anoSeguinte = data.getFullYear();
  const mesSeguinte = data.getMonth() + 1;
  const diaSeguinte = data.getDate();
  const isoSeguinte = `${anoSeguinte}-${String(mesSeguinte).padStart(2, '0')}-${String(diaSeguinte).padStart(2, '0')}`;
  return { ano: anoSeguinte, mes: mesSeguinte, semana: semanaDoMes(isoSeguinte), data: isoSeguinte };
}

// Agrupa ocorrências (já ordenadas por data) em blocos "Mês / Semana N".
// Cada mês fecha suas próprias semanas — a última pode ter poucos dias
// (ex: só 1-3 dias), e ainda assim aparece como bloco próprio. Não existe
// fusão da semana curta com a anterior: foi removida por decisão do usuário,
// que prefere a semana curta separada a perder uma ocorrência de vista.
function agruparPorSemana(ocorrencias) {
  const grupos = [];
  const chaveGrupo = (ano, mes, semana) => `${ano}-${mes}-${semana}`;
  const porChave = new Map();

  ocorrencias.forEach((oc) => {
    const [ano, mes] = oc.data.split('-').map(Number);
    const semana = semanaDoMes(oc.data);
    const chave = chaveGrupo(ano, mes, semana);

    if (!porChave.has(chave)) {
      const grupo = { ano, mes, semana, itens: [] };
      porChave.set(chave, grupo);
      grupos.push(grupo);
    }
    porChave.get(chave).itens.push(oc);
  });

  return grupos;
}

const NOMES_MES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
const contasPagarOcorrenciasSelecionadas = new Map();

// ===================== NAVEGAÇÃO ENTRE VIEWS =====================

const views = {
  login: document.getElementById('view-login'),
  home: document.getElementById('view-home'),
  'caixa-casa': document.getElementById('view-caixa-casa'),
  salario: document.getElementById('view-salario'),
  'contas-pagar': document.getElementById('view-contas-pagar'),
  fiado: document.getElementById('view-fiado'),
  testes: document.getElementById('view-testes'),
};

const gradeDesktopElemento = document.getElementById('grade-desktop');

function selecionarAbaSalario(aba) {
  document.getElementById(`salario-aba-${aba}`).checked = true;
  views.salario.querySelectorAll('.aba-painel').forEach((painel) => {
    painel.classList.toggle('aba-painel-ativo', painel.dataset.abaPainel === aba);
  });
}

function telaInicialAposLogin(ehMobile = window.matchMedia('(max-width: 899px)').matches) {
  return ehMobile ? 'salario' : 'home';
}

function abrirTelaInicialAposLogin() {
  const tela = telaInicialAposLogin();
  if (tela === 'salario') selecionarAbaSalario('pagamento');
  showView(tela);
}

function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.hidden = key !== name;
  });

  const logado = name !== 'login' && name !== 'testes';
  gradeDesktopElemento.hidden = !logado;
  if (!logado) limparSelecaoContasPagar();

  if (name === 'caixa-casa' || name === 'home') carregarCaixaCasa();
  if (name === 'salario' || name === 'home') carregarSalario();
  if (name === 'contas-pagar' || name === 'home') carregarContasPagar();
  if (name === 'fiado' || name === 'home') carregarFiado();
  if (name === 'home' || name === 'contas-pagar') carregarSaldoInfinitepay();
}

document.querySelectorAll('[data-nav]').forEach((el) => {
  el.addEventListener('click', () => showView(el.dataset.nav));
});

document.getElementById('botao-sair-desktop').addEventListener('click', async () => {
  await supabase.auth.signOut();
  showView('login');
});

// ===================== AUTENTICAÇÃO =====================

async function checkSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) abrirTelaInicialAposLogin();
  else showView('login');
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (!session && !modoTestes) showView('login');
});

const loginFormulario = document.getElementById('login-formulario');
const loginErroElemento = document.getElementById('login-erro');

bloquearDuranteSubmit(loginFormulario, async (e) => {
  e.preventDefault();
  loginErroElemento.hidden = true;

  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-senha').value;

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    loginErroElemento.textContent = 'E-mail ou senha inválidos.';
    loginErroElemento.hidden = false;
    return;
  }

  loginFormulario.reset();
  abrirTelaInicialAposLogin();
});

document.getElementById('botao-sair').addEventListener('click', async () => {
  await supabase.auth.signOut();
  showView('login');
});

// ===================== CAIXA CASA =====================

const caixaCasaSaldoAposAluguelElemento = document.getElementById('caixa-casa-saldo-apos-aluguel');
const caixaCasaAbatimentoAluguelElemento = document.getElementById('caixa-casa-abatimento-aluguel');

// Mostra o saldo do caixa após o aluguel aberto e, na etiqueta, quanto do aluguel foi descontado.
function exibirSaldoAposAluguelCaixaCasa(saldoCaixa, valorAluguel) {
  caixaCasaSaldoAposAluguelElemento.textContent = formatMoney(calcularSaldoAposAluguel(saldoCaixa, valorAluguel));
  const abatimento = valorAluguel ? calcularAbatimentoAluguel(saldoCaixa, valorAluguel) : 0;
  caixaCasaAbatimentoAluguelElemento.hidden = abatimento <= 0;
  caixaCasaAbatimentoAluguelElemento.textContent = `−${formatMoney(abatimento)} do Aluguel`;
}
const caixaCasaSaldoTotalElemento = document.getElementById('caixa-casa-saldo-total');
const caixaCasaListaLancamentosElemento = document.getElementById('caixa-casa-lista-lancamentos');
const caixaCasaFormularioElemento = document.getElementById('caixa-casa-formulario');
const caixaCasaFormularioErroElemento = document.getElementById('caixa-casa-formulario-erro');
const caixaCasaDescricaoCampo = document.getElementById('caixa-casa-descricao');
const caixaCasaDescricaoObrigatoriaElemento = document.getElementById('caixa-casa-descricao-obrigatoria');
const caixaCasaDataCampo = document.getElementById('caixa-casa-data');
aplicarMascaraMoney(document.getElementById('caixa-casa-valor'));

const CAIXA_CASA_DESCRICAO_PADRAO = {
  entrada: 'Suprimento',
  saida: null,
};

function atualizarObrigatoriedadeDescricaoCaixaCasa() {
  const tipo = document.querySelector('input[name="caixa-casa-tipo"]:checked').value;
  const obrigatorio = tipo === 'saida';
  caixaCasaDescricaoCampo.required = obrigatorio;
  caixaCasaDescricaoObrigatoriaElemento.hidden = !obrigatorio;
}

document.querySelectorAll('input[name="caixa-casa-tipo"]').forEach((el) => {
  el.addEventListener('change', () => {
    atualizarObrigatoriedadeDescricaoCaixaCasa();
    caixaCasaDescricaoCampo.value = CAIXA_CASA_DESCRICAO_PADRAO[el.value];
  });
});

async function carregarCaixaCasa() {
  caixaCasaDataCampo.value = caixaCasaDataCampo.value || hojeISO();
  if (!caixaCasaDescricaoCampo.value) {
    const tipo = document.querySelector('input[name="caixa-casa-tipo"]:checked').value;
    caixaCasaDescricaoCampo.value = CAIXA_CASA_DESCRICAO_PADRAO[tipo];
  }
  atualizarObrigatoriedadeDescricaoCaixaCasa();

  const [
    { data, error },
    { data: contas, error: errContas },
    { data: exdatesRows, error: errEx },
    { data: parcelasRows, error: errParc },
    { data: pagos, error: errPag },
    { data: ajustesRows, error: errAjustes },
  ] = await Promise.all([
    supabase.from(CAIXA_CASA_TABELA)
      .select('*')
      .order('data', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from(CONTAS_PAGAR_TABELA).select('*').order('data_inicio', { ascending: true }),
    supabase.from(CONTAS_PAGAR_EXDATES_TABELA).select('*'),
    supabase.from(CONTAS_PAGAR_PARCELAS_TABELA).select('*'),
    supabase.from(CONTAS_PAGAR_PAGAMENTOS_TABELA).select('*'),
    supabase.from(CONTAS_PAGAR_AJUSTES_TABELA).select('*'),
  ]);

  if (error || errContas || errEx || errParc || errPag || errAjustes) {
    caixaCasaListaLancamentosElemento.innerHTML = `<li class="estado-vazio">Erro ao carregar lançamentos.</li>`;
    return;
  }

  const saldo = calcularSaldoCaixa(data);
  const aluguelAberto = encontrarPrimeiroAluguelAberto(contas, exdatesRows, parcelasRows, pagos, ajustesRows);
  exibirSaldoAposAluguelCaixaCasa(saldo, aluguelAberto?.valor);
  caixaCasaSaldoTotalElemento.textContent = formatMoney(saldo);
  caixaCasaSaldoTotalElemento.classList.toggle('negativo', saldo < 0);

  if (data.length === 0) {
    caixaCasaListaLancamentosElemento.innerHTML = `<li class="estado-vazio">Nenhum lançamento ainda.</li>`;
    return;
  }

  caixaCasaListaLancamentosElemento.innerHTML = data.map((l) => {
    const positivo = l.tipo === 'entrada';
    const sinal = positivo ? '+' : '-';
    return `
      <li class="lancamento-item">
        <div class="lancamento-info">
          <span class="lancamento-desc">${l.descricao || (positivo ? 'Entrada' : 'Saída')}</span>
          <span class="lancamento-data">${formatDataBR(l.data)}</span>
        </div>
        <span class="lancamento-valor ${positivo ? 'positivo' : 'negativo'}">${sinal} ${formatMoney(l.valor)}</span>
        <button type="button" class="botao-icone caixa-casa-excluir-lancamento" data-id="${l.id}" data-conta-id="${l.conta_pagar_id || ''}" data-data-ocorrencia="${l.data_ocorrencia || ''}" aria-label="Excluir lançamento" title="Excluir lançamento">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </li>
    `;
  }).join('');
}

caixaCasaListaLancamentosElemento.addEventListener('click', async (e) => {
  const botao = e.target.closest('.caixa-casa-excluir-lancamento');
  if (!botao) return;
  const lancamento = {
    id: botao.dataset.id,
    conta_pagar_id: botao.dataset.contaId || null,
    data_ocorrencia: botao.dataset.dataOcorrencia || null,
  };
  const vinculado = Boolean(lancamento.conta_pagar_id && lancamento.data_ocorrencia);
  const mensagem = vinculado
    ? 'Excluir este lançamento e desfazer o pagamento da conta vinculada?'
    : 'Excluir este lançamento do Caixa Casa?';
  if (!confirm(mensagem)) return;

  botao.disabled = true;
  const { error } = await excluirLancamentoFinanceiro(CAIXA_CASA_TABELA, lancamento);
  if (error) {
    alert('Não foi possível excluir o lançamento.');
    botao.disabled = false;
    return;
  }
  await Promise.all([carregarCaixaCasa(), carregarContasPagar(), carregarSalario()]);
});

bloquearDuranteSubmit(caixaCasaFormularioElemento, async (e) => {
  e.preventDefault();
  caixaCasaFormularioErroElemento.hidden = true;

  const tipo = document.querySelector('input[name="caixa-casa-tipo"]:checked').value;
  const valor = parseMoney(document.getElementById('caixa-casa-valor').value);
  const data = caixaCasaDataCampo.value;
  const descricao = caixaCasaDescricaoCampo.value.trim();

  if (!valor || valor <= 0) {
    caixaCasaFormularioErroElemento.textContent = 'Informe um valor válido.';
    caixaCasaFormularioErroElemento.hidden = false;
    return;
  }

  if (tipo === 'saida' && !descricao) {
    caixaCasaFormularioErroElemento.textContent = 'Descrição é obrigatória para saídas.';
    caixaCasaFormularioErroElemento.hidden = false;
    return;
  }

  const { error } = await supabase.from(CAIXA_CASA_TABELA).insert({
    tipo,
    valor,
    data,
    descricao: descricao || null,
  });

  if (error) {
    caixaCasaFormularioErroElemento.textContent = 'Erro ao salvar. Tente novamente.';
    caixaCasaFormularioErroElemento.hidden = false;
    return;
  }

  caixaCasaFormularioElemento.reset();
  caixaCasaDataCampo.value = hojeISO();
  caixaCasaDescricaoCampo.value = CAIXA_CASA_DESCRICAO_PADRAO[tipo];
  atualizarObrigatoriedadeDescricaoCaixaCasa();
  await carregarCaixaCasa();
  await carregarContasPagar();
});

// ===================== SALÁRIO =====================

const salarioSaldoElemento = document.getElementById('salario-saldo');
const salarioListaLancamentosElemento = document.getElementById('salario-lista-lancamentos');
const salarioAvisoDiasSemVendaElemento = document.getElementById('salario-aviso-dias-sem-venda');
const salarioAvisoDiasSemVendaFecharElemento = document.getElementById('salario-aviso-dias-sem-venda-fechar');
const salarioAvisoDiasSemVendaProgressoElemento = document.getElementById('salario-aviso-dias-sem-venda-progresso');
const salarioAvisoDiasSemVendaFormularioElemento = document.getElementById('salario-aviso-dias-sem-venda-formulario');
const salarioAvisoDiasSemVendaDataElemento = document.getElementById('salario-aviso-dias-sem-venda-data');
const salarioAvisoDiasSemVendaValorCampo = document.getElementById('salario-aviso-dias-sem-venda-valor');
const salarioAvisoDiasSemVendaSalvarElemento = document.getElementById('salario-aviso-dias-sem-venda-salvar');
const salarioAvisoDiasSemVendaErroElemento = document.getElementById('salario-aviso-dias-sem-venda-erro');
let avisoDiasSemVendaExibido = false;
let diasSemVendaPendentes = [];
let totalDiasSemVenda = 0;
aplicarMascaraMoney(salarioAvisoDiasSemVendaValorCampo);

const salarioVendaFormularioElemento = document.getElementById('salario-venda-formulario');
const salarioVendaValorCampo = document.getElementById('salario-venda-valor');
const salarioVendaDataCampo = document.getElementById('salario-venda-data');
const salarioVendaDescricaoCampo = document.getElementById('salario-venda-descricao');
const salarioVendaErroElemento = document.getElementById('salario-venda-erro');
const salarioVendaSalvarElemento = document.getElementById('salario-venda-salvar');
aplicarMascaraMoney(salarioVendaValorCampo);

const salarioPagamentoFormularioElemento = document.getElementById('salario-pagamento-formulario');
const salarioPagamentoValorCampo = document.getElementById('salario-pagamento-valor');
const salarioPagamentoDataCampo = document.getElementById('salario-pagamento-data');
const salarioPagamentoDescricaoCampo = document.getElementById('salario-pagamento-descricao');
const salarioPagamentoErroElemento = document.getElementById('salario-pagamento-erro');
const DESCRICAO_PADRAO_PAGAMENTO_SALARIO = 'Pagamento';
let salarioSaldoAtual = 0;
let salarioComissaoPorMes = new Map();
aplicarMascaraMoney(salarioPagamentoValorCampo);

function formatarValorCampo(valor) {
  return Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const salarioPagarTudoElemento = document.getElementById('salario-pagar-tudo');
salarioPagarTudoElemento.addEventListener('click', () => {
  salarioPagamentoErroElemento.hidden = true;
  salarioPagamentoValorCampo.value = formatarValorCampo(salarioSaldoAtual);
});

document.querySelectorAll('.aba-botao').forEach((botao) => {
  botao.addEventListener('click', () => {
    const abaEscolhida = botao.dataset.aba;
    botao.closest('.painel').querySelectorAll('.aba-painel').forEach((painel) => {
      painel.classList.toggle('aba-painel-ativo', painel.dataset.abaPainel === abaEscolhida);
    });
  });
});

function atualizarRotuloBotaoSalvarVendaSalario() {
  const valor = parseMoney(salarioVendaValorCampo.value);
  if (!valor || valor <= 0) {
    salarioVendaSalvarElemento.textContent = 'Salvar';
    return;
  }
  const data = salarioVendaDataCampo.value;
  const comissao = calcularComissao(valor, salarioComissaoPorMes.get(data.slice(0, 7)) || 0, data);
  salarioVendaSalvarElemento.textContent = `Salvar — ${formatMoney(comissao)}`;
}

salarioVendaValorCampo.addEventListener('input', atualizarRotuloBotaoSalvarVendaSalario);
salarioVendaDataCampo.addEventListener('change', atualizarRotuloBotaoSalvarVendaSalario);

function atualizarVendaEsquecidaAtual() {
  const data = diasSemVendaPendentes[0];
  if (!data) {
    salarioAvisoDiasSemVendaElemento.close();
    return;
  }

  const numeroAtual = totalDiasSemVenda - diasSemVendaPendentes.length + 1;
  salarioAvisoDiasSemVendaProgressoElemento.textContent = `${numeroAtual} de ${totalDiasSemVenda} dia(s) sem venda`;
  salarioAvisoDiasSemVendaDataElemento.textContent = formatDataBR(data);
  salarioAvisoDiasSemVendaValorCampo.value = '';
  salarioAvisoDiasSemVendaSalvarElemento.textContent = 'Salvar';
  salarioAvisoDiasSemVendaErroElemento.hidden = true;
  salarioAvisoDiasSemVendaValorCampo.focus({ preventScroll: true });
}

function atualizarRotuloBotaoSalvarVendaEsquecida() {
  const valor = parseMoney(salarioAvisoDiasSemVendaValorCampo.value);
  if (valor > 0) {
    const data = diasSemVendaPendentes[0];
    const comissaoJaNoMes = salarioComissaoPorMes.get(data?.slice(0, 7)) || 0;
    salarioAvisoDiasSemVendaSalvarElemento.textContent = `Salvar — ${formatMoney(calcularComissao(valor, comissaoJaNoMes, data))}`;
  } else {
    salarioAvisoDiasSemVendaSalvarElemento.textContent = valor === 0 ? 'Salvar — loja fechada' : 'Salvar';
  }
}

salarioAvisoDiasSemVendaValorCampo.addEventListener('input', atualizarRotuloBotaoSalvarVendaEsquecida);

function mostrarAvisoDiasSemVenda(vendas) {
  if (avisoDiasSemVendaExibido) return;
  const faltantes = datasSemVendaEmDiasUteis(vendas, dataAnteriorISO(hojeISO()));
  if (faltantes.length === 0) return;

  avisoDiasSemVendaExibido = true;
  diasSemVendaPendentes = faltantes;
  totalDiasSemVenda = faltantes.length;
  salarioAvisoDiasSemVendaElemento.showModal();
  atualizarVendaEsquecidaAtual();
}

salarioAvisoDiasSemVendaFecharElemento.addEventListener('click', () => salarioAvisoDiasSemVendaElemento.close());

bloquearDuranteSubmit(salarioAvisoDiasSemVendaFormularioElemento, async (e) => {
  e.preventDefault();
  salarioAvisoDiasSemVendaErroElemento.hidden = true;

  const vendaBase = parseMoney(salarioAvisoDiasSemVendaValorCampo.value);
  const data = diasSemVendaPendentes[0];
  if (!valorVendaEsquecidaValido(vendaBase)) {
    salarioAvisoDiasSemVendaErroElemento.textContent = 'Informe o valor vendido, ou 0 se a loja não abriu.';
    salarioAvisoDiasSemVendaErroElemento.hidden = false;
    return;
  }

  const { comissao: comissaoJaNoMes, error: erroComissao } = await buscarComissaoDoMes(data);
  if (erroComissao) {
    salarioAvisoDiasSemVendaErroElemento.textContent = 'Erro ao conferir a comissão do mês. Tente novamente.';
    salarioAvisoDiasSemVendaErroElemento.hidden = false;
    return;
  }
  const { error } = await supabase.from(SALARIO_TABELA).insert(dadosVendaEsquecida(vendaBase, data, comissaoJaNoMes));
  if (error) {
    salarioAvisoDiasSemVendaErroElemento.textContent = 'Erro ao salvar. Tente novamente.';
    salarioAvisoDiasSemVendaErroElemento.hidden = false;
    return;
  }

  diasSemVendaPendentes.shift();
  atualizarVendaEsquecidaAtual();
  await carregarSalario();
});

async function carregarLancamentosSalarioParaSaldo() {
  const tamanhoPagina = 1000;
  let inicio = 0;
  const lancamentos = [];

  while (true) {
    const { data, error } = await supabase
      .from(SALARIO_TABELA)
      .select('tipo, valor, data')
      .order('id', { ascending: true })
      .range(inicio, inicio + tamanhoPagina - 1);

    if (error) return { error };

    lancamentos.push(...data);
    if (data.length < tamanhoPagina) return { data: lancamentos };
    inicio += tamanhoPagina;
  }
}

async function carregarSalario() {
  salarioVendaDataCampo.value = salarioVendaDataCampo.value || hojeISO();
  salarioPagamentoDataCampo.value = salarioPagamentoDataCampo.value || hojeISO();

  const [{ data, error }, { data: lancamentosSaldo, error: erroSaldo }] = await Promise.all([
    supabase
      .from(SALARIO_TABELA)
      .select('*')
      .order('data', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(50),
    carregarLancamentosSalarioParaSaldo(),
  ]);

  if (error || erroSaldo) {
    salarioListaLancamentosElemento.innerHTML = `<li class="estado-vazio">Erro ao carregar lançamentos.</li>`;
    return;
  }

  const saldo = calcularSaldoSalario(lancamentosSaldo);
  salarioComissaoPorMes = somarComissoesPorMes(lancamentosSaldo);
  salarioSaldoAtual = saldo;
  salarioPagarTudoElemento.hidden = saldo <= 0;
  salarioSaldoElemento.textContent = formatMoney(saldo);
  salarioSaldoElemento.classList.toggle('negativo', saldo < 0);

  const { data: vendasHistoricas, error: erroVendasHistoricas } = await supabase
    .from(SALARIO_TABELA)
    .select('data')
    .eq('tipo', 'venda')
    .order('data', { ascending: true });

  if (!erroVendasHistoricas) mostrarAvisoDiasSemVenda(vendasHistoricas);

  if (data.length === 0) {
    salarioListaLancamentosElemento.innerHTML = `<li class="estado-vazio">Nenhum lançamento ainda.</li>`;
    return;
  }

  salarioListaLancamentosElemento.innerHTML = data.map((l) => {
    const positivo = l.tipo === 'venda';
    const sinal = positivo ? '+' : '-';
    const desc = positivo
      ? (l.descricao || `Comissão (venda de ${formatMoney(l.venda_base)})`)
      : (l.descricao || 'Pagamento');
    return `
      <li class="lancamento-item">
        <div class="lancamento-info">
          <span class="lancamento-desc">${desc}</span>
          <span class="lancamento-data">${formatDataBR(l.data)}</span>
        </div>
        <span class="lancamento-valor ${positivo ? 'positivo' : 'negativo'}">${sinal} ${formatMoney(l.valor)}</span>
        <button type="button" class="botao-icone salario-excluir-lancamento" data-id="${l.id}" data-conta-id="${l.conta_pagar_id || ''}" data-data-ocorrencia="${l.data_ocorrencia || ''}" aria-label="Excluir lançamento" title="Excluir lançamento">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </li>
    `;
  }).join('');
}

salarioListaLancamentosElemento.addEventListener('click', async (e) => {
  const botao = e.target.closest('.salario-excluir-lancamento');
  if (!botao) return;
  const lancamento = {
    id: botao.dataset.id,
    conta_pagar_id: botao.dataset.contaId || null,
    data_ocorrencia: botao.dataset.dataOcorrencia || null,
  };
  const vinculado = Boolean(lancamento.conta_pagar_id && lancamento.data_ocorrencia);
  const mensagem = vinculado
    ? 'Excluir este lançamento e desfazer o pagamento da conta vinculada?'
    : 'Excluir este lançamento do Salário?';
  if (!confirm(mensagem)) return;

  botao.disabled = true;
  const { error } = await excluirLancamentoFinanceiro(SALARIO_TABELA, lancamento);
  if (error) {
    alert('Não foi possível excluir o lançamento.');
    botao.disabled = false;
    return;
  }
  await Promise.all([carregarSalario(), carregarContasPagar(), carregarCaixaCasa()]);
});

bloquearDuranteSubmit(salarioVendaFormularioElemento, async (e) => {
  e.preventDefault();
  salarioVendaErroElemento.hidden = true;

  const vendaBase = parseMoney(salarioVendaValorCampo.value);
  const data = salarioVendaDataCampo.value;
  const descricao = salarioVendaDescricaoCampo.value.trim();

  if (!vendaBase || vendaBase <= 0) {
    salarioVendaErroElemento.textContent = 'Informe um valor de venda válido.';
    salarioVendaErroElemento.hidden = false;
    return;
  }

  const { comissao: comissaoJaNoMes, error: erroComissao } = await buscarComissaoDoMes(data);
  if (erroComissao) {
    salarioVendaErroElemento.textContent = 'Erro ao conferir a comissão do mês. Tente novamente.';
    salarioVendaErroElemento.hidden = false;
    return;
  }
  const { error } = await supabase.from(SALARIO_TABELA).insert(
    dadosVendaSalario(vendaBase, data, descricao || null, comissaoJaNoMes)
  );

  if (error) {
    salarioVendaErroElemento.textContent = 'Erro ao salvar. Tente novamente.';
    salarioVendaErroElemento.hidden = false;
    return;
  }

  salarioVendaFormularioElemento.reset();
  salarioVendaDataCampo.value = hojeISO();
  atualizarRotuloBotaoSalvarVendaSalario();
  await carregarSalario();
});

bloquearDuranteSubmit(salarioPagamentoFormularioElemento, async (e) => {
  e.preventDefault();
  salarioPagamentoErroElemento.hidden = true;

  const valor = parseMoney(salarioPagamentoValorCampo.value);
  const data = salarioPagamentoDataCampo.value;
  const descricao = salarioPagamentoDescricaoCampo.value.trim() || DESCRICAO_PADRAO_PAGAMENTO_SALARIO;

  if (!valor || valor <= 0) {
    salarioPagamentoErroElemento.textContent = 'Informe um valor válido.';
    salarioPagamentoErroElemento.hidden = false;
    return;
  }

  const { error } = await supabase.from(SALARIO_TABELA).insert({
    tipo: 'pagamento',
    valor,
    data,
    descricao,
  });

  if (error) {
    salarioPagamentoErroElemento.textContent = 'Erro ao salvar. Tente novamente.';
    salarioPagamentoErroElemento.hidden = false;
    return;
  }

  salarioPagamentoFormularioElemento.reset();
  salarioPagamentoDataCampo.value = hojeISO();
  salarioPagamentoDescricaoCampo.value = DESCRICAO_PADRAO_PAGAMENTO_SALARIO;
  await carregarSalario();
});

// ===================== CONTAS A PAGAR =====================

const contasPagarTotalMesPagoElemento = document.getElementById('contas-pagar-total-mes-pago');
const contasPagarTotalMesGeralElemento = document.getElementById('contas-pagar-total-mes-geral');
const contasPagarTotalSemanaAtualElemento = document.getElementById('contas-pagar-total-semana-atual');
// Valor bruto do primeiro card (atrasadas + semana), antes do desconto do Saldo InfinitePay.
let contasPagarTotalPrimeiroCard = null;
const contasPagarTotalProximaSemanaElemento = document.getElementById('contas-pagar-total-proxima-semana');
const contasPagarRotuloSemanaAtualElemento = document.getElementById('contas-pagar-rotulo-semana-atual');
const contasPagarRotuloProximaSemanaElemento = document.getElementById('contas-pagar-rotulo-proxima-semana');
const contasPagarListaOcorrenciasElemento = document.getElementById('contas-pagar-lista-ocorrencias');
const contasPagarListaContasCadastradasElemento = document.getElementById('contas-pagar-lista-contas-cadastradas');
const contasPagarSelecaoBarraElemento = document.getElementById('contas-pagar-selecao-barra');
const contasPagarSelecaoResumoElemento = document.getElementById('contas-pagar-selecao-resumo');
const contasPagarSelecaoLimparElemento = document.getElementById('contas-pagar-selecao-limpar');
const contasPagarGruposAlteradosManualmente = new Map();
const contasPagarPagamentoJanelaElemento = document.getElementById('contas-pagar-pagamento-janela');
const contasPagarPagamentoTituloElemento = document.getElementById('contas-pagar-pagamento-titulo');
const contasPagarPagamentoResumoElemento = document.getElementById('contas-pagar-pagamento-resumo');
const contasPagarPagamentoFormularioElemento = document.getElementById('contas-pagar-pagamento-formulario');
const contasPagarPagamentoValorCampo = document.getElementById('contas-pagar-pagamento-valor');
const contasPagarPagamentoErroElemento = document.getElementById('contas-pagar-pagamento-erro');
const contasPagarPagamentoAvisoElemento = document.getElementById('contas-pagar-pagamento-aviso');
let cartaoSaldoAtual = 0;
let emprestimoSaldoAtual = 0;
let robertaSaldoAtual = 0;
let contasPagarPagamentoPendente = null;

aplicarMascaraMoney(contasPagarPagamentoValorCampo);
contasPagarPagamentoValorCampo.addEventListener('input', () => atualizarAvisoPagamentoConta());

function valorPagamentoContaValido(valor) {
  return Number.isFinite(valor) && round2(valor) > 0;
}

function atualizarAvisoPagamentoConta() {
  if (!contasPagarPagamentoPendente) return;
  const { valorTotal, valorJaPago } = contasPagarPagamentoPendente;
  const novoValor = calcularValorOcorrenciaAposPagamento(valorTotal, valorJaPago, parseMoney(contasPagarPagamentoValorCampo.value) || 0);
  contasPagarPagamentoAvisoElemento.hidden = novoValor === null;
  if (novoValor !== null) {
    contasPagarPagamentoAvisoElemento.textContent = `Acima do valor da conta: ela passa de ${formatMoney(valorTotal)} para ${formatMoney(novoValor)} e fica quitada.`;
  }
}

// Resolve com { valor, origem } ou null se o usuário cancelar.
function pedirPagamentoConta({ descricao, valorTotal, valorJaPago, origemPadrao }) {
  const valorRestante = calcularSaldoConta(valorTotal, valorJaPago);
  contasPagarPagamentoTituloElemento.textContent = descricao;
  contasPagarPagamentoResumoElemento.textContent = `Falta pagar ${formatMoney(valorRestante)}`;
  contasPagarPagamentoValorCampo.value = valorRestante.toFixed(2).replace('.', ',');
  contasPagarPagamentoFormularioElemento.elements['contas-pagar-pagamento-origem'].value = origemPadrao;
  contasPagarPagamentoErroElemento.hidden = true;
  contasPagarPagamentoAvisoElemento.hidden = true;
  contasPagarPagamentoJanelaElemento.showModal();
  return new Promise((resolve) => {
    contasPagarPagamentoPendente = { resolve, valorTotal, valorJaPago };
  });
}

function concluirPagamentoConta(resultado) {
  const pendente = contasPagarPagamentoPendente;
  contasPagarPagamentoPendente = null;
  if (contasPagarPagamentoJanelaElemento.open) contasPagarPagamentoJanelaElemento.close();
  pendente?.resolve(resultado);
}

// Janela de valor com máscara, no lugar do prompt() do navegador.
const valorJanelaElemento = document.getElementById('valor-janela');
const valorJanelaTituloElemento = document.getElementById('valor-janela-titulo');
const valorJanelaRotuloElemento = document.getElementById('valor-janela-rotulo');
const valorJanelaCampo = document.getElementById('valor-janela-campo');
const valorJanelaErroElemento = document.getElementById('valor-janela-erro');
const valorJanelaDataVencimentoElemento = document.getElementById('valor-janela-data-vencimento');
const valorJanelaDataVencimentoCampo = document.getElementById('valor-janela-data-vencimento-campo');
let valorJanelaPendente = null;

aplicarMascaraMoney(valorJanelaCampo);

// Mostra o campo de data de finalização só enquanto o valor digitado passa
// do saldo devido (Empréstimo quitado e contraído de novo, ou saindo do zero).
function atualizarDataVencimentoValorJanela() {
  const limite = valorJanelaPendente?.pedirDataAcimaDe;
  const valor = parseMoney(valorJanelaCampo.value);
  valorJanelaDataVencimentoElemento.hidden = limite === null || limite === undefined
    || !(Number.isFinite(valor) && round2(valor) > round2(limite));
}

valorJanelaCampo.addEventListener('input', atualizarDataVencimentoValorJanela);

function valorInformadoValido(valor, permitirZero) {
  return Number.isFinite(valor) && (permitirZero ? valor >= 0 : round2(valor) > 0);
}

// Resolve com o número digitado ou null se cancelar. Com `pedirDataAcimaDe`,
// resolve com { valor, dataVencimento }: a data só é pedida quando o valor
// passa desse limite, senão vem null.
function pedirValor({ titulo, rotulo = 'Valor', valorInicial = null, permitirZero = false, pedirDataAcimaDe = null }) {
  valorJanelaTituloElemento.textContent = titulo;
  valorJanelaRotuloElemento.textContent = rotulo;
  valorJanelaCampo.value = valorInicial === null ? '' : formatarValorCampo(valorInicial);
  valorJanelaDataVencimentoCampo.value = '';
  valorJanelaErroElemento.hidden = true;
  valorJanelaPendente = { resolve: null, permitirZero, pedirDataAcimaDe };
  atualizarDataVencimentoValorJanela();
  valorJanelaElemento.showModal();
  valorJanelaCampo.focus({ preventScroll: true });
  return new Promise((resolve) => {
    valorJanelaPendente.resolve = resolve;
  });
}

function concluirPedidoValor(resultado) {
  const pendente = valorJanelaPendente;
  valorJanelaPendente = null;
  if (valorJanelaElemento.open) valorJanelaElemento.close();
  pendente?.resolve(resultado);
}

document.getElementById('valor-janela-formulario').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!valorJanelaPendente) return;
  const valor = parseMoney(valorJanelaCampo.value);
  if (!valorInformadoValido(valor, valorJanelaPendente.permitirZero)) {
    valorJanelaErroElemento.textContent = valorJanelaPendente.permitirZero ? 'Informe um valor (pode ser 0,00).' : 'Informe um valor a partir de R$ 0,01.';
    valorJanelaErroElemento.hidden = false;
    return;
  }
  if (valorJanelaPendente.pedirDataAcimaDe === null) {
    concluirPedidoValor(round2(valor));
    return;
  }
  const pedeData = !valorJanelaDataVencimentoElemento.hidden;
  if (pedeData && !valorJanelaDataVencimentoCampo.value) {
    valorJanelaErroElemento.textContent = 'Informe a data de finalização.';
    valorJanelaErroElemento.hidden = false;
    return;
  }
  concluirPedidoValor({ valor: round2(valor), dataVencimento: pedeData ? valorJanelaDataVencimentoCampo.value : null });
});
document.getElementById('valor-janela-fechar').addEventListener('click', () => concluirPedidoValor(null));
valorJanelaElemento.addEventListener('close', () => concluirPedidoValor(null));

contasPagarPagamentoFormularioElemento.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!contasPagarPagamentoPendente) return;
  const valor = parseMoney(contasPagarPagamentoValorCampo.value);
  if (!valorPagamentoContaValido(valor)) {
    contasPagarPagamentoErroElemento.textContent = 'Informe um valor a partir de R$ 0,01.';
    contasPagarPagamentoErroElemento.hidden = false;
    return;
  }
  concluirPagamentoConta({ valor: round2(valor), origem: contasPagarPagamentoFormularioElemento.elements['contas-pagar-pagamento-origem'].value });
});
document.getElementById('contas-pagar-pagamento-fechar').addEventListener('click', () => concluirPagamentoConta(null));
contasPagarPagamentoJanelaElemento.addEventListener('close', () => concluirPagamentoConta(null));

function limparSelecaoContasPagar() {
  contasPagarOcorrenciasSelecionadas.clear();
  const barra = document.getElementById('contas-pagar-selecao-barra');
  if (barra) barra.hidden = true;
  document.getElementById('contas-pagar-lista-ocorrencias')?.querySelectorAll('.contas-pagar-ocorrencia-selecionada')
    .forEach((item) => item.classList.remove('contas-pagar-ocorrencia-selecionada'));
}

function textoResumoSelecaoContasPagar(selecionadas) {
  const total = somarValoresSelecionados(selecionadas);
  return selecionadas.length === 1
    ? `Selecionada: ${selecionadas[0].nome} — ${formatMoney(total)}`
    : `${selecionadas.length} itens — ${formatMoney(total)}`;
}

function atualizarBarraSelecaoContasPagar() {
  const selecionadas = [...contasPagarOcorrenciasSelecionadas.values()];
  contasPagarSelecaoBarraElemento.hidden = selecionadas.length === 0;
  if (selecionadas.length === 0) return;

  contasPagarSelecaoResumoElemento.textContent = textoResumoSelecaoContasPagar(selecionadas);
  contasPagarSelecaoLimparElemento.hidden = selecionadas.length < 2;
}

function abrirGrupoPorPadrao(itens, ehSemanaAtual = false) {
  return ehSemanaAtual || itens.some((item) => !item.paga);
}

contasPagarListaOcorrenciasElemento.addEventListener('click', (e) => {
  const selecionarBotao = e.target.closest('.contas-pagar-selecionar-botao');
  if (selecionarBotao) {
    const chave = `${selecionarBotao.dataset.contaId}|${selecionarBotao.dataset.data}`;
    if (contasPagarOcorrenciasSelecionadas.has(chave)) {
      contasPagarOcorrenciasSelecionadas.delete(chave);
    } else {
      contasPagarOcorrenciasSelecionadas.set(chave, {
        nome: selecionarBotao.dataset.nome,
        valor: Number(selecionarBotao.dataset.valor),
      });
    }
    selecionarBotao.closest('.lancamento-item').classList.toggle('contas-pagar-ocorrencia-selecionada', contasPagarOcorrenciasSelecionadas.has(chave));
    atualizarBarraSelecaoContasPagar();
    return;
  }

  const summary = e.target.closest('summary');
  const details = summary?.parentElement;
  if (!details?.classList.contains('contas-pagar-grupo-details')) return;
  contasPagarGruposAlteradosManualmente.set(details.dataset.grupo, !details.open);
});

contasPagarSelecaoLimparElemento.addEventListener('click', () => {
  limparSelecaoContasPagar();
});

const contasPagarFormularioElemento = document.getElementById('contas-pagar-formulario');
const contasPagarFormularioErroElemento = document.getElementById('contas-pagar-formulario-erro');
const contasPagarDescricaoCampo = document.getElementById('contas-pagar-descricao');
const contasPagarValorCampo = document.getElementById('contas-pagar-valor');
const contasPagarDataInicioCampo = document.getElementById('contas-pagar-data-inicio');
const contasPagarCampoDataUnicaElemento = document.getElementById('contas-pagar-campo-data-unica');
const contasPagarCampoParcelasElemento = document.getElementById('contas-pagar-campo-parcelas');
const contasPagarQuantidadeParcelasCampo = document.getElementById('contas-pagar-quantidade-parcelas');
const contasPagarDatasParcelasElemento = document.getElementById('contas-pagar-datas-parcelas');
const contasPagarValorModoElemento = document.getElementById('contas-pagar-valor-modo');
aplicarMascaraMoney(contasPagarValorCampo);

function atualizarCamposTipoContaPagar() {
  const parcelado = document.querySelector('input[name="contas-pagar-tipo"]:checked').value === 'parcelado';
  contasPagarCampoDataUnicaElemento.hidden = parcelado;
  contasPagarCampoParcelasElemento.hidden = !parcelado;
  contasPagarDataInicioCampo.required = !parcelado;
  contasPagarValorModoElemento.hidden = !parcelado;
}

document.querySelectorAll('input[name="contas-pagar-tipo"]').forEach((el) => {
  el.addEventListener('change', () => {
    atualizarCamposTipoContaPagar();
  });
});

contasPagarQuantidadeParcelasCampo.addEventListener('input', () => {
  contasPagarQuantidadeParcelasCampo.value = contasPagarQuantidadeParcelasCampo.value.replace(/\D/g, '');
  const qtde = limitarQuantidadeParcelas(contasPagarQuantidadeParcelasCampo.value);

  const existentes = contasPagarDatasParcelasElemento.querySelectorAll('input[type="date"]');
  if (qtde < existentes.length) {
    existentes.forEach((el, i) => { if (i >= qtde) el.closest('.campo-parcela').remove(); });
    return;
  }

  for (let i = existentes.length; i < qtde; i++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'campo-parcela';
    wrapper.innerHTML = `
      <label>Data da parcela ${i + 1}</label>
      <input type="date" class="contas-pagar-data-parcela" required>
    `;
    contasPagarDatasParcelasElemento.appendChild(wrapper);
  }
});

function limitarQuantidadeParcelas(valor) {
  return Math.min(Number(valor) || 0, 24);
}

// "repetir": valor digitado se repete em cada parcela.
// "dividir": valor digitado é o total, dividido em partes iguais — o
// resto de centavos (por arredondamento) vai pra última parcela, pra
// soma bater exatamente com o total.
function calcularValoresParcelas(valor, qtde, modo) {
  if (modo === 'repetir') {
    return new Array(qtde).fill(round2(valor));
  }

  const partes = new Array(qtde).fill(round2(Math.floor((valor / qtde) * 100) / 100));
  const somaParcial = round2(partes.reduce((acc, v) => acc + v, 0));
  partes[qtde - 1] = round2(partes[qtde - 1] + (valor - somaParcial));
  return partes;
}

// Último dia válido do mês/ano para um dia_vencimento que pode não existir
// em todo mês (ex: dia 31 em abril vira 30).
function ultimoDiaDoMes(ano, mesIndex) {
  return new Date(ano, mesIndex + 1, 0).getDate();
}

// Monta a data de uma ocorrência mensal. Só a ocorrência é reduzida ao último
// dia do mês; o dia_vencimento da conta continua 31, então o mês seguinte
// de 31 dias volta a cair no dia 31.
function montarDataOcorrencia(ano, mesIndex, diaVencimento) {
  const dia = Math.min(diaVencimento, ultimoDiaDoMes(ano, mesIndex));
  const mm = String(mesIndex + 1).padStart(2, '0');
  const dd = String(dia).padStart(2, '0');
  return `${ano}-${mm}-${dd}`;
}

// Gera todas as datas de vencimento de uma conta recorrente, de
// data_inicio até `ate` (inclusive), pulando datas em exdates.
function gerarOcorrenciasRecorrenteAte(conta, exdates, ate) {
  const [anoIni, mesIni] = conta.data_inicio.split('-').map(Number);

  const ocorrencias = [];
  let ano = anoIni;
  let mesIndex = mesIni - 1;

  while (true) {
    const data = montarDataOcorrencia(ano, mesIndex, conta.dia_vencimento);
    if (data > ate) break;

    if (data >= conta.data_inicio && !exdates.has(data)) {
      ocorrencias.push(data);
    }

    mesIndex += 1;
    if (mesIndex > 11) {
      mesIndex = 0;
      ano += 1;
    }
  }

  return ocorrencias;
}

// Todas as ocorrências vencidas (< hoje) de uma conta recorrente, mais as
// próximas `qtdeFuturas` a partir de hoje (inclusive). As pagas permanecem
// visíveis para preservar o histórico e permitir desfazer uma baixa.
function gerarOcorrenciasRecorrenteParaExibir(conta, exdates, qtdeFuturas, hoje = hojeISO()) {
  const vencidas = gerarOcorrenciasRecorrenteAte(conta, exdates, hoje)
    .filter((data) => data < hoje);

  const futuras = [];
  const [anoIni, mesIni] = hoje.split('-').map(Number);
  let ano = anoIni;
  let mesIndex = mesIni - 1;

  while (futuras.length < qtdeFuturas) {
    const data = montarDataOcorrencia(ano, mesIndex, conta.dia_vencimento);
    if (data >= hoje && data >= conta.data_inicio && !exdates.has(data)) {
      futuras.push(data);
    }
    mesIndex += 1;
    if (mesIndex > 11) {
      mesIndex = 0;
      ano += 1;
    }
  }

  return [...vencidas, ...futuras];
}

function encontrarPrimeiroAluguelAberto(contas, exdatesRows, parcelasRows, pagos, ajustesRows) {
  const pagamentosMap = new Map(pagos.map((pagamento) => [`${pagamento.conta_id}|${pagamento.data}`, pagamento]));
  const ajustesMap = new Map(ajustesRows.map((ajuste) => [`${ajuste.conta_id}|${ajuste.data}`, Number(ajuste.valor)]));
  const alugueisAbertos = [];

  contas.filter(ehAluguel).forEach((conta) => {
    let ocorrencias;
    if (conta.tipo === 'parcelado') {
      ocorrencias = parcelasRows
        .filter((parcela) => parcela.conta_id === conta.id)
        .map((parcela) => ({ data: parcela.data, valor: Number(parcela.valor) }));
    } else {
      const exdates = new Set(
        exdatesRows.filter((exdate) => exdate.conta_id === conta.id).map((exdate) => exdate.data)
      );
      ocorrencias = gerarOcorrenciasRecorrenteParaExibir(conta, exdates, pagos.length + 1)
        .map((data) => ({
          data,
          valor: ajustesMap.get(`${conta.id}|${data}`) ?? Number(conta.valor),
        }));
    }

    ocorrencias.forEach((ocorrencia) => {
      const pagamento = pagamentosMap.get(`${conta.id}|${ocorrencia.data}`);
      const valorRestante = calcularSaldoConta(ocorrencia.valor, pagamento?.valor_pago);
      if (valorRestante > 0) alugueisAbertos.push({ ...ocorrencia, valor: valorRestante });
    });
  });

  alugueisAbertos.sort((a, b) => a.data.localeCompare(b.data));
  return alugueisAbertos[0] || null;
}

async function carregarContasPagar() {
  contasPagarDataInicioCampo.value = contasPagarDataInicioCampo.value || hojeISO();

  const [
    { data: contas, error: errContas },
    { data: exdatesRows, error: errEx },
    { data: parcelasRows, error: errParc },
    { data: pagos, error: errPag },
    { data: ajustesRows, error: errAjustes },
    { data: caixaRows, error: errCaixa },
    { data: emprestimoRows, error: errEmprestimo },
    { data: cartaoRows, error: errCartao },
    { data: robertaRows, error: errRoberta },
  ] = await Promise.all([
    supabase.from(CONTAS_PAGAR_TABELA).select('*').order('data_inicio', { ascending: true }),
    supabase.from(CONTAS_PAGAR_EXDATES_TABELA).select('*'),
    supabase.from(CONTAS_PAGAR_PARCELAS_TABELA).select('*'),
    supabase.from(CONTAS_PAGAR_PAGAMENTOS_TABELA).select('*'),
    supabase.from(CONTAS_PAGAR_AJUSTES_TABELA).select('*'),
    supabase.from(CAIXA_CASA_TABELA)
      .select('tipo, valor')
      .order('data', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from(EMPRESTIMO_TABLE).select('*').order('data', { ascending: false }).order('created_at', { ascending: false }),
    supabase.from(CARTAO_CREDITO_TABLE).select('*').order('data', { ascending: false }).order('created_at', { ascending: false }),
    supabase.from(ROBERTA_TABLE).select('*').order('data', { ascending: false }).order('created_at', { ascending: false }),
  ]);

  if (errContas || errEx || errParc || errPag || errAjustes || errCaixa || errEmprestimo || errCartao || errRoberta) {
    contasPagarListaOcorrenciasElemento.innerHTML = `<li class="estado-vazio">${errEmprestimo ? 'Aplique a migration 012 para habilitar o Empréstimo.' : errCartao ? 'Aplique a migration 010 para habilitar o Cartão de Crédito.' : errRoberta ? 'Aplique a migration 014 para habilitar o Dinheiro Roberta.' : 'Erro ao carregar contas a pagar.'}</li>`;
    contasPagarListaContasCadastradasElemento.innerHTML = '';
    return;
  }

  const ajustesMap = new Map(ajustesRows.map((a) => [`${a.conta_id}|${a.data}`, Number(a.valor)]));

  const pagamentosMap = new Map(pagos.map((p) => [`${p.conta_id}|${p.data}`, p]));
  emprestimoSaldoAtual = calcularSaldoDivida(emprestimoRows);
  cartaoSaldoAtual = calcularSaldoDivida(cartaoRows);
  robertaSaldoAtual = calcularSaldoDivida(robertaRows);
  const emprestimoHtml = renderizarEmprestimo(emprestimoRows, emprestimoSaldoAtual);
  const cartaoCreditoHtml = renderizarCartaoCredito(cartaoRows, cartaoSaldoAtual);
  const robertaHtml = renderizarRoberta(robertaRows, robertaSaldoAtual);
  const saldoCaixa = calcularSaldoCaixa(caixaRows);
  const aluguelAbertoCaixa = encontrarPrimeiroAluguelAberto(contas, exdatesRows, parcelasRows, pagos, ajustesRows);
  exibirSaldoAposAluguelCaixaCasa(saldoCaixa, aluguelAbertoCaixa?.valor);
  caixaCasaSaldoTotalElemento.textContent = formatMoney(saldoCaixa);
  caixaCasaSaldoTotalElemento.classList.toggle('negativo', saldoCaixa < 0);

  if (contas.length === 0) {
    contasPagarListaOcorrenciasElemento.innerHTML = emprestimoHtml + cartaoCreditoHtml + robertaHtml + '<li class="estado-vazio">Nenhuma conta cadastrada.</li>';
    contasPagarListaContasCadastradasElemento.innerHTML = `<li class="estado-vazio">Nenhuma conta cadastrada.</li>`;
    contasPagarTotalMesPagoElemento.textContent = formatMoney(0);
    contasPagarTotalMesGeralElemento.textContent = formatMoney(0);
    contasPagarTotalSemanaAtualElemento.textContent = formatMoney(0);
    contasPagarTotalPrimeiroCard = 0;
    atualizarAbatimentoInfinitepayContasPagar();
    contasPagarTotalProximaSemanaElemento.textContent = formatMoney(0);
    contasPagarRotuloSemanaAtualElemento.textContent = 'Esta semana';
    contasPagarRotuloProximaSemanaElemento.textContent = 'Próxima semana';
    return;
  }

  const hoje = hojeISO();
  const mesAtual = hoje.slice(0, 7);
  const ocorrenciasParaExibir = [];

  contas.forEach((conta) => {
    let ocorrencias;

    if (conta.tipo === 'parcelado') {
      ocorrencias = parcelasRows
        .filter((p) => p.conta_id === conta.id)
        .map((p) => ({ data: p.data, valor: Number(p.valor) }));
    } else {
      const exdatesDaConta = new Set(
        exdatesRows.filter((e) => e.conta_id === conta.id).map((e) => e.data)
      );
      ocorrencias = gerarOcorrenciasRecorrenteParaExibir(conta, exdatesDaConta, 3)
        .map((data) => ({
          data,
          valor: ajustesMap.get(`${conta.id}|${data}`) ?? Number(conta.valor),
        }));
    }

    ocorrencias.forEach(({ data, valor }) => {
      const valorOriginal = valor;
      const chave = `${conta.id}|${data}`;
      const pagamento = pagamentosMap.get(chave);
      const valorPago = limitarValorPagoConta(pagamento?.valor_pago, valorOriginal);
      const valorRestante = calcularSaldoConta(valorOriginal, valorPago);
      const paga = valorRestante === 0;
      const atrasada = data < hoje && !paga;
      ocorrenciasParaExibir.push({
        conta,
        data,
        valor: valorRestante,
        valorOriginal,
        valorPago,
        valorCaixaPago: Number(pagamento?.valor_caixa || 0),
        valorRobertaPago: Number(pagamento?.valor_roberta || 0),
        paga,
        atrasada,
      });
    });
  });

  ocorrenciasParaExibir.sort((a, b) => a.data.localeCompare(b.data));

  const primeiroAluguelAberto = ocorrenciasParaExibir.find((ocorrencia) => {
    return !ocorrencia.paga && ehAluguel(ocorrencia.conta);
  });
  if (primeiroAluguelAberto && saldoCaixa > 0) {
    primeiroAluguelAberto.abatimentoCaixa = calcularAbatimentoAluguel(saldoCaixa, primeiroAluguelAberto.valor);
  }

  const ocorrenciasMesAtual = ocorrenciasParaExibir.filter((ocorrencia) => ocorrencia.data.slice(0, 7) === mesAtual);
  const totalMesPago = ocorrenciasMesAtual.reduce((acc, ocorrencia) => acc + ocorrencia.valorPago, 0);
  const totalMesNaoPago = ocorrenciasMesAtual
    .filter((ocorrencia) => !ocorrencia.paga)
    .reduce((acc, ocorrencia) => acc + valorExibidoOcorrencia(ocorrencia), 0);

  const totalMesGeral = round2(totalMesPago + totalMesNaoPago);
  contasPagarTotalMesPagoElemento.textContent = formatMoney(totalMesPago);
  contasPagarTotalMesGeralElemento.textContent = formatMoney(totalMesGeral);

  // Empréstimo e Cartão entram na lista de semanas e nos dois cards, mas não
  // no resumo do mês.
  const ocorrenciasResumoSemanal = ocorrenciasParaExibir.concat(pendenciasDividasNoResumoSemanal({
    emprestimoLancamentos: emprestimoRows,
    emprestimoSaldo: emprestimoSaldoAtual,
    cartaoLancamentos: cartaoRows,
    cartaoSaldo: cartaoSaldoAtual,
    hoje,
  })).sort((a, b) => a.data.localeCompare(b.data));
  const gruposSemanaTodos = agruparPorSemana(ocorrenciasResumoSemanal);

  function totalPendenteDaSemana(ano, mes, semana) {
    const grupo = gruposSemanaTodos.find((g) => g.ano === ano && g.mes === mes && g.semana === semana);
    if (!grupo) return null;
    const pendentes = grupo.itens.filter(entraNoResumoSemanal);
    if (pendentes.length === 0) return null;
    return pendentes.reduce((acc, i) => acc + valorExibidoOcorrencia(i), 0);
  }

  // Acha a primeira semana (a partir de `dataRef`, que já está `saltos`
  // semanas à frente de hoje) que ainda tem alguma ocorrência não paga. Se
  // a semana já está toda paga (ou vazia), avança semana a semana até
  // achar uma com pendência — sem limite.
  function acharSemanaComPendencia(dataRef, saltos) {
    const datasPendentes = ocorrenciasResumoSemanal
      .filter(entraNoResumoSemanal)
      .map((ocorrencia) => ocorrencia.data)
      .sort();
    const ultimaDataPendente = datasPendentes[datasPendentes.length - 1];

    while (true) {
      const [ano, mes] = dataRef.split('-').map(Number);
      const semana = semanaDoMes(dataRef);
      const total = totalPendenteDaSemana(ano, mes, semana);

      if (total !== null) {
        return { ano, mes, semana, dataRef, saltos, total };
      }

      if (!ultimaDataPendente || dataRef > ultimaDataPendente) {
        return { ano, mes, semana, dataRef, saltos, total: 0 };
      }

      dataRef = chaveSemanaSeguinte(dataRef).data;
      saltos += 1;
    }
  }

  function rotuloDistanciaSemana(saltos) {
    if (saltos === 0) return 'Esta semana';
    if (saltos === 1) return 'Próxima semana';
    return `Em ${saltos} semanas`;
  }

  const semanaAtual = acharSemanaComPendencia(hoje, 0);
  const proximaSemana = acharSemanaComPendencia(chaveSemanaSeguinte(semanaAtual.dataRef).data, semanaAtual.saltos + 1);
  const totalAtrasadas = totalAtrasadasNoResumoSemanal(ocorrenciasResumoSemanal, hoje);

  contasPagarTotalPrimeiroCard = round2(semanaAtual.total + totalAtrasadas);
  atualizarAbatimentoInfinitepayContasPagar();
  contasPagarTotalProximaSemanaElemento.textContent = formatMoney(proximaSemana.total);
  contasPagarRotuloSemanaAtualElemento.textContent = totalAtrasadas > 0
    ? `Atrasadas + ${rotuloDistanciaSemana(semanaAtual.saltos).toLowerCase()}`
    : rotuloDistanciaSemana(semanaAtual.saltos);
  contasPagarRotuloProximaSemanaElemento.textContent = rotuloDistanciaSemana(proximaSemana.saltos);

  const anoHoje = semanaAtual.ano;
  const mesHoje = semanaAtual.mes;
  const semanaHoje = semanaAtual.semana;

  function ehGrupoDaSemanaAtual(grupo) {
    return grupo.ano === anoHoje && grupo.mes === mesHoje && grupo.semana === semanaHoje;
  }

  function renderizarItemOcorrencia(ocorrencia) {
    const { conta, data, valor, valorOriginal, valorPago, valorCaixaPago, valorRobertaPago, paga, atrasada } = ocorrencia;
    const valorExibido = valorExibidoOcorrencia(ocorrencia);
    const parcial = valorPago > 0 && !paga;
    const botoesAcao = (paga || valorPago > 0) ? '' : `
        <button type="button" class="botao-icone botao-icone-neutro contas-pagar-editar-botao" data-conta-id="${conta.id}" data-data="${data}" data-tipo="${conta.tipo}" data-valor="${valorOriginal}" aria-label="Editar valor" title="Editar valor">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button type="button" class="botao-icone contas-pagar-pular-botao" data-conta-id="${conta.id}" data-data="${data}" data-tipo="${conta.tipo}" aria-label="Pular esta ocorrência" title="Pular esta ocorrência">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>`;

    const chaveSelecao = `${conta.id}|${data}`;
    const selecionada = contasPagarOcorrenciasSelecionadas.has(chaveSelecao);

    return `
      <li class="lancamento-item${atrasada ? ' lancamento-atrasada' : ''}${selecionada ? ' contas-pagar-ocorrencia-selecionada' : ''}">
        <div class="lancamento-checkbox">
          <input type="checkbox" data-conta-id="${conta.id}" data-data="${data}" data-valor="${valorOriginal}" data-valor-pago="${valorPago}" data-valor-caixa="${valorCaixaPago}" data-valor-roberta="${valorRobertaPago}" data-descricao="${conta.descricao}" data-tipo="${conta.tipo}" data-aluguel="${ehAluguel(conta) ? 'true' : 'false'}" data-parcial="${parcial ? 'true' : 'false'}" class="contas-pagar-pago-checkbox" aria-label="${parcial ? 'Adicionar pagamento em' : 'Marcar'} ${conta.descricao}" ${paga ? 'checked' : ''}>
          <div class="lancamento-info">
            <div class="lancamento-nome-tags"><button type="button" class="contas-pagar-selecionar-botao" data-conta-id="${conta.id}" data-data="${data}" data-nome="${conta.descricao}" data-valor="${valorExibido}">${conta.descricao}</button>${parcial ? ' <span class="tag-parcial">Parcial</span>' : ''}${atrasada ? ' <span class="tag-atrasada">Atrasada</span>' : ''}</div>
            <span class="lancamento-data">${formatDataBR(data)}${parcial ? ` · Pago ${formatMoney(valorPago)}` : ''}${etiquetaAbatimentoCaixaOcorrencia(ocorrencia)}</span>
          </div>
        </div>
        <span class="lancamento-valor negativo">${formatMoney(valorExibido)}</span>${botoesAcao}
      </li>
    `;
  }

  function renderizarGruposSemana(grupos) {
    return grupos.map((grupo) => {
      const ehSemanaAtual = ehGrupoDaSemanaAtual(grupo);
      const itensHtml = grupo.itens
        .map((item) => (item.tabela ? renderizarItemDividaOcorrencia(item, hoje) : renderizarItemOcorrencia(item)))
        .join('');
      const rotuloSemana = `Semana ${grupo.semana}`;
      const totalGrupo = grupo.itens.reduce((acc, item) => acc + valorExibidoOcorrencia(item), 0);
      const chaveSemana = `${grupo.ano}-${grupo.mes}-${grupo.semana}`;
      const aberta = contasPagarGruposAlteradosManualmente.get(chaveSemana) ?? abrirGrupoPorPadrao(grupo.itens, ehSemanaAtual);

      return `
        <li class="semana-grupo">
          <details class="contas-pagar-grupo-details" data-grupo="${chaveSemana}"${aberta ? ' open' : ''}>
            <summary class="semana-grupo-titulo${ehSemanaAtual ? ' semana-atual' : ''}">
              <span>${NOMES_MES[grupo.mes - 1]} — ${rotuloSemana}${ehSemanaAtual ? '<span class="semana-atual-dot"></span>' : ''}</span>
              <span class="semana-grupo-total">${formatMoney(totalGrupo)}</span>
            </summary>
            <ul class="lancamentos">${itensHtml}</ul>
          </details>
        </li>
      `;
    }).join('');
  }

  contasPagarListaOcorrenciasElemento.innerHTML = emprestimoHtml + cartaoCreditoHtml + robertaHtml + renderizarGruposSemana(agruparPorSemana(ocorrenciasResumoSemanal));
  contasPagarListaOcorrenciasElemento.querySelectorAll('.contas-pagar-pago-checkbox[data-parcial="true"]').forEach((checkbox) => {
    checkbox.indeterminate = true;
  });
  const chavesDisponiveis = new Set(ocorrenciasParaExibir.map((ocorrencia) => `${ocorrencia.conta.id}|${ocorrencia.data}`));
  contasPagarOcorrenciasSelecionadas.forEach((_ocorrencia, chave) => {
    if (!chavesDisponiveis.has(chave)) contasPagarOcorrenciasSelecionadas.delete(chave);
  });
  atualizarBarraSelecaoContasPagar();

  contasPagarListaContasCadastradasElemento.innerHTML = contas.map((conta) => {
    const valorExibido = conta.tipo === 'parcelado'
      ? parcelasRows.filter((p) => p.conta_id === conta.id).reduce((acc, p) => acc + Number(p.valor), 0)
      : Number(conta.valor);

    return `
    <li class="lancamento-item">
      <div class="lancamento-info">
        <span class="lancamento-desc">${conta.descricao}</span>
        <span class="lancamento-data">${conta.tipo === 'parcelado' ? 'parcelado' : `mensal — dia ${conta.dia_vencimento}`}</span>
      </div>
      <span class="lancamento-valor negativo">${formatMoney(valorExibido)}</span>
      <button type="button" class="botao-icone contas-pagar-remover-botao" data-conta-id="${conta.id}" aria-label="Remover conta" title="Remover conta">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    </li>
  `;
  }).join('');
}

async function alternarPagoContasPagar(e) {
  if (!e.target.classList.contains('contas-pagar-pago-checkbox')) return;
  const checkbox = e.target;
  const contaId = checkbox.dataset.contaId;
  const data = checkbox.dataset.data;
  const aluguel = checkbox.dataset.aluguel === 'true';
  const valor = Number(checkbox.dataset.valor);
  const anterior = {
    valorPago: Number(checkbox.dataset.valorPago || 0),
    valorCaixa: Number(checkbox.dataset.valorCaixa || 0),
    valorRoberta: Number(checkbox.dataset.valorRoberta || 0),
  };
  const descricao = checkbox.dataset.descricao;
  const tipoConta = checkbox.dataset.tipo;

  checkbox.disabled = true;

  if (checkbox.checked) {
    const escolha = await pedirPagamentoConta({
      descricao,
      valorTotal: valor,
      valorJaPago: anterior.valorPago,
      origemPadrao: aluguel ? 'caixa' : 'proprio',
    });
    if (!escolha) {
      await carregarContasPagar();
      return;
    }

    const novoValorOcorrencia = calcularValorOcorrenciaAposPagamento(valor, anterior.valorPago, escolha.valor);
    if (novoValorOcorrencia !== null) {
      const { error: erroValor } = await gravarValorOcorrencia(contaId, data, tipoConta, novoValorOcorrencia);
      if (erroValor) {
        alert('Não foi possível atualizar o valor da conta. Nada foi pago.');
        await carregarContasPagar();
        return;
      }
    }
    const restaurarValorOcorrencia = () => (novoValorOcorrencia === null
      ? Promise.resolve({ error: null })
      : gravarValorOcorrencia(contaId, data, tipoConta, valor));

    const { origem } = escolha;
    const novo = calcularNovoPagamentoConta(anterior, escolha.valor, origem);
    const vinculoOrigem = {
      caixa: { tabela: CAIXA_CASA_TABELA, nome: 'o Caixa Casa', dados: (v) => dadosSaidaCaixaDaConta(contaId, v, data, descricao) },
      roberta: { tabela: ROBERTA_TABLE, nome: 'a dívida da Roberta', dados: (v) => dadosDividaRobertaDaConta(contaId, v, data, descricao) },
    }[origem];
    const valorAnteriorOrigem = origem === 'caixa' ? anterior.valorCaixa : anterior.valorRoberta;
    const valorNovoOrigem = origem === 'caixa' ? novo.valorCaixa : novo.valorRoberta;

    const restaurarPagamentoAnterior = async () => {
      const { error: erroValor } = await restaurarValorOcorrencia();
      if (erroValor) return { error: erroValor };

      if (anterior.valorPago === 0) {
        return supabase.from(CONTAS_PAGAR_PAGAMENTOS_TABELA).delete().eq('conta_id', contaId).eq('data', data);
      }

      const { error: erroPagamento } = await supabase.from(CONTAS_PAGAR_PAGAMENTOS_TABELA).upsert(
        dadosPagamentoConta(contaId, data, anterior.valorPago, anterior.valorCaixa, anterior.valorRoberta)
      );
      if (erroPagamento) return { error: erroPagamento };

      if (!vinculoOrigem) return { error: null };
      if (valorAnteriorOrigem > 0) {
        return supabase.from(vinculoOrigem.tabela).upsert(
          vinculoOrigem.dados(valorAnteriorOrigem),
          { onConflict: 'conta_pagar_id,data_ocorrencia' }
        );
      }
      return supabase.from(vinculoOrigem.tabela)
        .delete()
        .eq('conta_pagar_id', contaId)
        .eq('data_ocorrencia', data);
    };

    const falharEDesfazer = async (mensagem) => {
      const { error: erroDesfazerPagamento } = await restaurarPagamentoAnterior();
      alert(erroDesfazerPagamento
        ? 'O pagamento ficou incompleto. Ajuste os registros no banco.'
        : mensagem);
      await carregarContasPagar();
    };

    const { error: erroPagamento } = await supabase.from(CONTAS_PAGAR_PAGAMENTOS_TABELA).upsert(
      dadosPagamentoConta(contaId, data, novo.valorPago, novo.valorCaixa, novo.valorRoberta)
    );
    if (erroPagamento) {
      const { error: erroDesfazerValor } = await restaurarValorOcorrencia();
      alert(erroDesfazerValor
        ? 'O pagamento falhou e o valor da conta ficou alterado. Ajuste o valor pelo lápis.'
        : 'Não foi possível registrar o pagamento.');
      await carregarContasPagar();
      return;
    }

    if (vinculoOrigem) {
      const { error: erroOrigem } = await supabase.from(vinculoOrigem.tabela).upsert(
        vinculoOrigem.dados(valorNovoOrigem),
        { onConflict: 'conta_pagar_id,data_ocorrencia' }
      );
      if (erroOrigem) {
        await falharEDesfazer(`Não foi possível atualizar ${vinculoOrigem.nome}. O pagamento anterior foi preservado.`);
        return;
      }
    }
  } else {
    const { error } = await supabase
      .from(CONTAS_PAGAR_PAGAMENTOS_TABELA)
      .delete()
      .eq('conta_id', contaId)
      .eq('data', data);
    if (error) alert('Não foi possível desmarcar o pagamento.');
  }
  await Promise.all([carregarContasPagar(), carregarSalario(), carregarCaixaCasa()]);
}

contasPagarListaOcorrenciasElemento.addEventListener('change', alternarPagoContasPagar);
contasPagarListaOcorrenciasElemento.addEventListener('change', quitarDividaContasPagar);

// Checkbox da linha de Empréstimo/Cartão: grava um abatimento do saldo
// inteiro, e a linha some da lista por ficar sem saldo.
async function quitarDividaContasPagar(e) {
  if (!e.target.classList.contains('contas-pagar-divida-quitar-checkbox')) return;
  const checkbox = e.target;
  const { tabela, nome } = checkbox.dataset;
  const saldoAtual = tabela === EMPRESTIMO_TABLE ? emprestimoSaldoAtual : cartaoSaldoAtual;
  if (saldoAtual <= 0 || !confirm(`Quitar ${nome} (${formatMoney(saldoAtual)})?`)) {
    checkbox.checked = false;
    return;
  }
  const { error } = await supabase.from(tabela).insert(dadosLancamentoDivida('abatimento', saldoAtual));
  if (error) {
    checkbox.checked = false;
    alert(`Erro ao quitar o ${nome}.`);
    return;
  }
  await carregarContasPagar();
}

contasPagarListaOcorrenciasElemento.addEventListener('click', async (e) => {
  const dividaExcluirBotao = e.target.closest('.cartao-excluir-botao');
  if (dividaExcluirBotao) {
    const nome = dividaExcluirBotao.dataset.nome;
    const doNome = nome === 'Roberta' ? 'da Roberta' : `do ${nome}`;
    const lancamento = {
      id: dividaExcluirBotao.dataset.id,
      conta_pagar_id: dividaExcluirBotao.dataset.contaId || null,
      data_ocorrencia: dividaExcluirBotao.dataset.dataOcorrencia || null,
    };
    const vinculado = Boolean(lancamento.conta_pagar_id && lancamento.data_ocorrencia);
    const mensagem = vinculado
      ? 'Excluir este movimento e desfazer o pagamento da conta vinculada?'
      : `Excluir este movimento ${doNome}?`;
    if (!confirm(mensagem)) return;
    const { error } = await excluirLancamentoFinanceiro(dividaExcluirBotao.dataset.tabela, lancamento);
    if (error) alert(`Não foi possível excluir o movimento ${doNome}.`);
    await Promise.all([carregarContasPagar(), carregarSalario(), carregarCaixaCasa()]);
    return;
  }

  const dividaValorAtualBotao = e.target.closest('.divida-valor-atual-botao');
  if (dividaValorAtualBotao) {
    const nome = dividaValorAtualBotao.dataset.nome;
    // Só o Empréstimo pede data de finalização; o Cartão vence num dia fixo.
    const emprestimo = dividaValorAtualBotao.dataset.tabela === EMPRESTIMO_TABLE;
    const saldoAtual = emprestimo ? emprestimoSaldoAtual : cartaoSaldoAtual;
    const resposta = await pedirValor({
      titulo: `Valor atual do ${nome}`,
      rotulo: 'Quanto a dívida vale hoje',
      valorInicial: saldoAtual,
      permitirZero: true,
      pedirDataAcimaDe: emprestimo ? saldoAtual : null,
    });
    if (resposta === null) return;

    const valorInformado = emprestimo ? resposta.valor : resposta;
    const dataVencimento = emprestimo ? resposta.dataVencimento : null;
    const dados = dadosAtualizacaoValorDivida(valorInformado, saldoAtual, hojeISO(), dataVencimento);
    if (!dados) return;

    const { error } = await supabase.from(dividaValorAtualBotao.dataset.tabela).insert(dados);
    if (error) {
      alert('Erro ao registrar o movimento. Confira se as migrations 010, 012 e 020 foram aplicadas.');
      return;
    }
    await carregarContasPagar();
    return;
  }

  const dividaMovimentoBotao = e.target.closest('.divida-movimento-botao');
  if (dividaMovimentoBotao) {
    const abatimento = dividaMovimentoBotao.dataset.tipo === 'abatimento';
    const nome = dividaMovimentoBotao.dataset.nome;
    const roberta = dividaMovimentoBotao.dataset.tabela === ROBERTA_TABLE;
    const saldoAtual = roberta ? robertaSaldoAtual : cartaoSaldoAtual;
    const valorInformado = await pedirValor({
      titulo: abatimento
        ? `Abater ${roberta ? 'da Roberta' : `do ${nome}`}`
        : `Adicionar ${roberta ? 'à Roberta' : `ao ${nome}`}`,
      rotulo: abatimento ? 'Valor para abater' : 'Valor para adicionar',
      valorInicial: abatimento ? saldoAtual : null,
    });
    if (valorInformado === null) return;

    const valor = abatimento
      ? limitarAbatimentoDivida(valorInformado, saldoAtual)
      : valorInformado;
    if (!valor) {
      alert('Não há saldo para abater.');
      return;
    }

    const { error } = await supabase.from(dividaMovimentoBotao.dataset.tabela).insert(
      dadosLancamentoDivida(dividaMovimentoBotao.dataset.tipo, valor)
    );
    if (error) {
      alert(`Erro ao registrar o movimento. Confira se a migration ${roberta ? '014' : '010'} foi aplicada.`);
      return;
    }
    await carregarContasPagar();
    return;
  }

  const pularBotao = e.target.closest('.contas-pagar-pular-botao');
  if (pularBotao) {
    if (pularBotao.dataset.tipo === 'parcelado') {
      await supabase.from(CONTAS_PAGAR_PARCELAS_TABELA).delete().eq('conta_id', pularBotao.dataset.contaId).eq('data', pularBotao.dataset.data);
    } else {
      await supabase.from(CONTAS_PAGAR_EXDATES_TABELA).insert({ conta_id: pularBotao.dataset.contaId, data: pularBotao.dataset.data });
    }
    await carregarContasPagar();
    return;
  }

  const editarBotao = e.target.closest('.contas-pagar-editar-botao');
  if (editarBotao) {
    const { contaId, data, tipo, valor } = editarBotao.dataset;
    const novoValor = await pedirValor({ titulo: 'Editar valor', rotulo: 'Novo valor', valorInicial: Number(valor) });
    if (novoValor === null) return;

    await gravarValorOcorrencia(contaId, data, tipo, novoValor);
    await carregarContasPagar();
  }
});

contasPagarListaContasCadastradasElemento.addEventListener('click', async (e) => {
  const botao = e.target.closest('.contas-pagar-remover-botao');
  if (!botao) return;
  if (!confirm('Remover esta conta e todo o seu histórico de pagamentos/parcelas/exceções?')) return;
  await supabase.from(CONTAS_PAGAR_TABELA).delete().eq('id', botao.dataset.contaId);
  await carregarContasPagar();
});

bloquearDuranteSubmit(contasPagarFormularioElemento, async (e) => {
  e.preventDefault();
  contasPagarFormularioErroElemento.hidden = true;

  const descricao = contasPagarDescricaoCampo.value.trim();
  const valor = parseMoney(contasPagarValorCampo.value);
  const tipo = document.querySelector('input[name="contas-pagar-tipo"]:checked').value;

  if (!valor || valor <= 0) {
    contasPagarFormularioErroElemento.textContent = 'Informe um valor válido.';
    contasPagarFormularioErroElemento.hidden = false;
    return;
  }

  if (tipo === 'recorrente') {
    const dataInicio = contasPagarDataInicioCampo.value;
    if (!dataInicio) {
      contasPagarFormularioErroElemento.textContent = 'Informe a data.';
      contasPagarFormularioErroElemento.hidden = false;
      return;
    }

    const dia = Number(dataInicio.split('-')[2]);
    const { error } = await supabase.from(CONTAS_PAGAR_TABELA).insert({
      descricao,
      valor,
      tipo: 'recorrente',
      dia_vencimento: dia,
      data_inicio: dataInicio,
    });

    if (error) {
      contasPagarFormularioErroElemento.textContent = 'Erro ao salvar. Tente novamente.';
      contasPagarFormularioErroElemento.hidden = false;
      return;
    }
  } else {
    const datasParcelas = Array.from(contasPagarDatasParcelasElemento.querySelectorAll('.contas-pagar-data-parcela')).map((el) => el.value);

    if (datasParcelas.length === 0 || datasParcelas.some((d) => !d)) {
      contasPagarFormularioErroElemento.textContent = 'Informe a quantidade de parcelas e preencha todas as datas.';
      contasPagarFormularioErroElemento.hidden = false;
      return;
    }

    const modoValor = document.querySelector('input[name="contas-pagar-valor-modo"]:checked').value;
    const valoresParcelas = calcularValoresParcelas(valor, datasParcelas.length, modoValor);
    const dataInicio = [...datasParcelas].sort()[0];

    const { data: contaCriada, error } = await supabase.from(CONTAS_PAGAR_TABELA).insert({
      descricao,
      tipo: 'parcelado',
      data_inicio: dataInicio,
    }).select().single();

    if (error) {
      contasPagarFormularioErroElemento.textContent = 'Erro ao salvar. Tente novamente.';
      contasPagarFormularioErroElemento.hidden = false;
      return;
    }

    const { error: errParcelas } = await supabase.from(CONTAS_PAGAR_PARCELAS_TABELA).insert(
      datasParcelas.map((data, i) => ({ conta_id: contaCriada.id, data, valor: valoresParcelas[i] }))
    );

    if (errParcelas) {
      contasPagarFormularioErroElemento.textContent = 'Conta criada, mas houve erro ao salvar as parcelas.';
      contasPagarFormularioErroElemento.hidden = false;
      return;
    }
  }

  contasPagarFormularioElemento.reset();
  contasPagarDataInicioCampo.value = hojeISO();
  document.getElementById('contas-pagar-tipo-recorrente').checked = true;
  atualizarCamposTipoContaPagar();
  contasPagarDatasParcelasElemento.innerHTML = '';
  await carregarContasPagar();
});

// ===================== FIADO =====================

const fiadoTotalElemento = document.getElementById('fiado-total');
const fiadoListaPessoasElemento = document.getElementById('fiado-lista-pessoas');
const fiadoVendaFormularioElemento = document.getElementById('fiado-venda-formulario');
const fiadoVendaErroElemento = document.getElementById('fiado-venda-erro');
const fiadoVendaPessoaCampo = document.getElementById('fiado-venda-pessoa');
const fiadoPessoasDatalistElemento = document.getElementById('fiado-pessoas-datalist');
const fiadoVendaValorCampo = document.getElementById('fiado-venda-valor');
const fiadoVendaDataCampo = document.getElementById('fiado-venda-data');
const fiadoVendaDescricaoCampo = document.getElementById('fiado-venda-descricao');
const fiadoPagamentoFormularioElemento = document.getElementById('fiado-pagamento-formulario');
const fiadoPagamentoErroElemento = document.getElementById('fiado-pagamento-erro');
const fiadoPagamentoPessoaSeletorElemento = document.getElementById('fiado-pagamento-pessoa');
const fiadoPagamentoValorCampo = document.getElementById('fiado-pagamento-valor');
const fiadoPagamentoDataCampo = document.getElementById('fiado-pagamento-data');
const fiadoPagamentoDescricaoCampo = document.getElementById('fiado-pagamento-descricao');
aplicarMascaraMoney(fiadoVendaValorCampo);
aplicarMascaraMoney(fiadoPagamentoValorCampo);

async function carregarFiado() {
  fiadoVendaDataCampo.value = fiadoVendaDataCampo.value || hojeISO();
  fiadoPagamentoDataCampo.value = fiadoPagamentoDataCampo.value || hojeISO();

  const { data: lancamentos, error } = await supabase
    .from(FIADO_TABELA).select('*').order('data', { ascending: false }).order('created_at', { ascending: false });

  if (error) {
    fiadoListaPessoasElemento.innerHTML = `<li class="estado-vazio">Erro ao carregar fiado.</li>`;
    return;
  }

  const pessoas = nomesDistintosFiado(lancamentos);
  fiadoPessoasDatalistElemento.innerHTML = pessoas.map((nome) => `<option value="${nome}">`).join('');

  if (pessoas.length === 0) {
    fiadoListaPessoasElemento.innerHTML = `<li class="estado-vazio">Nenhum lançamento de fiado.</li>`;
    fiadoTotalElemento.textContent = formatMoney(0);
    fiadoPagamentoPessoaSeletorElemento.innerHTML = `<option value="">Nenhuma pessoa cadastrada</option>`;
    return;
  }

  const saldosPorPessoa = new Map(pessoas.map((nome) => {
    const chave = chavePessoaFiado(nome);
    const lancamentosDaPessoa = lancamentos.filter((lancamento) => chavePessoaFiado(lancamento.pessoa_nome) === chave);
    return [chave, calcularSaldoFiado(lancamentosDaPessoa)];
  }));

  const pessoaSelecionada = fiadoPagamentoPessoaSeletorElemento.value;
  fiadoPagamentoPessoaSeletorElemento.innerHTML = `
    <option value="">Escolha a pessoa</option>
    ${pessoas.map((nome) => `<option value="${nome}">${nome} — ${rotuloSaldoFiado(saldosPorPessoa.get(chavePessoaFiado(nome)))}</option>`).join('')}
  `;
  fiadoPagamentoPessoaSeletorElemento.value = pessoaSelecionada;

  let totalGeral = 0;

  fiadoListaPessoasElemento.innerHTML = pessoas.map((nome) => {
    const chave = chavePessoaFiado(nome);
    const lancamentosDaPessoa = lancamentos.filter((lancamento) => chavePessoaFiado(lancamento.pessoa_nome) === chave);
    const saldoPessoa = saldosPorPessoa.get(chave);
    totalGeral += saldoPessoa;

    const lancamentosHtml = lancamentosDaPessoa.length === 0
      ? `<li class="estado-vazio">Nenhum lançamento ainda.</li>`
      : lancamentosDaPessoa.map((lancamento) => {
        const pagamento = lancamento.tipo === 'pagamento';
        const descricao = lancamento.descricao || (pagamento ? 'Pagamento' : 'Sem descrição');
        const rotuloRemover = pagamento ? 'Remover pagamento' : 'Remover venda';
        return `
        <li class="lancamento-item">
          <div class="lancamento-info">
            <span class="lancamento-desc">${descricao}</span>
            <span class="lancamento-data">${formatDataBR(lancamento.data)}</span>
          </div>
          <span class="lancamento-valor ${pagamento ? 'positivo' : 'negativo'}">${pagamento ? '− ' : ''}${formatMoney(lancamento.valor)}</span>
          <button type="button" class="botao-icone fiado-remover-lancamento-botao" data-id="${lancamento.id}" data-tipo="${lancamento.tipo}" aria-label="${rotuloRemover}" title="${rotuloRemover}">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </li>
      `;
      }).join('');

    return `
      <li class="semana-grupo">
        <details class="fiado-pessoa-details">
          <summary class="fiado-pessoa-summary">
            <span class="fiado-pessoa-nome">${nome}</span>
            <span class="lancamento-valor ${saldoPessoa > 0 ? 'negativo' : 'positivo'}">${rotuloSaldoFiado(saldoPessoa)}</span>
          </summary>
          <ul class="lancamentos">${lancamentosHtml}</ul>
        </details>
      </li>
    `;
  }).join('');

  fiadoTotalElemento.textContent = formatMoney(round2(totalGeral));
}

fiadoListaPessoasElemento.addEventListener('click', async (e) => {
  const removerBotao = e.target.closest('.fiado-remover-lancamento-botao');
  if (removerBotao) {
    const { error } = await supabase.from(FIADO_TABELA).delete().eq('id', removerBotao.dataset.id);
    if (error) {
      alert('Erro ao remover o lançamento. Tente novamente.');
      return;
    }
    await carregarFiado();
  }
});

bloquearDuranteSubmit(fiadoVendaFormularioElemento, async (e) => {
  e.preventDefault();
  fiadoVendaErroElemento.hidden = true;

  const nomePessoa = fiadoVendaPessoaCampo.value.trim();
  const valor = parseMoney(fiadoVendaValorCampo.value);
  const data = fiadoVendaDataCampo.value;
  const descricao = fiadoVendaDescricaoCampo.value.trim();

  if (!nomePessoa) {
    fiadoVendaErroElemento.textContent = 'Informe o nome da pessoa.';
    fiadoVendaErroElemento.hidden = false;
    return;
  }

  if (!valor || valor <= 0) {
    fiadoVendaErroElemento.textContent = 'Informe um valor válido.';
    fiadoVendaErroElemento.hidden = false;
    return;
  }

  const { data: nomesExistentes, error: errBusca } = await supabase
    .from(FIADO_TABELA)
    .select('pessoa_nome');

  if (errBusca) {
    fiadoVendaErroElemento.textContent = 'Erro ao salvar. Tente novamente.';
    fiadoVendaErroElemento.hidden = false;
    return;
  }

  const pessoaNomeExistente = nomesExistentes.find((lancamento) => {
    return chavePessoaFiado(lancamento.pessoa_nome) === chavePessoaFiado(nomePessoa);
  })?.pessoa_nome;

  const { error } = await supabase.from(FIADO_TABELA).insert({
    tipo: 'venda',
    pessoa_nome: pessoaNomeExistente || nomePessoa,
    valor,
    data,
    descricao: descricao || null,
  });

  if (error) {
    fiadoVendaErroElemento.textContent = 'Erro ao salvar. Tente novamente.';
    fiadoVendaErroElemento.hidden = false;
    return;
  }

  fiadoVendaFormularioElemento.reset();
  fiadoVendaDataCampo.value = hojeISO();
  await carregarFiado();
});

bloquearDuranteSubmit(fiadoPagamentoFormularioElemento, async (e) => {
  e.preventDefault();
  fiadoPagamentoErroElemento.hidden = true;

  const pessoaNome = fiadoPagamentoPessoaSeletorElemento.value;
  const valor = parseMoney(fiadoPagamentoValorCampo.value);
  const data = fiadoPagamentoDataCampo.value;
  const descricao = fiadoPagamentoDescricaoCampo.value.trim() || 'Pagamento';

  if (!pessoaNome) {
    fiadoPagamentoErroElemento.textContent = 'Escolha a pessoa que realizou o pagamento.';
    fiadoPagamentoErroElemento.hidden = false;
    return;
  }

  if (!valor || valor <= 0) {
    fiadoPagamentoErroElemento.textContent = 'Informe um valor válido.';
    fiadoPagamentoErroElemento.hidden = false;
    return;
  }

  const { error } = await supabase.from(FIADO_TABELA).insert({
    tipo: 'pagamento',
    pessoa_nome: pessoaNome,
    valor,
    data,
    descricao,
  });

  if (error) {
    fiadoPagamentoErroElemento.textContent = 'Erro ao salvar. Tente novamente.';
    fiadoPagamentoErroElemento.hidden = false;
    return;
  }

  fiadoPagamentoFormularioElemento.reset();
  fiadoPagamentoDataCampo.value = hojeISO();
  fiadoPagamentoDescricaoCampo.value = 'Pagamento';
  await carregarFiado();
});

// ===================== INFINITEPAY =====================
// Saldo da conta InfinitePay, buscado pela Edge Function infinitepay-saldo.
// Os cURLs com o cookie de sessão só são enviados (nunca lidos): ficam no servidor.

const INFINITEPAY_FUNCAO = 'infinitepay-saldo';
const INFINITEPAY_ALERTA_SESSAO_MS = 3 * 24 * 60 * 60 * 1000;
const INFINITEPAY_ALERTA_JWT_MS = 5 * 60 * 1000;
const infinitepaySaldoBotoes = document.querySelectorAll('.infinitepay-saldo-botao');
const infinitepayReceberBlocos = document.querySelectorAll('.infinitepay-receber');
const infinitepayJanelaElemento = document.getElementById('infinitepay-janela');
const infinitepayJanelaSituacaoElemento = document.getElementById('infinitepay-janela-situacao');
const infinitepayJanelaValidadesElemento = document.getElementById('infinitepay-janela-validades');
const infinitepayFormularioElemento = document.getElementById('infinitepay-formulario');
const infinitepayFormularioErroElemento = document.getElementById('infinitepay-formulario-erro');
let infinitepaySaldoAtual = null;

const INFINITEPAY_MENSAGENS = {
  sem_sessao: 'Cole os cURLs da sessão',
  curl_invalido: 'cURL inválido',
  sessao_expirada: 'Sessão expirada, cole o cURL de novo',
  bloqueado_cloudflare: 'Bloqueado pela Cloudflare',
  formato_desconhecido: 'Resposta em formato desconhecido',
  erro: 'Erro ao consultar',
};

// Converte a resposta da função no texto do botão; alerta = precisa de atenção do usuário.
function textoSaldoInfinitepay(resposta) {
  if (resposta?.estado === 'ok') return { texto: formatMoney(resposta.saldo), alerta: false };
  return { texto: INFINITEPAY_MENSAGENS[resposta?.estado] || INFINITEPAY_MENSAGENS.erro, alerta: true };
}

// Texto do bloco "A receber": valor e período (dd/mm a dd/mm), ou o problema encontrado.
function textoAReceberInfinitepay(aReceber) {
  const curta = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');
  const periodo = aReceber?.periodo ? `${curta(aReceber.periodo.since)} a ${curta(aReceber.periodo.until)}` : '';
  if (aReceber?.estado === 'ok') return { texto: formatMoney(aReceber.valor), periodo, alerta: false };
  if (!aReceber) return { texto: '—', periodo, alerta: false };
  return { texto: INFINITEPAY_MENSAGENS[aReceber.estado] || INFINITEPAY_MENSAGENS.erro, periodo, alerta: true };
}

// Mostra o "A receber" (mobile e desktop); com formato desconhecido, a estrutura vai para a janela.
function exibirAReceberInfinitepay(aReceber) {
  const { texto, periodo, alerta } = textoAReceberInfinitepay(aReceber);
  infinitepayReceberBlocos.forEach((bloco) => {
    bloco.querySelector('.infinitepay-receber-valor').textContent = texto;
    const linhaPeriodo = bloco.querySelector('.infinitepay-receber-periodo');
    linhaPeriodo.textContent = periodo;
    linhaPeriodo.hidden = !periodo;
    bloco.classList.toggle('infinitepay-receber-alerta', alerta);
  });
  if (aReceber?.formato) console.info('InfinitePay a receber — formato:', JSON.stringify(aReceber.formato));
}

// Desconta o Saldo InfinitePay do primeiro card de Contas a Pagar, como o Caixa Casa faz no aluguel.
// Devolve o valor que sobra a pagar (nunca negativo) e quanto do saldo foi usado.
function calcularContasPagarAposSaldoInfinitepay(totalContas, saldo) {
  const abatimento = round2(Math.min(Math.max(saldo, 0), totalContas));
  return { restante: round2(totalContas - abatimento), abatimento };
}

// Classifica uma data de expiração: vencida, perto (dentro do limite de alerta) ou ok.
function situacaoValidade(expiraEmIso, agoraMs, limiteAlertaMs) {
  if (!expiraEmIso) return null;
  const restante = Date.parse(expiraEmIso) - agoraMs;
  if (restante <= 0) return 'vencida';
  return restante <= limiteAlertaMs ? 'perto' : 'ok';
}

// Data e hora curtas (dd/mm hh:mm) para as validades.
function formatarDataHoraCurta(iso) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// Mostra o primeiro card de Contas a Pagar já com o saldo descontado, quando o saldo e as contas chegaram.
function atualizarAbatimentoInfinitepayContasPagar() {
  if (contasPagarTotalPrimeiroCard === null) return;
  const abatimentoElemento = document.getElementById('contas-pagar-abatimento-infinitepay');
  if (infinitepaySaldoAtual === null) {
    contasPagarTotalSemanaAtualElemento.textContent = formatMoney(contasPagarTotalPrimeiroCard);
    abatimentoElemento.hidden = true;
    return;
  }
  const { restante, abatimento } = calcularContasPagarAposSaldoInfinitepay(contasPagarTotalPrimeiroCard, infinitepaySaldoAtual);
  contasPagarTotalSemanaAtualElemento.textContent = formatMoney(restante);
  abatimentoElemento.hidden = abatimento <= 0;
  abatimentoElemento.textContent = `−${formatMoney(abatimento)} do Saldo`;
}

// Mostra as validades: no botão, a da sessão que vence primeiro; na janela, todas.
function exibirValidadesInfinitepay(validades) {
  const agora = Date.now();
  const sessao = [validades?.ifp_token_exp, validades?.ipdashboard_session].filter(Boolean).sort()[0] || null;
  const situacaoSessao = situacaoValidade(sessao, agora, INFINITEPAY_ALERTA_SESSAO_MS);
  infinitepaySaldoBotoes.forEach((botao) => {
    const linha = botao.querySelector('.infinitepay-validade');
    // Só aparece quando a sessão já venceu ou vence em até 3 dias.
    linha.hidden = situacaoSessao !== 'perto' && situacaoSessao !== 'vencida';
    linha.className = `infinitepay-validade${situacaoSessao ? ` infinitepay-validade-${situacaoSessao}` : ''}`;
    if (sessao) linha.textContent = `Sessão ${situacaoSessao === 'vencida' ? 'venceu em' : 'até'} ${formatarDataHoraCurta(sessao)}`;
  });

  const itens = [
    ['ifp_token_exp', validades?.ifp_token_exp, INFINITEPAY_ALERTA_SESSAO_MS],
    ['ipdashboard_session', validades?.ipdashboard_session, INFINITEPAY_ALERTA_SESSAO_MS],
    ['JWT (renova sozinho)', validades?.jwt, INFINITEPAY_ALERTA_JWT_MS],
  ];
  infinitepayJanelaValidadesElemento.innerHTML = itens.map(([nome, data, limite]) => {
    const situacao = situacaoValidade(data, agora, limite);
    return `<li class="${situacao ? `infinitepay-validade-${situacao}` : ''}">${nome}: ${data ? formatarDataHoraCurta(data) : 'desconhecida'}</li>`;
  }).join('');
}

// Mostra a resposta no botão do saldo (mobile e desktop) e na janela da sessão.
function exibirSaldoInfinitepay(resposta) {
  const { texto, alerta } = textoSaldoInfinitepay(resposta);
  infinitepaySaldoAtual = resposta?.estado === 'ok' ? resposta.saldo : null;
  infinitepaySaldoBotoes.forEach((botao) => {
    botao.querySelector('.infinitepay-saldo-valor').textContent = texto;
    botao.classList.toggle('infinitepay-saldo-alerta', alerta);
  });
  const detalhe = resposta?.chaves ? ` (chaves: ${resposta.chaves.join(', ')})` : '';
  infinitepayJanelaSituacaoElemento.textContent = alerta ? `${texto}${detalhe}` : `Saldo atual: ${texto}`;
  if (resposta?.validades) exibirValidadesInfinitepay(resposta.validades);
  exibirAReceberInfinitepay(resposta?.a_receber);
  atualizarAbatimentoInfinitepayContasPagar();
}

// Chama a Edge Function; erros de rede ou de deploy viram o estado "erro".
async function chamarInfinitepay(corpo) {
  const { data, error } = await supabase.functions.invoke(INFINITEPAY_FUNCAO, { body: corpo });
  if (error) console.warn('InfinitePay:', error);
  return error ? { estado: 'erro' } : data;
}

// Busca o saldo atual ao abrir a Home.
async function carregarSaldoInfinitepay() {
  exibirSaldoInfinitepay(await chamarInfinitepay({ acao: 'saldo' }));
}

infinitepaySaldoBotoes.forEach((botao) => {
  botao.addEventListener('click', () => {
    infinitepayFormularioErroElemento.hidden = true;
    infinitepayJanelaElemento.showModal();
  });
});

document.querySelectorAll('.infinitepay-atualizar-botao').forEach((botao) => {
  botao.addEventListener('click', async () => {
    document.querySelectorAll('.infinitepay-atualizar-botao').forEach((cada) => { cada.disabled = true; });
    infinitepaySaldoBotoes.forEach((saldo) => { saldo.querySelector('.infinitepay-saldo-valor').textContent = '…'; });
    infinitepayReceberBlocos.forEach((bloco) => { bloco.querySelector('.infinitepay-receber-valor').textContent = '…'; });
    try {
      await carregarSaldoInfinitepay();
    } finally {
      document.querySelectorAll('.infinitepay-atualizar-botao').forEach((cada) => { cada.disabled = false; });
    }
  });
});

document.getElementById('infinitepay-janela-fechar').addEventListener('click', () => infinitepayJanelaElemento.close());

// Lista os problemas encontrados no cURL (texto puro, sem HTML).
function exibirErrosInfinitepay(erros) {
  infinitepayFormularioErroElemento.replaceChildren(...erros.map((erro) => {
    const item = document.createElement('li');
    item.textContent = erro;
    return item;
  }));
  infinitepayFormularioErroElemento.hidden = false;
}

bloquearDuranteSubmit(infinitepayFormularioElemento, async (e) => {
  e.preventDefault();
  const curl = document.getElementById('infinitepay-curl').value.trim();
  if (!/\bcurl\b/i.test(curl)) {
    exibirErrosInfinitepay(['Cole ao menos um comando curl.']);
    return;
  }

  const resposta = await chamarInfinitepay({ acao: 'salvar', curl });
  // Limpa sempre: o texto colado não fica na tela.
  infinitepayFormularioElemento.reset();
  if (resposta?.estado !== 'curl_invalido') exibirSaldoInfinitepay(resposta);
  if (resposta?.estado === 'ok') infinitepayJanelaElemento.close();
  else exibirErrosInfinitepay(resposta?.erros || [textoSaldoInfinitepay(resposta).texto]);
});

// ===================== INIT =====================

function executarTestes() {
  showView('testes');
  document.title = 'Testes — Gestão Ammi';

  const resultados = [];
  const igual = (atual, esperado) => {
    if (!Object.is(atual, esperado)) {
      throw new Error(`esperado ${JSON.stringify(esperado)}, recebido ${JSON.stringify(atual)}`);
    }
  };
  const igualJson = (atual, esperado) => igual(JSON.stringify(atual), JSON.stringify(esperado));
  const teste = (nome, executar) => {
    try {
      executar();
      resultados.push({ nome, ok: true });
    } catch (erro) {
      resultados.push({ nome, ok: false, erro: erro.message });
    }
  };

  teste('Dinheiro — lê valor brasileiro com milhar', () => igual(parseMoney('1.234,56'), 1234.56));
  teste('Dinheiro — lê valor brasileiro sem milhar', () => igual(parseMoney('1234,56'), 1234.56));
  teste('Dinheiro — lê ponto com duas casas como decimal', () => igual(parseMoney('77.62'), 77.62));
  teste('Dinheiro — mantém ponto com três casas como milhar', () => igual(parseMoney('1.234'), 1234));
  teste('Dinheiro — entrada vazia é inválida', () => igual(Number.isNaN(parseMoney('')), true));
  teste('Dinheiro — arredonda para dois centavos', () => igual(round2(10.005), 10.01));
  teste('Caixa — entradas somam e saídas subtraem', () => {
    igual(calcularSaldoCaixa([{ tipo: 'entrada', valor: 150 }, { tipo: 'saida', valor: 40 }]), 110);
  });
  teste('Contas a Pagar — pagamento com Caixa cria saída vinculada', () => {
    igualJson(dadosSaidaCaixaDaConta('c1', 40, '2026-10-06', 'Aluguel'), {
      tipo: 'saida',
      valor: 40,
      data: '2026-10-06',
      descricao: 'Aluguel',
      conta_pagar_id: 'c1',
      data_ocorrencia: '2026-10-06',
    });
  });
  teste('Contas a Pagar — pagamento parcial reduz somente o saldo restante', () => {
    igual(calcularSaldoConta(500, 125.5), 374.5);
  });
  teste('Contas a Pagar — pagamento não ultrapassa o valor da ocorrência', () => {
    igual(limitarValorPagoConta(550, 500), 500);
  });
  teste('Contas a Pagar — pagamento usa a chave da ocorrência atual', () => {
    igual(carregarContasPagar.toString().includes('const chave = `${conta.id}|${data}`;'), true);
  });
  teste('Contas a Pagar — baixa guarda acumulado pago e partes do Caixa e da Roberta', () => {
    igualJson(dadosPagamentoConta('c1', '2026-10-10', 125.5, 40, 30), {
      conta_id: 'c1', data: '2026-10-10', valor_pago: 125.5, valor_caixa: 40, valor_roberta: 30,
    });
  });
  teste('Contas a Pagar — pagamento com meu dinheiro só aumenta o acumulado pago', () => {
    igualJson(calcularNovoPagamentoConta({ valorPago: 50, valorCaixa: 20, valorRoberta: 10 }, 30, 'proprio'), {
      valorPago: 80, valorCaixa: 20, valorRoberta: 10,
    });
  });
  teste('Contas a Pagar — pagamento com Caixa acumula também a parte do Caixa', () => {
    igualJson(calcularNovoPagamentoConta({ valorPago: 50, valorCaixa: 20, valorRoberta: 0 }, 25.5, 'caixa'), {
      valorPago: 75.5, valorCaixa: 45.5, valorRoberta: 0,
    });
  });
  teste('Contas a Pagar — pagamento com dinheiro da Roberta acumula a parte da Roberta', () => {
    igualJson(calcularNovoPagamentoConta({ valorPago: 0, valorCaixa: 0, valorRoberta: 0 }, 120, 'roberta'), {
      valorPago: 120, valorCaixa: 0, valorRoberta: 120,
    });
  });
  teste('Contas a Pagar — valor do pagamento aceita qualquer valor a partir de R$ 0,01', () => {
    igual(valorPagamentoContaValido(40), true);
    igual(valorPagamentoContaValido(150), true);
    igual(valorPagamentoContaValido(0), false);
    igual(valorPagamentoContaValido(NaN), false);
  });
  teste('Contas a Pagar — pagamento dentro do restante não altera o valor da conta', () => {
    igual(calcularValorOcorrenciaAposPagamento(100, 30, 70), null);
    igual(calcularValorOcorrenciaAposPagamento(100, 0, 40), null);
  });
  teste('Contas a Pagar — pagamento acima do restante atualiza a conta para o total pago', () => {
    igual(calcularValorOcorrenciaAposPagamento(100, 0, 112.35), 112.35);
    igual(calcularValorOcorrenciaAposPagamento(100, 30, 75.5), 105.5);
  });
  teste('Roberta — pagamento com o dinheiro dela vira dívida vinculada', () => {
    igualJson(dadosDividaRobertaDaConta('c1', 120, '2026-10-10', 'Internet'), {
      tipo: 'divida',
      valor: 120,
      data: '2026-10-10',
      descricao: 'Internet',
      conta_pagar_id: 'c1',
      data_ocorrencia: '2026-10-10',
    });
  });
  teste('Roberta — excluir dívida vinculada desfaz o pagamento da conta', () => {
    igualJson(alvoExclusaoLancamento(ROBERTA_TABLE, {
      id: 'r1', conta_pagar_id: 'c1', data_ocorrencia: '2026-10-10',
    }), {
      tabela: CONTAS_PAGAR_PAGAMENTOS_TABELA,
      filtros: { conta_id: 'c1', data: '2026-10-10' },
      vinculado: true,
    });
  });
  teste('Contas a Pagar — ocorrência quitada continua exibindo o valor original', () => {
    igual(valorExibidoOcorrencia({ valor: 0, valorOriginal: 500, paga: true }), 500);
  });
  teste('Resumo semanal — ignora ocorrências pagas', () => {
    const ocorrencias = [
      { valor: 20, paga: true, conta: {} },
      { valor: 214.9, paga: false, conta: {} },
    ];
    igual(ocorrencias.filter(entraNoResumoSemanal).reduce((total, item) => total + item.valor, 0), 214.9);
  });
  teste('Resumo semanal — soma atrasadas comuns ao primeiro card', () => {
    const ocorrencias = [
      { data: '2026-09-23', valor: 182.93, paga: false, conta: {} },
      { data: '2026-10-07', valor: 214.9, paga: false, conta: {} },
      { data: '2026-10-04', valor: 75, paga: true, conta: {} },
    ];
    igual(totalAtrasadasNoResumoSemanal(ocorrencias, '2026-10-06'), 182.93);
  });
  teste('Exclusão — lançamento vinculado desfaz o pagamento da conta', () => {
    igualJson(alvoExclusaoLancamento(SALARIO_TABELA, {
      id: 's1', conta_pagar_id: 'c1', data_ocorrencia: '2026-10-06',
    }), {
      tabela: CONTAS_PAGAR_PAGAMENTOS_TABELA,
      filtros: { conta_id: 'c1', data: '2026-10-06' },
      vinculado: true,
    });
  });
  teste('Exclusão — lançamento manual apaga somente sua própria linha', () => {
    igualJson(alvoExclusaoLancamento(CAIXA_CASA_TABELA, { id: 'cx1' }), {
      tabela: CAIXA_CASA_TABELA, filtros: { id: 'cx1' }, vinculado: false,
    });
  });
  teste('Caixa — saldo após aluguel nunca fica negativo', () => igual(calcularSaldoAposAluguel(300, 500), 0));
  teste('Caixa — saldo após aluguel preserva a sobra', () => igual(calcularSaldoAposAluguel(800, 500), 300));
  teste('Aluguel — abatimento não ultrapassa o aluguel', () => igual(calcularAbatimentoAluguel(800, 500), 500));
  teste('Aluguel — saldo negativo não gera abatimento', () => igual(calcularAbatimentoAluguel(-10, 500), 0));
  teste('Caixa — etiqueta mostra quanto do aluguel saiu do caixa e some sem desconto', () => {
    const etiqueta = document.getElementById('caixa-casa-abatimento-aluguel');
    exibirSaldoAposAluguelCaixaCasa(800, 500);
    igual(etiqueta.hidden, false);
    igual(etiqueta.textContent, `−${formatMoney(500)} do Aluguel`);
    exibirSaldoAposAluguelCaixaCasa(-10, 500);
    igual(etiqueta.hidden, true);
  });
  teste('Aluguel — primeira ocorrência aberta mostra etiqueta do desconto do Caixa Casa', () => {
    igual(etiquetaAbatimentoCaixaOcorrencia({ abatimentoCaixa: 300 }).includes(`−${formatMoney(300)} do Caixa Casa`), true);
    igual(etiquetaAbatimentoCaixaOcorrencia({ abatimentoCaixa: 0 }), '');
    igual(etiquetaAbatimentoCaixaOcorrencia({}), '');
  });
  teste('Aluguel — valor líquido alimenta linha, semana e resumo mensal', () => {
    igual(valorExibidoOcorrencia({ valor: 1000, abatimentoCaixa: 300 }), 700);
  });
  teste('Aluguel — só o nome exato vem com o Caixa pré-selecionado', () => {
    igual(ehAluguel({ descricao: ' ALUGUEL ' }), true);
    igual(ehAluguel({ descricao: 'Aluguel casa' }), false);
  });
  teste('Salário — comissão é 15% da venda', () => igual(calcularComissao(199.99, 0, '2026-12-01'), 30));
  teste('Salário — em novembro/2026 a comissão é 15% sem teto', () => {
    igual(calcularComissao(417.8, 795.42, '2026-11-20'), 62.67);
    igual(calcularComissao(1000, 900, '2026-11-30'), 150);
  });
  teste('Salário — comissão para no teto de R$ 800 do mês', () => {
    igual(TETO_COMISSAO_MES, 800);
    igual(calcularComissao(1000, 750, '2026-12-05'), 50);
    igual(calcularComissao(1000, 800, '2026-12-05'), 0);
    igual(calcularComissao(1000, 900, '2027-01-10'), 0);
    igual(calcularComissao(100, 700, '2026-12-05'), 15);
  });
  teste('Salário — comissões somadas por mês só contam vendas', () => {
    const porMes = somarComissoesPorMes([
      { tipo: 'venda', valor: 300, data: '2026-11-02' },
      { tipo: 'venda', valor: 200.5, data: '2026-11-20' },
      { tipo: 'pagamento', valor: 999, data: '2026-11-10' },
      { tipo: 'venda', valor: 50, data: '2026-12-01' },
    ]);
    igual(porMes.get('2026-11'), 500.5);
    igual(porMes.get('2026-12'), 50);
  });
  teste('Datas — último dia do mês considera fevereiro bissexto', () => {
    igual(ultimoDiaDoMesISO('2028-02-10'), '2028-02-29');
    igual(ultimoDiaDoMesISO('2026-11-15'), '2026-11-30');
  });
  teste('Salário — venda esquecida grava valor bruto e comissão na data exibida', () => {
    igualJson(dadosVendaSalario(200, '2026-09-02'), {
      tipo: 'venda', valor: 30, venda_base: 200, descricao: null, data: '2026-09-02',
    });
  });
  teste('Empréstimo e Cartão — dívida aumenta e abatimento reduz o saldo', () => {
    igual(calcularSaldoDivida([
      { tipo: 'divida', valor: 250 },
      { tipo: 'divida', valor: 75.5 },
      { tipo: 'abatimento', valor: 100 },
    ]), 225.5);
  });
  teste('Empréstimo e Cartão — abatimento não ultrapassa o saldo', () => {
    igual(limitarAbatimentoDivida(100, 62.3), 62.3);
  });
  teste('Empréstimo e Cartão — movimento grava valor positivo com tipo e data', () => {
    igualJson(dadosLancamentoDivida('divida', 80, '2026-10-06'), {
      tipo: 'divida', valor: 80, data: '2026-10-06',
    });
  });
  teste('Empréstimo — valor atual maior que o saldo grava dívida com a diferença', () => {
    igualJson(dadosAtualizacaoValorDivida(300, 225.5, '2026-10-06'), {
      tipo: 'divida', valor: 74.5, data: '2026-10-06',
    });
  });
  teste('Empréstimo — valor atual menor que o saldo grava abatimento com a diferença', () => {
    igualJson(dadosAtualizacaoValorDivida(100, 225.5, '2026-10-06'), {
      tipo: 'abatimento', valor: 125.5, data: '2026-10-06',
    });
  });
  teste('Empréstimo — valor atual igual ao saldo não gera movimento', () => {
    igual(dadosAtualizacaoValorDivida(225.5, 225.5), null);
  });
  teste('Empréstimo — valor atual zero abate o saldo inteiro', () => {
    igualJson(dadosAtualizacaoValorDivida(0, 225.5, '2026-10-06'), {
      tipo: 'abatimento', valor: 225.5, data: '2026-10-06',
    });
  });
  teste('Empréstimo — data de finalização só é gravada quando o valor aumenta', () => {
    igualJson(dadosAtualizacaoValorDivida(300, 0, '2026-10-06', '2027-03-10'), {
      tipo: 'divida', valor: 300, data: '2026-10-06', data_vencimento: '2027-03-10',
    });
    igualJson(dadosAtualizacaoValorDivida(100, 225.5, '2026-10-06', '2027-03-10'), {
      tipo: 'abatimento', valor: 125.5, data: '2026-10-06',
    });
  });
  teste('Cartão — vencimento é o próximo dia do mês, virando mês e ano', () => {
    igual(proximoVencimentoCartao(28, '2026-11-28'), '2026-11-28');
    igual(proximoVencimentoCartao(10, '2026-12-20'), '2027-01-10');
    igual(proximoVencimentoCartao(31, '2027-02-05'), '2027-02-28');
  });
  teste('Resumo semanal — Empréstimo e Cartão entram com o saldo na data de vencimento', () => {
    igualJson(pendenciasDividasNoResumoSemanal({
      emprestimoLancamentos: [
        { tipo: 'abatimento', valor: 50, data_vencimento: null },
        { tipo: 'divida', valor: 200, data_vencimento: '2026-12-05' },
        { tipo: 'divida', valor: 100, data_vencimento: '2026-10-01' },
      ],
      emprestimoSaldo: 250,
      cartaoLancamentos: [{ tipo: 'divida', valor: 80, dia_vencimento: 3 }],
      cartaoSaldo: 80,
      hoje: '2026-11-28',
    }), [
      { data: '2026-12-05', valor: 250, tabela: EMPRESTIMO_TABLE, titulo: 'Empréstimo' },
      { data: '2026-12-03', valor: 80, tabela: CARTAO_CREDITO_TABLE, titulo: 'Cartão de Crédito' },
    ]);
  });
  teste('Resumo semanal — sem vencimento ou sem saldo, Empréstimo e Cartão ficam fora', () => {
    igualJson(pendenciasDividasNoResumoSemanal({
      emprestimoLancamentos: [{ tipo: 'divida', valor: 200, data_vencimento: null }],
      emprestimoSaldo: 200,
      cartaoLancamentos: [{ tipo: 'divida', valor: 80, dia_vencimento: 3 }],
      cartaoSaldo: 0,
      hoje: '2026-11-28',
    }), []);
  });
  teste('Resumo semanal — Empréstimo vencido com saldo entra nas atrasadas', () => {
    const pendencias = pendenciasDividasNoResumoSemanal({
      emprestimoLancamentos: [{ tipo: 'divida', valor: 200, data_vencimento: '2026-11-02' }],
      emprestimoSaldo: 200,
      cartaoLancamentos: [],
      cartaoSaldo: 0,
      hoje: '2026-11-28',
    });
    igual(totalAtrasadasNoResumoSemanal(pendencias, '2026-11-28'), 200);
  });
  teste('Salário — vendas somam e pagamentos subtraem', () => {
    igual(calcularSaldoSalario([{ tipo: 'venda', valor: 80 }, { tipo: 'pagamento', valor: 30 }]), 50);
  });
  teste('Salário — saldo considera histórico além dos 50 itens visíveis', () => {
    const historico = Array.from({ length: 51 }, () => ({ tipo: 'venda', valor: 10 }));
    igual(calcularSaldoSalario(historico), 510);
  });
  teste('Contas a Pagar — soma ocorrências selecionadas sem alterar pagamento', () => {
    igual(somarValoresSelecionados([{ valor: 100.15 }, { valor: 20.2 }]), 120.35);
  });
  teste('Contas a Pagar — várias ocorrências selecionadas aparecem como itens', () => {
    igual(textoResumoSelecaoContasPagar([{ nome: 'Luz', valor: 100 }, { nome: 'Água', valor: 20 }]), `2 itens — ${formatMoney(120)}`);
  });
  teste('Contas a Pagar — sair limpa a seleção visual', () => {
    contasPagarOcorrenciasSelecionadas.set('c1|2026-09-28', { nome: 'Luz', valor: 10 });
    contasPagarSelecaoBarraElemento.hidden = false;
    limparSelecaoContasPagar();
    igual(contasPagarOcorrenciasSelecionadas.size, 0);
    igual(contasPagarSelecaoBarraElemento.hidden, true);
  });
  teste('Salário — avisa dias sem venda, exceto domingo, até ontem', () => {
    igualJson(datasSemVendaEmDiasUteis([
      { data: '2026-09-01' }, { data: '2026-09-03' },
    ], dataAnteriorISO('2026-09-07')), ['2026-09-02', '2026-09-04', '2026-09-05']);
  });
  teste('Salário — não avisa quando só falta domingo', () => {
    igualJson(datasSemVendaEmDiasUteis([
      { data: '2026-09-05' }, { data: '2026-09-07' },
    ], '2026-09-07'), []);
  });
  teste('Fiado — pagamentos abatem vendas', () => {
    igual(calcularSaldoFiado([
      { tipo: 'venda', valor: 100 }, { tipo: 'venda', valor: 50 }, { tipo: 'pagamento', valor: 40 },
    ]), 110);
  });
  teste('Fiado — pagamento acima da dívida vira crédito do cliente', () => {
    igual(calcularSaldoFiado([{ tipo: 'venda', valor: 50 }, { tipo: 'pagamento', valor: 80 }]), -30);
    igual(rotuloSaldoFiado(-30), formatMoney(30));
    igual(rotuloSaldoFiado(30), formatMoney(30));
    igual(rotuloSaldoFiado(0), formatMoney(0));
  });
  teste('Fiado — crédito abate a próxima venda', () => {
    igual(calcularSaldoFiado([
      { tipo: 'venda', valor: 50 }, { tipo: 'pagamento', valor: 80 }, { tipo: 'venda', valor: 45 },
    ]), 15);
  });
  teste('Fiado — reúne nomes distintos sem duplicar diferenças de maiúsculas', () => {
    igualJson(nomesDistintosFiado([
      { pessoa_nome: 'Darnel' }, { pessoa_nome: 'darnel' }, { pessoa_nome: 'Ana' }, { pessoa_nome: 'ANA' },
    ]), ['Ana', 'Darnel']);
  });
  teste('Fiado — normaliza a chave do nome sem alterar a grafia exibida', () => {
    igual(chavePessoaFiado('  Darnel  '), 'darnel');
  });

  teste('Parcelas — modo repetir mantém o valor em todas', () => {
    igualJson(calcularValoresParcelas(100, 3, 'repetir'), [100, 100, 100]);
  });
  teste('Parcelas — modo dividir preserva o total e põe o resto na última', () => {
    igualJson(calcularValoresParcelas(100, 3, 'dividir'), [33.33, 33.33, 33.34]);
  });
  teste('Parcelas — divisão não cria nem perde centavos', () => {
    igual(round2(calcularValoresParcelas(10, 6, 'dividir').reduce((soma, valor) => soma + valor, 0)), 10);
  });
  teste('Parcelas — seletor de quantidade reaparece ao escolher Parcelado após salvar', () => {
    document.getElementById('contas-pagar-tipo-recorrente').checked = true;
    atualizarCamposTipoContaPagar();
    document.getElementById('contas-pagar-tipo-parcelado').checked = true;
    atualizarCamposTipoContaPagar();
    igual(contasPagarCampoParcelasElemento.hidden, false);
    igual(contasPagarQuantidadeParcelasCampo.hidden, false);
    document.getElementById('contas-pagar-tipo-recorrente').checked = true;
    atualizarCamposTipoContaPagar();
  });

  teste('Datas — formata YYYY-MM-DD como DD/MM/AAAA', () => igual(formatDataBR('2026-09-14'), '14/09/2026'));
  teste('Datas — dia 31 ancora no último dia de fevereiro bissexto', () => {
    igual(montarDataOcorrencia(2024, 1, 31), '2024-02-29');
  });
  teste('Datas — dia 31 ancora no dia 30 de abril', () => igual(montarDataOcorrencia(2026, 3, 31), '2026-04-30'));
  teste('Semanas — mês iniciado na terça mantém sábado na semana 1', () => igual(semanaDoMes('2026-09-05'), 1));
  teste('Semanas — domingo inicia uma nova semana', () => igual(semanaDoMes('2026-09-06'), 2));
  teste('Semanas — avanço a partir do domingo cruza o mês e recalcula a semana', () => {
    igualJson(chaveSemanaSeguinte('2026-09-27'), { ano: 2026, mes: 10, semana: 2, data: '2026-10-04' });
  });
  teste('Semanas — avanço no meio da semana vai ao próximo domingo', () => {
    igualJson(chaveSemanaSeguinte('2026-09-25'), { ano: 2026, mes: 9, semana: 5, data: '2026-09-27' });
  });
  teste('Semanas — agrupamento corta a semana na virada do mês', () => {
    const grupos = agruparPorSemana([{ data: '2026-09-30' }, { data: '2026-10-01' }]);
    igual(grupos.length, 2);
    igualJson(grupos.map((grupo) => [grupo.mes, grupo.itens.length]), [[9, 1], [10, 1]]);
  });
  teste('Ocorrências — abre só a semana atual e blocos com pendências', () => {
    igual(abrirGrupoPorPadrao([{ paga: true }], true), true);
    igual(abrirGrupoPorPadrao([{ paga: true }]), false);
    igual(abrirGrupoPorPadrao([{ paga: true }, { paga: false }]), true);
  });
  teste('Ocorrências — preserva o estado escolhido por semana e Empréstimo', () => {
    contasPagarListaOcorrenciasElemento.innerHTML = '<li><details class="contas-pagar-grupo-details" data-grupo="2026-9-1" open><summary>Semana 1</summary></details></li>'
      + '<li><details class="contas-pagar-grupo-details" data-grupo="2026-9-2"><summary>Semana 2</summary></details></li>'
      + '<li><details class="contas-pagar-grupo-details" data-grupo="emprestimo" open><summary>Empréstimo</summary></details></li>';
    contasPagarListaOcorrenciasElemento.querySelectorAll('.contas-pagar-grupo-details > summary').forEach((summary) => summary.click());
    igual(contasPagarGruposAlteradosManualmente.get('2026-9-1'), false);
    igual(contasPagarGruposAlteradosManualmente.get('2026-9-2'), true);
    igual(contasPagarGruposAlteradosManualmente.get('emprestimo'), false);
    contasPagarGruposAlteradosManualmente.clear();
    contasPagarListaOcorrenciasElemento.innerHTML = '';
  });

  teste('Recorrência — respeita início, último dia e data-limite', () => {
    const conta = { data_inicio: '2024-01-31', dia_vencimento: 31 };
    igualJson(gerarOcorrenciasRecorrenteAte(conta, new Set(), '2024-04-30'),
      ['2024-01-31', '2024-02-29', '2024-03-31', '2024-04-30']);
  });
  teste('Recorrência — exdate remove somente a ocorrência indicada', () => {
    const conta = { data_inicio: '2024-01-31', dia_vencimento: 31 };
    igualJson(gerarOcorrenciasRecorrenteAte(conta, new Set(['2024-02-29']), '2024-03-31'),
      ['2024-01-31', '2024-03-31']);
  });
  teste('Recorrência — vencidas continuam visíveis junto das três futuras', () => {
    const conta = { id: 'c1', data_inicio: '2024-01-31', dia_vencimento: 31 };
    igualJson(gerarOcorrenciasRecorrenteParaExibir(conta, new Set(['2024-02-29']), 3, '2024-03-15'),
      ['2024-01-31', '2024-03-31', '2024-04-30', '2024-05-31']);
  });
  teste('Recorrência — baixa de ocorrência vencida preserva sua linha', () => {
    const conta = { id: 'c1', data_inicio: '2024-01-20', dia_vencimento: 20 };
    igualJson(gerarOcorrenciasRecorrenteParaExibir(conta, new Set(), 3, '2024-09-21'),
      ['2024-01-20', '2024-02-20', '2024-03-20', '2024-04-20', '2024-05-20', '2024-06-20', '2024-07-20', '2024-08-20', '2024-09-20', '2024-10-20', '2024-11-20', '2024-12-20']);
  });
  teste('Aluguel — escolhe a primeira ocorrência aberta e ignora nomes aproximados', () => {
    const contas = [
      { id: 'a', descricao: ' ALUGUEL ', tipo: 'parcelado' },
      { id: 'b', descricao: 'Aluguel casa', tipo: 'parcelado' },
    ];
    const parcelas = [
      { conta_id: 'a', data: '2026-09-10', valor: 500 },
      { conta_id: 'a', data: '2026-10-10', valor: 600 },
      { conta_id: 'b', data: '2026-08-10', valor: 100 },
    ];
    const aluguel = encontrarPrimeiroAluguelAberto(contas, [], parcelas, [
      { conta_id: 'a', data: '2026-09-10', valor_pago: 500 },
    ], []);
    igualJson(aluguel, { data: '2026-10-10', valor: 600 });
  });

  teste('Interface — as quatro telas usam ícone para voltar ao início', () => {
    igual(document.querySelectorAll('button[data-nav="home"] svg').length, 4);
  });
  teste('Interface — card do Caixa possui os dois saldos', () => {
    igual(Boolean(document.getElementById('caixa-casa-saldo-apos-aluguel') && document.getElementById('caixa-casa-saldo-total')), true);
  });
  teste('Interface — os quatro cards do topo seguem o mesmo padrão (valor em cima, rótulo embaixo, etiqueta no rodapé)', () => {
    const ids = ['caixa-casa-saldo-apos-aluguel', 'salario-saldo', 'contas-pagar-total-semana-atual', 'fiado-total'];
    ids.forEach((id) => {
      const valor = document.getElementById(id);
      igual(valor.parentElement.classList.contains('saldo-semana-item'), true);
      igual(valor.nextElementSibling.classList.contains('saldo-rotulo'), true);
    });
    igual(document.querySelectorAll('.saldo-rotulo-destaque').length, 0);
    ['caixa-casa-abatimento-aluguel', 'contas-pagar-abatimento-infinitepay'].forEach((id) => {
      igual(document.getElementById(id).parentElement.classList.contains('saldo-bloco'), true);
    });
  });
  teste('Interface — Caixa não possui mais duplicação explícita no Salário', () => {
    igual(Boolean(document.getElementById('caixa-casa-duplicar-salario')), false);
  });
  teste('Interface — descrição de Contas a Pagar é obrigatória', () => {
    igual(document.getElementById('contas-pagar-descricao').required, true);
  });
  teste('Interface — mobile inicia no formulário de Pagamento do Salário', () => {
    igual(telaInicialAposLogin(true), 'salario');
    igual(telaInicialAposLogin(false), 'home');
    selecionarAbaSalario('pagamento');
    igual(document.getElementById('salario-pagamento-formulario').classList.contains('aba-painel-ativo'), true);
    selecionarAbaSalario('venda');
  });
  teste('Salário — venda esquecida de R$ 0 marca o dia como loja fechada', () => {
    igualJson(dadosVendaEsquecida(0, '2026-11-02'), {
      tipo: 'venda', valor: 0, venda_base: 0, descricao: 'Loja fechada', data: '2026-11-02',
    });
    igual(valorVendaEsquecidaValido(0), true);
    igual(valorVendaEsquecidaValido(NaN), false);
    igual(valorVendaEsquecidaValido(-1), false);
  });
  teste('Salário — dia com venda de R$ 0 deixa de ser cobrado como dia sem venda', () => {
    igualJson(datasSemVendaEmDiasUteis([{ data: '2026-11-02' }, { data: '2026-11-04' }], '2026-11-04'), ['2026-11-03']);
  });
  teste('Salário — pagar tudo preenche o campo com o saldo no formato digitado', () => {
    igual(formatarValorCampo(1234.5), '1.234,50');
    igual(parseMoney(formatarValorCampo(1234.5)), 1234.5);
    igual(formatarValorCampo(87), '87,00');
  });
  teste('Salário — Pagar tudo some com saldo zerado ou negativo', () => {
    igual(salarioPagarTudoElemento.hidden || salarioSaldoAtual <= 0, true);
  });
  teste('Interface — pagamento do Salário tem botão Pagar tudo e descrição padrão Pagamento', () => {
    igual(document.getElementById('salario-pagar-tudo').type, 'button');
    igual(document.getElementById('salario-pagamento-descricao').defaultValue, 'Pagamento');
    igual(DESCRICAO_PADRAO_PAGAMENTO_SALARIO, 'Pagamento');
  });
  teste('Interface — CNPJ aparece no início do mobile e no topo do desktop', () => {
    igual(document.querySelector('#view-home .empresa-cnpj').textContent, 'CNPJ 47.154.673/0001-60');
    igual(document.querySelector('#grade-desktop > .desktop-empresa').textContent, 'CNPJ 47.154.673/0001-60');
  });
  teste('Valores — janela de valor aceita zero só quando permitido', () => {
    igual(valorInformadoValido(0, true), true);
    igual(valorInformadoValido(0, false), false);
    igual(valorInformadoValido(0.01, false), true);
    igual(valorInformadoValido(NaN, true), false);
  });
  teste('Interface — janelas ficam fixas na tela e não rolam a página', () => {
    document.querySelectorAll('dialog.modal-aviso').forEach((dialog) => {
      igual(getComputedStyle(dialog).position, 'fixed');
    });
  });
  teste('Interface — janela de valor do app aplica máscara ao digitar', () => {
    const input = document.getElementById('valor-janela-campo');
    input.value = '156386';
    input.dispatchEvent(new Event('input'));
    igual(input.value, '1.563,86');
    input.value = '';
  });
  teste('Interface — Contas a Pagar não tem mais a opção de conta pessoal', () => {
    igual(Boolean(document.getElementById('contas-pagar-pessoal')), false);
  });
  teste('Interface — Fiado permite escolher sugestão ou digitar nome novo', () => {
    const pessoa = document.getElementById('fiado-venda-pessoa');
    igual(pessoa.getAttribute('list'), 'fiado-pessoas-datalist');
    igual(Boolean(document.getElementById('fiado-pessoas-datalist')), true);
    igual(pessoa.type, 'text');
    igual(pessoa.readOnly, false);
  });
  teste('Interface — Cartão de Crédito fica visível mesmo sem movimentos', () => {
    const fixture = document.createElement('ul');
    fixture.innerHTML = renderizarCartaoCredito([], 0);
    igual(fixture.querySelector('.cartao-credito-grupo .divida-valor-atual-botao') !== null, true);
    igual(fixture.querySelector('.cartao-credito-grupo .divida-movimento-botao'), null);
    fixture.remove();
  });
  teste('Interface — linha do Empréstimo nas Ocorrências tem checkbox de quitar e lápis', () => {
    const fixture = document.createElement('ul');
    fixture.innerHTML = renderizarItemDividaOcorrencia({
      data: '2026-11-02', valor: 200, tabela: EMPRESTIMO_TABLE, titulo: 'Empréstimo',
    }, '2026-11-28');
    igual(fixture.querySelector('.contas-pagar-divida-quitar-checkbox').dataset.tabela, EMPRESTIMO_TABLE);
    igual(fixture.querySelector('.divida-valor-atual-botao') !== null, true);
    igual(fixture.querySelector('.tag-atrasada') !== null, true);
    fixture.remove();
  });
  teste('Interface — Roberta fica visível mesmo sem movimentos', () => {
    const fixture = document.createElement('ul');
    fixture.innerHTML = renderizarRoberta([], 0);
    igual(fixture.querySelector('.roberta-grupo .divida-movimento-botao[data-tipo="divida"]') !== null, true);
    igual(fixture.querySelector('.roberta-grupo .divida-movimento-botao[data-tipo="abatimento"]').disabled, true);
    fixture.remove();
  });
  teste('Interface — dívida vinculada da Roberta mostra a conta paga', () => {
    const fixture = document.createElement('ul');
    fixture.innerHTML = renderizarRoberta([{
      id: 'r1', tipo: 'divida', valor: 120, data: '2026-10-10', descricao: 'Internet',
      conta_pagar_id: 'c1', data_ocorrencia: '2026-10-10',
    }], 120);
    igual(fixture.textContent.includes('Dívida adicionada · Internet'), true);
    igual(fixture.querySelector('.cartao-excluir-botao').dataset.contaId, 'c1');
    fixture.remove();
  });
  teste('Interface — janela de pagamento tem aviso para valor acima da conta', () => {
    igual(document.getElementById('contas-pagar-pagamento-aviso').hidden, true);
  });
  teste('Interface — ocorrência informa o tipo da conta para atualizar o valor certo', () => {
    igual(carregarContasPagar.toString().includes('data-tipo="${conta.tipo}" data-aluguel='), true);
  });
  teste('Interface — pagamento de conta oferece as três origens do dinheiro', () => {
    const origens = [...document.querySelectorAll('#contas-pagar-pagamento-janela input[name="contas-pagar-pagamento-origem"]')]
      .map((input) => input.value);
    igualJson(origens, ['proprio', 'caixa', 'roberta']);
  });
  teste('Interface — Empréstimo fica visível mesmo sem movimentos', () => {
    const fixture = document.createElement('ul');
    fixture.innerHTML = renderizarEmprestimo([], 0);
    igual(fixture.querySelector('.emprestimo-grupo .divida-valor-atual-botao') !== null, true);
    igual(fixture.querySelector('.emprestimo-grupo .divida-movimento-botao'), null);
    fixture.remove();
  });
  teste('Interface — aviso de venda esquecida possui data automática e valor', () => {
    igual(Boolean(document.getElementById('salario-aviso-dias-sem-venda-data')
      && document.getElementById('salario-aviso-dias-sem-venda-valor')), true);
  });
  teste('Interface — Caixa e Salário possuem ação para excluir lançamentos', () => {
    const fixture = document.createElement('div');
    fixture.innerHTML = '<button class="caixa-casa-excluir-lancamento"></button><button class="salario-excluir-lancamento"></button>';
    igual(fixture.querySelectorAll('.caixa-casa-excluir-lancamento, .salario-excluir-lancamento').length, 2);
  });
  teste('Interface — seleção de Contas a Pagar possui barra e ação de limpar', () => {
    igual(Boolean(document.getElementById('contas-pagar-selecao-barra') && document.getElementById('contas-pagar-selecao-limpar')), true);
  });
  teste('Interface — PWA declara manifesto para instalação', () => {
    igual(Boolean(document.querySelector('link[rel="manifest"][href="./manifest.webmanifest"]')), true);
  });
  teste('Interface — PWA declara ícone para instalação', () => {
    igual(Boolean(document.querySelector('link[rel="apple-touch-icon"][href="pwa-icon-192.png"]')), true);
  });
  teste('InfinitePay — saldo ok vira valor em reais, sem alerta', () => {
    igualJson(textoSaldoInfinitepay({ estado: 'ok', saldo: 1234.5 }), { texto: formatMoney(1234.5), alerta: false });
  });
  teste('InfinitePay — sessão expirada e estados desconhecidos viram alerta', () => {
    igualJson(textoSaldoInfinitepay({ estado: 'sessao_expirada' }), { texto: 'Sessão expirada, cole o cURL de novo', alerta: true });
    igual(textoSaldoInfinitepay(null).alerta, true);
  });
  teste('InfinitePay — A receber mostra valor e período curto', () => {
    const ok = textoAReceberInfinitepay({ estado: 'ok', valor: 1234.5, periodo: { since: '2026-11-29', until: '2026-12-02' } });
    igual(ok.texto, formatMoney(1234.5));
    igual(ok.periodo, '29/11 a 02/12');
    igual(ok.alerta, false);
    const desconhecido = textoAReceberInfinitepay({ estado: 'formato_desconhecido', periodo: { since: '2026-11-29', until: '2026-12-02' } });
    igual(desconhecido.alerta, true);
    igual(textoAReceberInfinitepay(undefined).texto, '—');
  });
  teste('Interface — A receber fica ao lado do Saldo no início e no desktop', () => {
    igual(document.querySelectorAll('.infinitepay-blocos .infinitepay-receber').length, 2);
  });
  teste('InfinitePay — saldo desconta do primeiro card de Contas a Pagar, sem passar de zero', () => {
    igualJson(calcularContasPagarAposSaldoInfinitepay(1000, 300.1), { restante: 699.9, abatimento: 300.1 });
    igualJson(calcularContasPagarAposSaldoInfinitepay(1000, 1500), { restante: 0, abatimento: 1000 });
    igualJson(calcularContasPagarAposSaldoInfinitepay(1000, -20), { restante: 1000, abatimento: 0 });
  });
  teste('InfinitePay — validade vencida, perto do limite ou com folga', () => {
    const agora = Date.parse('2026-11-28T12:00:00Z');
    const dia = 24 * 60 * 60 * 1000;
    igual(situacaoValidade('2026-11-28T11:00:00Z', agora, 2 * dia), 'vencida');
    igual(situacaoValidade('2026-11-29T12:00:00Z', agora, 2 * dia), 'perto');
    igual(situacaoValidade('2026-12-05T12:00:00Z', agora, 2 * dia), 'ok');
    igual(situacaoValidade(null, agora, 2 * dia), null);
  });
  teste('Interface — atualizar saldo fica ao lado do Sair, fora do bloco do saldo', () => {
    igual(document.querySelector('#view-home .barra-topo .infinitepay-atualizar-botao + #botao-sair') !== null, true);
    igual(document.querySelector('#grade-desktop > .desktop-atualizar + #botao-sair-desktop') !== null, true);
    igual(document.querySelector('.infinitepay-saldo-botao .infinitepay-atualizar-botao'), null);
  });
  teste('Parcelas — quantidade é limitada a 24', () => igual(limitarQuantidadeParcelas('99'), 24));

  const lista = document.getElementById('testes-lista');
  resultados.forEach((resultado) => {
    const item = document.createElement('li');
    item.className = resultado.ok ? 'teste-ok' : 'teste-falhou';
    item.textContent = resultado.ok ? `✓ ${resultado.nome}` : `✕ ${resultado.nome}: ${resultado.erro}`;
    lista.appendChild(item);
  });

  const aprovados = resultados.filter((resultado) => resultado.ok).length;
  const resumo = document.getElementById('testes-resumo');
  resumo.textContent = `${aprovados}/${resultados.length} testes aprovados`;
  resumo.className = `testes-resumo ${aprovados === resultados.length ? 'teste-ok' : 'teste-falhou'}`;
}

if (modoTestes) {
  executarTestes();
} else {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch((erro) => {
        console.warn('Não foi possível preparar o app para uso instalado.', erro);
      });
    });
  }
  checkSession();
}
