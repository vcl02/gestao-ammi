import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ===================== CONFIG =====================

const SUPABASE_URL = 'https://odjryakghivbwyftfjar.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_SHyvOxJ8tz2BMFDJ1nZL0w_hUQbIGUc';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CC_TABLE = 'caixa_casa_lancamentos';
const SAL_TABLE = 'salario_lancamentos';
const CP_TABLE = 'contas_pagar';
const CP_EXDATES_TABLE = 'contas_pagar_exdates';
const CP_PARCELAS_TABLE = 'contas_pagar_parcelas';
const CP_PAGAMENTOS_TABLE = 'contas_pagar_pagamentos';
const CP_AJUSTES_TABLE = 'contas_pagar_ajustes';
const EMPRESTIMO_APORTES_TABLE = 'emprestimo_aportes';
const FI_PESSOAS_TABLE = 'fiado_pessoas';
const FI_VENDAS_TABLE = 'fiado_vendas';
const FI_PAGAMENTOS_TABLE = 'fiado_pagamentos';
const PERCENTUAL_COMISSAO = 0.25;

// ===================== HELPERS: dinheiro / data =====================

// Converte texto tipo "1.234,56" ou "1234,56" ou "1234.56" em número.
function parseMoney(text) {
  if (typeof text !== 'string') return NaN;
  const cleaned = text.trim().replace(/\./g, '').replace(',', '.');
  return parseFloat(cleaned);
}

// Desabilita o botão de submit do form enquanto o handler roda, evitando
// clique duplo/duplo envio. Reabilita mesmo se o handler lançar erro.
function bloquearDuranteSubmit(form, handler) {
  form.addEventListener('submit', async (e) => {
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      await handler(e);
    } finally {
      btn.disabled = false;
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

function calcularComissao(valorVenda) {
  return round2(valorVenda * PERCENTUAL_COMISSAO);
}

function calcularSaldoSalario(lancamentos) {
  return round2(lancamentos.reduce((acc, item) => {
    return acc + (item.tipo === 'venda' ? Number(item.valor) : -Number(item.valor));
  }, 0));
}

function somarValoresSelecionados(itens) {
  return round2(itens.reduce((total, item) => total + Number(item.valor), 0));
}

// Retorna os dias não-domingo sem venda entre a primeira venda e a data-limite.
// A verificação é apenas informativa: não cria nem modifica lançamentos.
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

function calcularSaldoFiado(vendas, pagamentos) {
  const totalVendas = vendas.reduce((acc, item) => acc + Number(item.valor), 0);
  const totalPagamentos = pagamentos.reduce((acc, item) => acc + Number(item.valor), 0);
  return round2(totalVendas - totalPagamentos);
}

function podeRegistrarPagamentoFiado(valor, saldo) {
  return valor > 0 && valor <= saldo;
}

function podeRemoverVendaFiado(vendas, pagamentos, vendaRemovida) {
  const vendasRestantes = vendas.filter((venda) => venda.id !== vendaRemovida.id);
  return calcularSaldoFiado(vendasRestantes, pagamentos) >= 0;
}

function calcularSaldoAposAluguel(saldoCaixa, valorAluguel) {
  return Math.max(round2(saldoCaixa - (valorAluguel || 0)), 0);
}

function calcularAbatimentoAluguel(saldoCaixa, valorAluguel) {
  return Math.min(Math.max(round2(saldoCaixa), 0), Number(valorAluguel));
}

function ehEmprestimo(conta) {
  return conta.descricao.trim().toLocaleLowerCase('pt-BR') === 'empréstimo';
}

function calcularSaldoEmprestimo(valorOriginal, totalAportes) {
  return Math.max(round2(Number(valorOriginal) - Number(totalAportes)), 0);
}

function limitarAporteEmprestimo(valorAporte, valorRestante) {
  return Math.min(round2(Number(valorAporte)), Number(valorRestante));
}

function dadosAporteManual(contaId, dataOcorrencia, valor, data) {
  return {
    conta_id: contaId,
    data_ocorrencia: dataOcorrencia,
    valor,
    origem: 'manual',
    data,
  };
}

function somarAportesPorOcorrencia(aportes) {
  return aportes.reduce((totais, aporte) => {
    const chave = `${aporte.conta_id}|${aporte.data_ocorrencia}`;
    totais.set(chave, round2((totais.get(chave) || 0) + Number(aporte.valor)));
    return totais;
  }, new Map());
}

function valorExibidoOcorrencia(ocorrencia) {
  return round2(ocorrencia.valor - (ocorrencia.abatimentoCaixa || 0));
}

// Data de hoje (YYYY-MM-DD) no fuso America/Sao_Paulo.
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
// (ex: só 1-3 dias), e ainda assim aparece como bloco próprio.
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

const desktopGridEl = document.getElementById('desktop-grid');

function showView(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.hidden = key !== name;
  });

  const logado = name !== 'login' && name !== 'testes';
  desktopGridEl.hidden = !logado;

  if (name === 'caixa-casa' || name === 'home') carregarCaixaCasa();
  if (name === 'salario' || name === 'home') carregarSalario();
  if (name === 'contas-pagar' || name === 'home') carregarContasPagar();
  if (name === 'fiado' || name === 'home') carregarFiado();
}

document.querySelectorAll('[data-nav]').forEach((el) => {
  el.addEventListener('click', () => showView(el.dataset.nav));
});

document.getElementById('logout-btn-desktop').addEventListener('click', async () => {
  await supabase.auth.signOut();
  showView('login');
});

// ===================== AUTENTICAÇÃO =====================

async function checkSession() {
  const { data: { session } } = await supabase.auth.getSession();
  showView(session ? 'home' : 'login');
}

supabase.auth.onAuthStateChange((_event, session) => {
  if (!session) showView('login');
});

const loginForm = document.getElementById('login-form');
const loginErrorEl = document.getElementById('login-error');

bloquearDuranteSubmit(loginForm, async (e) => {
  e.preventDefault();
  loginErrorEl.hidden = true;

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    loginErrorEl.textContent = 'E-mail ou senha inválidos.';
    loginErrorEl.hidden = false;
    return;
  }

  loginForm.reset();
  showView('home');
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await supabase.auth.signOut();
  showView('login');
});

// ===================== CAIXA CASA =====================

const ccSaldoEl = document.getElementById('cc-saldo');
const ccSaldoTotalEl = document.getElementById('cc-saldo-total');
const ccListEl = document.getElementById('cc-list');
const ccForm = document.getElementById('cc-form');
const ccErrorEl = document.getElementById('cc-form-error');
const ccDescricaoInput = document.getElementById('cc-descricao');
const ccDescricaoReq = document.getElementById('cc-descricao-req');
const ccDataInput = document.getElementById('cc-data');
aplicarMascaraMoney(document.getElementById('cc-valor'));

const CC_DESCRICAO_PADRAO = {
  entrada: 'Suprimento',
  saida: 'Aluguel',
};

function updateCcDescricaoRequirement() {
  const tipo = document.querySelector('input[name="cc-tipo"]:checked').value;
  const obrigatorio = tipo === 'saida';
  ccDescricaoInput.required = obrigatorio;
  ccDescricaoReq.hidden = !obrigatorio;
}

document.querySelectorAll('input[name="cc-tipo"]').forEach((el) => {
  el.addEventListener('change', () => {
    updateCcDescricaoRequirement();
    ccDescricaoInput.value = CC_DESCRICAO_PADRAO[el.value];
  });
});

async function carregarCaixaCasa() {
  ccDataInput.value = ccDataInput.value || hojeISO();
  if (!ccDescricaoInput.value) {
    const tipo = document.querySelector('input[name="cc-tipo"]:checked').value;
    ccDescricaoInput.value = CC_DESCRICAO_PADRAO[tipo];
  }
  updateCcDescricaoRequirement();

  const [
    { data, error },
    { data: contas, error: errContas },
    { data: exdatesRows, error: errEx },
    { data: parcelasRows, error: errParc },
    { data: pagos, error: errPag },
    { data: ajustesRows, error: errAjustes },
  ] = await Promise.all([
    supabase.from(CC_TABLE)
      .select('*')
      .order('data', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from(CP_TABLE).select('*').order('data_inicio', { ascending: true }),
    supabase.from(CP_EXDATES_TABLE).select('*'),
    supabase.from(CP_PARCELAS_TABLE).select('*'),
    supabase.from(CP_PAGAMENTOS_TABLE).select('*'),
    supabase.from(CP_AJUSTES_TABLE).select('*'),
  ]);

  if (error || errContas || errEx || errParc || errPag || errAjustes) {
    ccListEl.innerHTML = `<li class="empty-state">Erro ao carregar lançamentos.</li>`;
    return;
  }

  const saldo = calcularSaldoCaixa(data);
  const aluguelAberto = encontrarPrimeiroAluguelAberto(contas, exdatesRows, parcelasRows, pagos, ajustesRows);
  const saldoAposAluguel = calcularSaldoAposAluguel(saldo, aluguelAberto?.valor);
  ccSaldoEl.textContent = formatMoney(saldoAposAluguel);
  ccSaldoTotalEl.textContent = formatMoney(saldo);
  ccSaldoTotalEl.classList.toggle('negative', saldo < 0);

  if (data.length === 0) {
    ccListEl.innerHTML = `<li class="empty-state">Nenhum lançamento ainda.</li>`;
    return;
  }

  ccListEl.innerHTML = data.map((l) => {
    const positivo = l.tipo === 'entrada';
    const sinal = positivo ? '+' : '-';
    return `
      <li class="lancamento-item">
        <div class="lancamento-info">
          <span class="lancamento-desc">${l.descricao || (positivo ? 'Entrada' : 'Saída')}</span>
          <span class="lancamento-data">${formatDataBR(l.data)}</span>
        </div>
        <span class="lancamento-valor ${positivo ? 'positivo' : 'negativo'}">${sinal} ${formatMoney(l.valor)}</span>
      </li>
    `;
  }).join('');
}

bloquearDuranteSubmit(ccForm, async (e) => {
  e.preventDefault();
  ccErrorEl.hidden = true;

  const tipo = document.querySelector('input[name="cc-tipo"]:checked').value;
  const valor = parseMoney(document.getElementById('cc-valor').value);
  const data = ccDataInput.value;
  const descricao = ccDescricaoInput.value.trim();

  if (!valor || valor <= 0) {
    ccErrorEl.textContent = 'Informe um valor válido.';
    ccErrorEl.hidden = false;
    return;
  }

  if (tipo === 'saida' && !descricao) {
    ccErrorEl.textContent = 'Descrição é obrigatória para saídas.';
    ccErrorEl.hidden = false;
    return;
  }

  const { error } = await supabase.from(CC_TABLE).insert({
    tipo,
    valor,
    data,
    descricao: descricao || null,
  });

  if (error) {
    ccErrorEl.textContent = 'Erro ao salvar. Tente novamente.';
    ccErrorEl.hidden = false;
    return;
  }

  ccForm.reset();
  ccDataInput.value = hojeISO();
  ccDescricaoInput.value = CC_DESCRICAO_PADRAO[tipo];
  updateCcDescricaoRequirement();
  await carregarCaixaCasa();
  await carregarContasPagar();
});

// ===================== SALÁRIO =====================

const salSaldoEl = document.getElementById('sal-saldo');
const salListEl = document.getElementById('sal-list');
const salAvisoDiasSemVendaEl = document.getElementById('sal-aviso-dias-sem-venda');
const salAvisoDiasSemVendaTextoEl = document.getElementById('sal-aviso-dias-sem-venda-texto');
const salAvisoDiasSemVendaFecharEl = document.getElementById('sal-aviso-dias-sem-venda-fechar');
let avisoDiasSemVendaExibido = false;

const salVendaForm = document.getElementById('sal-venda-form');
const salVendaValorInput = document.getElementById('sal-venda-valor');
const salVendaDataInput = document.getElementById('sal-venda-data');
const salVendaDescricaoInput = document.getElementById('sal-venda-descricao');
const salVendaErrorEl = document.getElementById('sal-venda-error');
const salVendaSubmitEl = document.getElementById('sal-venda-submit');
aplicarMascaraMoney(salVendaValorInput);

const salPagamentoForm = document.getElementById('sal-pagamento-form');
const salPagamentoValorInput = document.getElementById('sal-pagamento-valor');
const salPagamentoDataInput = document.getElementById('sal-pagamento-data');
const salPagamentoDescricaoInput = document.getElementById('sal-pagamento-descricao');
const salPagamentoErrorEl = document.getElementById('sal-pagamento-error');
aplicarMascaraMoney(salPagamentoValorInput);

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    btn.closest('.panel').querySelectorAll('.tab-panel').forEach((panel) => {
      panel.classList.toggle('tab-panel-active', panel.dataset.panel === tab);
    });
  });
});

function updateSalVendaSubmitLabel() {
  const valor = parseMoney(salVendaValorInput.value);
  if (!valor || valor <= 0) {
    salVendaSubmitEl.textContent = 'Salvar';
    return;
  }
  const comissao = calcularComissao(valor);
  salVendaSubmitEl.textContent = `Salvar — ${formatMoney(comissao)}`;
}

salVendaValorInput.addEventListener('input', updateSalVendaSubmitLabel);

function mostrarAvisoDiasSemVenda(vendas) {
  if (avisoDiasSemVendaExibido) return;
  const faltantes = datasSemVendaEmDiasUteis(vendas, dataAnteriorISO(hojeISO()));
  if (faltantes.length === 0) return;

  avisoDiasSemVendaExibido = true;
  salAvisoDiasSemVendaTextoEl.textContent = `Faltam vendas em ${faltantes.length} dia(s): ${faltantes.map(formatDataBR).join(', ')}. Ajuste os registros diretamente no banco.`;
  salAvisoDiasSemVendaEl.showModal();
}

salAvisoDiasSemVendaFecharEl.addEventListener('click', () => salAvisoDiasSemVendaEl.close());

async function carregarSalario() {
  salVendaDataInput.value = salVendaDataInput.value || hojeISO();
  salPagamentoDataInput.value = salPagamentoDataInput.value || hojeISO();

  const { data, error } = await supabase
    .from(SAL_TABLE)
    .select('*')
    .order('data', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    salListEl.innerHTML = `<li class="empty-state">Erro ao carregar lançamentos.</li>`;
    return;
  }

  const saldo = calcularSaldoSalario(data);
  salSaldoEl.textContent = formatMoney(saldo);
  salSaldoEl.classList.toggle('negative', saldo < 0);

  const { data: vendasHistoricas, error: erroVendasHistoricas } = await supabase
    .from(SAL_TABLE)
    .select('data')
    .eq('tipo', 'venda')
    .order('data', { ascending: true });

  if (!erroVendasHistoricas) mostrarAvisoDiasSemVenda(vendasHistoricas);

  if (data.length === 0) {
    salListEl.innerHTML = `<li class="empty-state">Nenhum lançamento ainda.</li>`;
    return;
  }

  salListEl.innerHTML = data.map((l) => {
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
      </li>
    `;
  }).join('');
}

bloquearDuranteSubmit(salVendaForm, async (e) => {
  e.preventDefault();
  salVendaErrorEl.hidden = true;

  const vendaBase = parseMoney(salVendaValorInput.value);
  const data = salVendaDataInput.value;
  const descricao = salVendaDescricaoInput.value.trim();

  if (!vendaBase || vendaBase <= 0) {
    salVendaErrorEl.textContent = 'Informe um valor de venda válido.';
    salVendaErrorEl.hidden = false;
    return;
  }

  const comissao = calcularComissao(vendaBase);

  const { error } = await supabase.from(SAL_TABLE).insert({
    tipo: 'venda',
    valor: comissao,
    venda_base: vendaBase,
    descricao: descricao || null,
    data,
  });

  if (error) {
    salVendaErrorEl.textContent = 'Erro ao salvar. Tente novamente.';
    salVendaErrorEl.hidden = false;
    return;
  }

  salVendaForm.reset();
  salVendaDataInput.value = hojeISO();
  updateSalVendaSubmitLabel();
  await carregarSalario();
});

bloquearDuranteSubmit(salPagamentoForm, async (e) => {
  e.preventDefault();
  salPagamentoErrorEl.hidden = true;

  const valor = parseMoney(salPagamentoValorInput.value);
  const data = salPagamentoDataInput.value;
  const descricao = salPagamentoDescricaoInput.value.trim() || 'Saque';

  if (!valor || valor <= 0) {
    salPagamentoErrorEl.textContent = 'Informe um valor válido.';
    salPagamentoErrorEl.hidden = false;
    return;
  }

  const { error } = await supabase.from(SAL_TABLE).insert({
    tipo: 'pagamento',
    valor,
    data,
    descricao,
  });

  if (error) {
    salPagamentoErrorEl.textContent = 'Erro ao salvar. Tente novamente.';
    salPagamentoErrorEl.hidden = false;
    return;
  }

  salPagamentoForm.reset();
  salPagamentoDataInput.value = hojeISO();
  salPagamentoDescricaoInput.value = 'Saque';
  await carregarSalario();
});

// ===================== CONTAS A PAGAR =====================

const cpTotalMesPagoEl = document.getElementById('cp-total-mes-pago');
const cpTotalMesGeralEl = document.getElementById('cp-total-mes-geral');
const cpTotalSemanaAtualEl = document.getElementById('cp-total-semana-atual');
const cpTotalProximaSemanaEl = document.getElementById('cp-total-proxima-semana');
const cpLabelSemanaAtualEl = document.getElementById('cp-label-semana-atual');
const cpLabelProximaSemanaEl = document.getElementById('cp-label-proxima-semana');
const cpListEl = document.getElementById('cp-list');
const cpContasListEl = document.getElementById('cp-contas-list');
const cpSelecaoBarEl = document.getElementById('cp-selecao-bar');
const cpSelecaoResumoEl = document.getElementById('cp-selecao-resumo');
const cpSelecaoLimparEl = document.getElementById('cp-selecao-limpar');
const cpGruposAlteradosManualmente = new Map();
const cpOcorrenciasSelecionadas = new Map();

function atualizarBarraSelecaoContasPagar() {
  const selecionadas = [...cpOcorrenciasSelecionadas.values()];
  cpSelecaoBarEl.hidden = selecionadas.length === 0;
  if (selecionadas.length === 0) return;

  const total = somarValoresSelecionados(selecionadas);
  cpSelecaoResumoEl.textContent = selecionadas.length === 1
    ? `Selecionada: ${selecionadas[0].nome} — ${formatMoney(total)}`
    : `${selecionadas.length} selecionadas — ${formatMoney(total)}`;
  cpSelecaoLimparEl.hidden = selecionadas.length < 2;
}

function abrirGrupoPorPadrao(itens, ehSemanaAtual = false) {
  return ehSemanaAtual || itens.some((item) => !item.paga);
}

cpListEl.addEventListener('click', (e) => {
  const selecionarBtn = e.target.closest('.cp-selecionar-btn');
  if (selecionarBtn) {
    const chave = `${selecionarBtn.dataset.contaId}|${selecionarBtn.dataset.data}`;
    if (cpOcorrenciasSelecionadas.has(chave)) {
      cpOcorrenciasSelecionadas.delete(chave);
    } else {
      cpOcorrenciasSelecionadas.set(chave, {
        nome: selecionarBtn.dataset.nome,
        valor: Number(selecionarBtn.dataset.valor),
      });
    }
    selecionarBtn.closest('.lancamento-item').classList.toggle('cp-ocorrencia-selecionada', cpOcorrenciasSelecionadas.has(chave));
    atualizarBarraSelecaoContasPagar();
    return;
  }

  const summary = e.target.closest('summary');
  const details = summary?.parentElement;
  if (!details?.classList.contains('cp-grupo-details')) return;
  cpGruposAlteradosManualmente.set(details.dataset.grupo, !details.open);
});

cpSelecaoLimparEl.addEventListener('click', () => {
  cpOcorrenciasSelecionadas.clear();
  cpListEl.querySelectorAll('.cp-ocorrencia-selecionada').forEach((item) => item.classList.remove('cp-ocorrencia-selecionada'));
  atualizarBarraSelecaoContasPagar();
});

const cpForm = document.getElementById('cp-form');
const cpErrorEl = document.getElementById('cp-form-error');
const cpDescricaoInput = document.getElementById('cp-descricao');
const cpValorInput = document.getElementById('cp-valor');
const cpDataInicioInput = document.getElementById('cp-data-inicio');
const cpCampoDataUnicaEl = document.getElementById('cp-campo-data-unica');
const cpCampoParcelasEl = document.getElementById('cp-campo-parcelas');
const cpQtdeParcelasInput = document.getElementById('cp-qtde-parcelas');
const cpDatasParcelasEl = document.getElementById('cp-datas-parcelas');
const cpValorModoEl = document.getElementById('cp-valor-modo');
aplicarMascaraMoney(cpValorInput);

document.querySelectorAll('input[name="cp-tipo"]').forEach((el) => {
  el.addEventListener('change', () => {
    const parcelado = el.value === 'parcelado';
    cpCampoDataUnicaEl.hidden = parcelado;
    cpCampoParcelasEl.hidden = !parcelado;
    cpDataInicioInput.required = !parcelado;
    cpValorModoEl.hidden = !parcelado;
  });
});

cpQtdeParcelasInput.addEventListener('input', () => {
  cpQtdeParcelasInput.value = cpQtdeParcelasInput.value.replace(/\D/g, '');
  const qtde = limitarQuantidadeParcelas(cpQtdeParcelasInput.value);

  const existentes = cpDatasParcelasEl.querySelectorAll('input[type="date"]');
  if (qtde < existentes.length) {
    existentes.forEach((el, i) => { if (i >= qtde) el.closest('.campo-parcela').remove(); });
    return;
  }

  for (let i = existentes.length; i < qtde; i++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'campo-parcela';
    wrapper.innerHTML = `
      <label>Data da parcela ${i + 1}</label>
      <input type="date" class="cp-data-parcela" required>
    `;
    cpDatasParcelasEl.appendChild(wrapper);
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
  const pagosSet = new Set(pagos.map((pagamento) => `${pagamento.conta_id}|${pagamento.data}`));
  const ajustesMap = new Map(ajustesRows.map((ajuste) => [`${ajuste.conta_id}|${ajuste.data}`, Number(ajuste.valor)]));
  const alugueisAbertos = [];

  contas.filter((conta) => conta.descricao.trim().toLocaleLowerCase('pt-BR') === 'aluguel').forEach((conta) => {
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

    ocorrencias.filter(({ data }) => !pagosSet.has(`${conta.id}|${data}`)).forEach((ocorrencia) => {
      alugueisAbertos.push(ocorrencia);
    });
  });

  alugueisAbertos.sort((a, b) => a.data.localeCompare(b.data));
  return alugueisAbertos[0] || null;
}

async function carregarContasPagar() {
  cpDataInicioInput.value = cpDataInicioInput.value || hojeISO();

  const [
    { data: contas, error: errContas },
    { data: exdatesRows, error: errEx },
    { data: parcelasRows, error: errParc },
    { data: pagos, error: errPag },
    { data: ajustesRows, error: errAjustes },
    { data: caixaRows, error: errCaixa },
    { data: aportesRows, error: errAportes },
  ] = await Promise.all([
    supabase.from(CP_TABLE).select('*').order('data_inicio', { ascending: true }),
    supabase.from(CP_EXDATES_TABLE).select('*'),
    supabase.from(CP_PARCELAS_TABLE).select('*'),
    supabase.from(CP_PAGAMENTOS_TABLE).select('*'),
    supabase.from(CP_AJUSTES_TABLE).select('*'),
    supabase.from(CC_TABLE)
      .select('tipo, valor')
      .order('data', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(50),
    supabase.from(EMPRESTIMO_APORTES_TABLE).select('*').order('data', { ascending: false }),
  ]);

  if (errContas || errEx || errParc || errPag || errAjustes || errCaixa || errAportes) {
    cpListEl.innerHTML = `<li class="empty-state">${errAportes ? 'Aplique a migration 006 para habilitar os aportes.' : 'Erro ao carregar contas a pagar.'}</li>`;
    cpContasListEl.innerHTML = '';
    return;
  }

  const ajustesMap = new Map(ajustesRows.map((a) => [`${a.conta_id}|${a.data}`, Number(a.valor)]));

  const pagosSet = new Set(pagos.map((p) => `${p.conta_id}|${p.data}`));
  const aportesMap = somarAportesPorOcorrencia(aportesRows);
  const saldoCaixa = calcularSaldoCaixa(caixaRows);
  const aluguelAbertoCaixa = encontrarPrimeiroAluguelAberto(contas, exdatesRows, parcelasRows, pagos, ajustesRows);
  const saldoAposAluguel = calcularSaldoAposAluguel(saldoCaixa, aluguelAbertoCaixa?.valor);
  ccSaldoEl.textContent = formatMoney(saldoAposAluguel);
  ccSaldoTotalEl.textContent = formatMoney(saldoCaixa);
  ccSaldoTotalEl.classList.toggle('negative', saldoCaixa < 0);

  if (contas.length === 0) {
    cpListEl.innerHTML = `<li class="empty-state">Nenhuma conta cadastrada.</li>`;
    cpContasListEl.innerHTML = `<li class="empty-state">Nenhuma conta cadastrada.</li>`;
    cpTotalMesPagoEl.textContent = formatMoney(0);
    cpTotalMesGeralEl.textContent = formatMoney(0);
    cpTotalSemanaAtualEl.textContent = formatMoney(0);
    cpTotalProximaSemanaEl.textContent = formatMoney(0);
    cpLabelSemanaAtualEl.textContent = 'Esta semana';
    cpLabelProximaSemanaEl.textContent = 'Próxima semana';
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
      const chave = `${conta.id}|${data}`;
      const emprestimo = ehEmprestimo(conta);
      const valorOriginal = valor;
      const totalAportes = emprestimo ? (aportesMap.get(chave) || 0) : 0;
      const valorRestante = emprestimo ? calcularSaldoEmprestimo(valorOriginal, totalAportes) : valorOriginal;
      const pagaRegistrada = pagosSet.has(chave);
      const paga = pagaRegistrada || (emprestimo && valorRestante === 0);
      const atrasada = data < hoje && !paga;
      ocorrenciasParaExibir.push({
        conta,
        data,
        valor: valorRestante,
        valorOriginal,
        totalAportes,
        emprestimo,
        pagaRegistrada,
        paga,
        atrasada,
      });
    });
  });

  ocorrenciasParaExibir.sort((a, b) => a.data.localeCompare(b.data));

  const primeiroAluguelAberto = ocorrenciasParaExibir.find((ocorrencia) => {
    return !ocorrencia.paga && ocorrencia.conta.descricao.trim().toLocaleLowerCase('pt-BR') === 'aluguel';
  });
  if (primeiroAluguelAberto && saldoCaixa > 0) {
    primeiroAluguelAberto.abatimentoCaixa = calcularAbatimentoAluguel(saldoCaixa, primeiroAluguelAberto.valor);
  }

  const ocorrenciasMesAtual = ocorrenciasParaExibir.filter((ocorrencia) => ocorrencia.data.slice(0, 7) === mesAtual);
  const totalMesPago = ocorrenciasMesAtual.reduce((acc, ocorrencia) => {
    if (ocorrencia.emprestimo) {
      return acc + (ocorrencia.pagaRegistrada
        ? ocorrencia.valorOriginal
        : Math.min(ocorrencia.totalAportes, ocorrencia.valorOriginal));
    }
    return acc + (ocorrencia.paga ? valorExibidoOcorrencia(ocorrencia) : 0);
  }, 0);
  const totalMesNaoPago = ocorrenciasMesAtual
    .filter((ocorrencia) => !ocorrencia.paga)
    .reduce((acc, ocorrencia) => acc + valorExibidoOcorrencia(ocorrencia), 0);

  const totalMesGeral = round2(totalMesPago + totalMesNaoPago);
  cpTotalMesPagoEl.textContent = formatMoney(totalMesPago);
  cpTotalMesGeralEl.textContent = formatMoney(totalMesGeral);

  const gruposSemanaTodos = agruparPorSemana(ocorrenciasParaExibir);

  function totalPendenteDaSemana(ano, mes, semana) {
    const grupo = gruposSemanaTodos.find((g) => g.ano === ano && g.mes === mes && g.semana === semana);
    if (!grupo) return null;
    const pendentes = grupo.itens.filter((i) => !i.paga);
    if (pendentes.length === 0) return null;
    return pendentes.reduce((acc, i) => acc + valorExibidoOcorrencia(i), 0);
  }

  // Acha a primeira semana (a partir de `dataRef`, que já está `saltos`
  // semanas à frente de hoje) que ainda tem alguma ocorrência não paga. Se
  // a semana já está toda paga (ou vazia), avança semana a semana até
  // achar uma com pendência — sem limite.
  function acharSemanaComPendencia(dataRef, saltos) {
    const datasPendentes = ocorrenciasParaExibir
      .filter((ocorrencia) => !ocorrencia.paga)
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

  cpTotalSemanaAtualEl.textContent = formatMoney(semanaAtual.total);
  cpTotalProximaSemanaEl.textContent = formatMoney(proximaSemana.total);
  cpLabelSemanaAtualEl.textContent = rotuloDistanciaSemana(semanaAtual.saltos);
  cpLabelProximaSemanaEl.textContent = rotuloDistanciaSemana(proximaSemana.saltos);

  const anoHoje = semanaAtual.ano;
  const mesHoje = semanaAtual.mes;
  const semanaHoje = semanaAtual.semana;

  function ehGrupoDaSemanaAtual(grupo) {
    return grupo.ano === anoHoje && grupo.mes === mesHoje && grupo.semana === semanaHoje;
  }

  function renderizarItemOcorrencia(ocorrencia) {
    const { conta, data, valor, valorOriginal, emprestimo, paga, atrasada } = ocorrencia;
    const valorExibido = valorExibidoOcorrencia(ocorrencia);
    const botaoAporte = emprestimo && !paga ? `
        <button type="button" class="btn-icon btn-aporte cp-aporte-btn" data-conta-id="${conta.id}" data-data="${data}" data-restante="${valor}" aria-label="Fazer aporte" title="Fazer aporte">+</button>` : '';
    const botoesAcao = paga ? '' : `
        ${botaoAporte}
        <button type="button" class="btn-icon btn-icon-neutro cp-editar-btn" data-conta-id="${conta.id}" data-data="${data}" data-tipo="${conta.tipo}" data-valor="${valorOriginal}" aria-label="Editar valor" title="Editar valor">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button type="button" class="btn-icon cp-pular-btn" data-conta-id="${conta.id}" data-data="${data}" data-tipo="${conta.tipo}" aria-label="Pular esta ocorrência" title="Pular esta ocorrência">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>`;

    const chaveSelecao = `${conta.id}|${data}`;
    const selecionada = cpOcorrenciasSelecionadas.has(chaveSelecao);

    return `
      <li class="lancamento-item${atrasada ? ' lancamento-atrasada' : ''}${selecionada ? ' cp-ocorrencia-selecionada' : ''}">
        <div class="lancamento-checkbox">
          <input type="checkbox" data-conta-id="${conta.id}" data-data="${data}" class="cp-pago-checkbox" aria-label="Marcar ${conta.descricao} como paga" ${paga ? 'checked' : ''} ${emprestimo ? 'disabled' : ''}>
          <div class="lancamento-info">
            <button type="button" class="cp-selecionar-btn" data-conta-id="${conta.id}" data-data="${data}" data-nome="${conta.descricao}" data-valor="${valorExibido}">${conta.descricao}</button>${atrasada ? ' <span class="tag-atrasada">Atrasada</span>' : ''}
            <span class="lancamento-data">${formatDataBR(data)}</span>
          </div>
        </div>
        <span class="lancamento-valor negativo">${formatMoney(valorExibido)}</span>${botoesAcao}
      </li>
    `;
  }

  function renderizarGruposSemana(grupos) {
    return grupos.map((grupo) => {
      const ehSemanaAtual = ehGrupoDaSemanaAtual(grupo);
      const itensHtml = grupo.itens.map(renderizarItemOcorrencia).join('');
      const rotuloSemana = `Semana ${grupo.semana}`;
      const totalGrupo = grupo.itens.reduce((acc, item) => acc + valorExibidoOcorrencia(item), 0);
      const chaveSemana = `${grupo.ano}-${grupo.mes}-${grupo.semana}`;
      const aberta = cpGruposAlteradosManualmente.get(chaveSemana) ?? abrirGrupoPorPadrao(grupo.itens, ehSemanaAtual);

      return `
        <li class="semana-grupo">
          <details class="cp-grupo-details" data-grupo="${chaveSemana}"${aberta ? ' open' : ''}>
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

  const ocorrenciasEmprestimo = ocorrenciasParaExibir.filter((ocorrencia) => ocorrencia.emprestimo);
  const demaisOcorrencias = ocorrenciasParaExibir.filter((ocorrencia) => !ocorrencia.emprestimo);
  const emprestimosAbertos = cpGruposAlteradosManualmente.get('emprestimo') ?? abrirGrupoPorPadrao(ocorrenciasEmprestimo);
  const emprestimosHtml = ocorrenciasEmprestimo.length === 0 ? '' : `
    <li class="semana-grupo emprestimo-grupo">
      <details class="cp-grupo-details" data-grupo="emprestimo"${emprestimosAbertos ? ' open' : ''}>
        <summary class="semana-grupo-titulo">
          <span>Empréstimo</span>
          <span class="semana-grupo-total">${formatMoney(ocorrenciasEmprestimo.reduce((acc, item) => acc + item.valor, 0))}</span>
        </summary>
        <ul class="lancamentos">${ocorrenciasEmprestimo.map(renderizarItemOcorrencia).join('')}</ul>
      </details>
    </li>
  `;
  cpListEl.innerHTML = emprestimosHtml + renderizarGruposSemana(agruparPorSemana(demaisOcorrencias));
  const chavesDisponiveis = new Set(ocorrenciasParaExibir.map((ocorrencia) => `${ocorrencia.conta.id}|${ocorrencia.data}`));
  cpOcorrenciasSelecionadas.forEach((_ocorrencia, chave) => {
    if (!chavesDisponiveis.has(chave)) cpOcorrenciasSelecionadas.delete(chave);
  });
  atualizarBarraSelecaoContasPagar();

  cpContasListEl.innerHTML = contas.map((conta) => {
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
      <button type="button" class="btn-icon cp-remover-btn" data-conta-id="${conta.id}" aria-label="Remover conta" title="Remover conta">
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
  if (!e.target.classList.contains('cp-pago-checkbox')) return;
  const contaId = e.target.dataset.contaId;
  const data = e.target.dataset.data;

  if (e.target.checked) {
    await supabase.from(CP_PAGAMENTOS_TABLE).insert({ conta_id: contaId, data });
  } else {
    await supabase.from(CP_PAGAMENTOS_TABLE).delete().eq('conta_id', contaId).eq('data', data);
  }
  await carregarContasPagar();
}

cpListEl.addEventListener('change', alternarPagoContasPagar);

cpListEl.addEventListener('click', async (e) => {
  const aporteBtn = e.target.closest('.cp-aporte-btn');
  if (aporteBtn) {
    const valorTexto = prompt('Valor do aporte:', aporteBtn.dataset.restante.replace('.', ','));
    if (valorTexto === null) return;

    const valorInformado = parseMoney(valorTexto);
    if (!valorInformado || valorInformado <= 0) {
      alert('Valor inválido.');
      return;
    }

    const valorRestante = Number(aporteBtn.dataset.restante);
    const valorAporte = limitarAporteEmprestimo(valorInformado, valorRestante);
    const { error } = await supabase.from(EMPRESTIMO_APORTES_TABLE).insert(
      dadosAporteManual(aporteBtn.dataset.contaId, aporteBtn.dataset.data, valorAporte, hojeISO())
    );

    if (error) {
      alert('Erro ao registrar o aporte. Confira se a migration 006 foi aplicada.');
      return;
    }

    if (valorAporte >= valorRestante) {
      await supabase.from(CP_PAGAMENTOS_TABLE).upsert({
        conta_id: aporteBtn.dataset.contaId,
        data: aporteBtn.dataset.data,
      });
    }

    await carregarContasPagar();
    return;
  }

  const pularBtn = e.target.closest('.cp-pular-btn');
  if (pularBtn) {
    if (pularBtn.dataset.tipo === 'parcelado') {
      await supabase.from(CP_PARCELAS_TABLE).delete().eq('conta_id', pularBtn.dataset.contaId).eq('data', pularBtn.dataset.data);
    } else {
      await supabase.from(CP_EXDATES_TABLE).insert({ conta_id: pularBtn.dataset.contaId, data: pularBtn.dataset.data });
    }
    await carregarContasPagar();
    return;
  }

  const editarBtn = e.target.closest('.cp-editar-btn');
  if (editarBtn) {
    const { contaId, data, tipo, valor } = editarBtn.dataset;
    const novoValorTexto = prompt('Novo valor:', valor.replace('.', ','));
    if (novoValorTexto === null) return;

    const novoValor = parseMoney(novoValorTexto);
    if (!novoValor || novoValor <= 0) {
      alert('Valor inválido.');
      return;
    }

    if (tipo === 'parcelado') {
      await supabase.from(CP_PARCELAS_TABLE).update({ valor: novoValor }).eq('conta_id', contaId).eq('data', data);
    } else {
      await supabase.from(CP_AJUSTES_TABLE).upsert({ conta_id: contaId, data, valor: novoValor });
    }
    await carregarContasPagar();
  }
});

cpContasListEl.addEventListener('click', async (e) => {
  const btn = e.target.closest('.cp-remover-btn');
  if (!btn) return;
  if (!confirm('Remover esta conta e todo o seu histórico de pagamentos/parcelas/exceções?')) return;
  await supabase.from(CP_TABLE).delete().eq('id', btn.dataset.contaId);
  await carregarContasPagar();
});

bloquearDuranteSubmit(cpForm, async (e) => {
  e.preventDefault();
  cpErrorEl.hidden = true;

  const descricao = cpDescricaoInput.value.trim();
  const valor = parseMoney(cpValorInput.value);
  const tipo = document.querySelector('input[name="cp-tipo"]:checked').value;

  if (!valor || valor <= 0) {
    cpErrorEl.textContent = 'Informe um valor válido.';
    cpErrorEl.hidden = false;
    return;
  }

  if (tipo === 'recorrente') {
    const dataInicio = cpDataInicioInput.value;
    if (!dataInicio) {
      cpErrorEl.textContent = 'Informe a data.';
      cpErrorEl.hidden = false;
      return;
    }

    const dia = Number(dataInicio.split('-')[2]);
    const { error } = await supabase.from(CP_TABLE).insert({
      descricao,
      valor,
      tipo: 'recorrente',
      dia_vencimento: dia,
      data_inicio: dataInicio,
    });

    if (error) {
      cpErrorEl.textContent = 'Erro ao salvar. Tente novamente.';
      cpErrorEl.hidden = false;
      return;
    }
  } else {
    const datasParcelas = Array.from(cpDatasParcelasEl.querySelectorAll('.cp-data-parcela')).map((el) => el.value);

    if (datasParcelas.length === 0 || datasParcelas.some((d) => !d)) {
      cpErrorEl.textContent = 'Informe a quantidade de parcelas e preencha todas as datas.';
      cpErrorEl.hidden = false;
      return;
    }

    const modoValor = document.querySelector('input[name="cp-valor-modo"]:checked').value;
    const valoresParcelas = calcularValoresParcelas(valor, datasParcelas.length, modoValor);
    const dataInicio = [...datasParcelas].sort()[0];

    const { data: contaCriada, error } = await supabase.from(CP_TABLE).insert({
      descricao,
      tipo: 'parcelado',
      data_inicio: dataInicio,
    }).select().single();

    if (error) {
      cpErrorEl.textContent = 'Erro ao salvar. Tente novamente.';
      cpErrorEl.hidden = false;
      return;
    }

    const { error: errParcelas } = await supabase.from(CP_PARCELAS_TABLE).insert(
      datasParcelas.map((data, i) => ({ conta_id: contaCriada.id, data, valor: valoresParcelas[i] }))
    );

    if (errParcelas) {
      cpErrorEl.textContent = 'Conta criada, mas houve erro ao salvar as parcelas.';
      cpErrorEl.hidden = false;
      return;
    }
  }

  cpForm.reset();
  cpDataInicioInput.value = hojeISO();
  cpCampoDataUnicaEl.hidden = false;
  cpCampoParcelasEl.hidden = true;
  cpValorModoEl.hidden = true;
  cpDatasParcelasEl.innerHTML = '';
  await carregarContasPagar();
});

// ===================== FIADO =====================

const fiTotalEl = document.getElementById('fi-total');
const fiListEl = document.getElementById('fi-list');
const fiForm = document.getElementById('fi-form');
const fiErrorEl = document.getElementById('fi-form-error');
const fiPessoaInput = document.getElementById('fi-pessoa');
const fiPessoasDatalistEl = document.getElementById('fi-pessoas-datalist');
const fiValorInput = document.getElementById('fi-valor');
const fiDataInput = document.getElementById('fi-data');
const fiDescricaoInput = document.getElementById('fi-descricao');
const fiPagamentoForm = document.getElementById('fi-pagamento-form');
const fiPagamentoErrorEl = document.getElementById('fi-pagamento-form-error');
const fiPagamentoPessoaSelect = document.getElementById('fi-pagamento-pessoa');
const fiPagamentoValorInput = document.getElementById('fi-pagamento-valor');
const fiPagamentoDataInput = document.getElementById('fi-pagamento-data');
const fiPagamentoDescricaoInput = document.getElementById('fi-pagamento-descricao');
aplicarMascaraMoney(fiValorInput);
aplicarMascaraMoney(fiPagamentoValorInput);

async function carregarFiado() {
  fiDataInput.value = fiDataInput.value || hojeISO();
  fiPagamentoDataInput.value = fiPagamentoDataInput.value || hojeISO();

  const [
    { data: pessoas, error: errPessoas },
    { data: vendas, error: errVendas },
    { data: pagamentos, error: errPagamentos },
  ] = await Promise.all([
    supabase.from(FI_PESSOAS_TABLE).select('*').order('nome', { ascending: true }),
    supabase.from(FI_VENDAS_TABLE).select('*').order('data', { ascending: false }).order('created_at', { ascending: false }),
    supabase.from(FI_PAGAMENTOS_TABLE).select('*').order('data', { ascending: false }).order('created_at', { ascending: false }),
  ]);

  if (errPessoas || errVendas || errPagamentos) {
    fiListEl.innerHTML = `<li class="empty-state">Erro ao carregar fiado.</li>`;
    return;
  }

  fiPessoasDatalistEl.innerHTML = pessoas.map((p) => `<option value="${p.nome}">`).join('');

  if (pessoas.length === 0) {
    fiListEl.innerHTML = `<li class="empty-state">Nenhuma pessoa cadastrada.</li>`;
    fiTotalEl.textContent = formatMoney(0);
    fiPagamentoPessoaSelect.innerHTML = `<option value="">Nenhuma pessoa cadastrada</option>`;
    return;
  }

  const saldosPorPessoa = new Map(pessoas.map((pessoa) => {
    const vendasDaPessoa = vendas.filter((venda) => venda.pessoa_id === pessoa.id);
    const pagamentosDaPessoa = pagamentos.filter((pagamento) => pagamento.pessoa_id === pessoa.id);
    return [pessoa.id, calcularSaldoFiado(vendasDaPessoa, pagamentosDaPessoa)];
  }));

  const pessoaSelecionada = fiPagamentoPessoaSelect.value;
  fiPagamentoPessoaSelect.innerHTML = `
    <option value="">Escolha a pessoa</option>
    ${pessoas.map((pessoa) => `<option value="${pessoa.id}">${pessoa.nome} — ${formatMoney(saldosPorPessoa.get(pessoa.id))}</option>`).join('')}
  `;
  fiPagamentoPessoaSelect.value = pessoaSelecionada;

  let totalGeral = 0;

  fiListEl.innerHTML = pessoas.map((pessoa) => {
    const vendasDaPessoa = vendas.filter((v) => v.pessoa_id === pessoa.id);
    const pagamentosDaPessoa = pagamentos.filter((p) => p.pessoa_id === pessoa.id);
    const saldoPessoa = saldosPorPessoa.get(pessoa.id);
    totalGeral += saldoPessoa;

    const lancamentos = [
      ...vendasDaPessoa.map((v) => ({ ...v, tipo: 'venda' })),
      ...pagamentosDaPessoa.map((p) => ({ ...p, tipo: 'pagamento' })),
    ].sort((a, b) => b.data.localeCompare(a.data) || b.created_at.localeCompare(a.created_at));

    const lancamentosHtml = lancamentos.length === 0
      ? `<li class="empty-state">Nenhum lançamento ainda.</li>`
      : lancamentos.map((lancamento) => {
        const pagamento = lancamento.tipo === 'pagamento';
        const descricao = lancamento.descricao || (pagamento ? 'Pagamento' : 'Sem descrição');
        const classeBotao = pagamento ? 'fi-remover-pagamento-btn' : 'fi-remover-venda-btn';
        const atributoId = pagamento ? 'data-pagamento-id' : 'data-venda-id';
        const rotuloRemover = pagamento ? 'Remover pagamento' : 'Remover venda';
        return `
        <li class="lancamento-item">
          <div class="lancamento-info">
            <span class="lancamento-desc">${descricao}</span>
            <span class="lancamento-data">${formatDataBR(lancamento.data)}</span>
          </div>
          <span class="lancamento-valor ${pagamento ? 'positivo' : 'negativo'}">${pagamento ? '− ' : ''}${formatMoney(lancamento.valor)}</span>
          <button type="button" class="btn-icon ${classeBotao}" ${atributoId}="${lancamento.id}" aria-label="${rotuloRemover}" title="${rotuloRemover}">
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
        <details class="fi-pessoa-details">
          <summary class="fi-pessoa-summary">
            <span class="fi-pessoa-nome">${pessoa.nome}</span>
            <span class="lancamento-valor ${saldoPessoa > 0 ? 'negativo' : 'positivo'}">${formatMoney(saldoPessoa)}</span>
            <button type="button" class="btn-icon fi-remover-pessoa-btn" data-pessoa-id="${pessoa.id}" aria-label="Remover pessoa" title="Remover pessoa">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </summary>
          <ul class="lancamentos">${lancamentosHtml}</ul>
        </details>
      </li>
    `;
  }).join('');

  fiTotalEl.textContent = formatMoney(round2(totalGeral));
}

fiListEl.addEventListener('click', async (e) => {
  const removerVendaBtn = e.target.closest('.fi-remover-venda-btn');
  if (removerVendaBtn) {
    const { data: venda, error: errVenda } = await supabase
      .from(FI_VENDAS_TABLE)
      .select('id, pessoa_id, valor')
      .eq('id', removerVendaBtn.dataset.vendaId)
      .single();

    if (errVenda) {
      alert('Erro ao conferir a venda. Tente novamente.');
      return;
    }

    const [{ data: vendas, error: errVendas }, { data: pagamentos, error: errPagamentos }] = await Promise.all([
      supabase.from(FI_VENDAS_TABLE).select('id, valor').eq('pessoa_id', venda.pessoa_id),
      supabase.from(FI_PAGAMENTOS_TABLE).select('valor').eq('pessoa_id', venda.pessoa_id),
    ]);

    if (errVendas || errPagamentos) {
      alert('Erro ao conferir o saldo. Tente novamente.');
      return;
    }

    if (!podeRemoverVendaFiado(vendas, pagamentos, venda)) {
      alert('Não é possível remover esta venda porque há pagamentos vinculados ao saldo. Remova primeiro o pagamento necessário.');
      return;
    }

    const { error } = await supabase.from(FI_VENDAS_TABLE).delete().eq('id', removerVendaBtn.dataset.vendaId);
    if (error) {
      alert('Erro ao remover a venda. Tente novamente.');
      return;
    }
    await carregarFiado();
    return;
  }

  const removerPagamentoBtn = e.target.closest('.fi-remover-pagamento-btn');
  if (removerPagamentoBtn) {
    await supabase.from(FI_PAGAMENTOS_TABLE).delete().eq('id', removerPagamentoBtn.dataset.pagamentoId);
    await carregarFiado();
    return;
  }

  const removerPessoaBtn = e.target.closest('.fi-remover-pessoa-btn');
  if (removerPessoaBtn) {
    e.preventDefault();
    if (!confirm('Remover esta pessoa e todo o seu histórico de vendas e pagamentos?')) return;
    await supabase.from(FI_PESSOAS_TABLE).delete().eq('id', removerPessoaBtn.dataset.pessoaId);
    await carregarFiado();
  }
});

bloquearDuranteSubmit(fiForm, async (e) => {
  e.preventDefault();
  fiErrorEl.hidden = true;

  const nomePessoa = fiPessoaInput.value.trim();
  const valor = parseMoney(fiValorInput.value);
  const data = fiDataInput.value;
  const descricao = fiDescricaoInput.value.trim();

  if (!nomePessoa) {
    fiErrorEl.textContent = 'Informe o nome da pessoa.';
    fiErrorEl.hidden = false;
    return;
  }

  if (!valor || valor <= 0) {
    fiErrorEl.textContent = 'Informe um valor válido.';
    fiErrorEl.hidden = false;
    return;
  }

  const { data: pessoasExistentes, error: errBusca } = await supabase
    .from(FI_PESSOAS_TABLE)
    .select('*')
    .ilike('nome', nomePessoa);

  if (errBusca) {
    fiErrorEl.textContent = 'Erro ao salvar. Tente novamente.';
    fiErrorEl.hidden = false;
    return;
  }

  let pessoaId = pessoasExistentes[0]?.id;

  if (!pessoaId) {
    const { data: pessoaCriada, error: errCriar } = await supabase
      .from(FI_PESSOAS_TABLE)
      .insert({ nome: nomePessoa })
      .select()
      .single();

    if (errCriar) {
      fiErrorEl.textContent = 'Erro ao salvar. Tente novamente.';
      fiErrorEl.hidden = false;
      return;
    }
    pessoaId = pessoaCriada.id;
  }

  const { error } = await supabase.from(FI_VENDAS_TABLE).insert({
    pessoa_id: pessoaId,
    valor,
    data,
    descricao: descricao || null,
  });

  if (error) {
    fiErrorEl.textContent = 'Erro ao salvar. Tente novamente.';
    fiErrorEl.hidden = false;
    return;
  }

  fiForm.reset();
  fiDataInput.value = hojeISO();
  await carregarFiado();
});

bloquearDuranteSubmit(fiPagamentoForm, async (e) => {
  e.preventDefault();
  fiPagamentoErrorEl.hidden = true;

  const pessoaId = fiPagamentoPessoaSelect.value;
  const valor = parseMoney(fiPagamentoValorInput.value);
  const data = fiPagamentoDataInput.value;
  const descricao = fiPagamentoDescricaoInput.value.trim() || 'Pagamento';

  if (!pessoaId) {
    fiPagamentoErrorEl.textContent = 'Escolha a pessoa que realizou o pagamento.';
    fiPagamentoErrorEl.hidden = false;
    return;
  }

  if (!valor || valor <= 0) {
    fiPagamentoErrorEl.textContent = 'Informe um valor válido.';
    fiPagamentoErrorEl.hidden = false;
    return;
  }

  const [{ data: vendas, error: errVendas }, { data: pagamentos, error: errPagamentos }] = await Promise.all([
    supabase.from(FI_VENDAS_TABLE).select('valor').eq('pessoa_id', pessoaId),
    supabase.from(FI_PAGAMENTOS_TABLE).select('valor').eq('pessoa_id', pessoaId),
  ]);

  if (errVendas || errPagamentos) {
    fiPagamentoErrorEl.textContent = 'Erro ao conferir o saldo. Tente novamente.';
    fiPagamentoErrorEl.hidden = false;
    return;
  }

  const saldoPessoa = calcularSaldoFiado(vendas, pagamentos);

  if (!podeRegistrarPagamentoFiado(valor, saldoPessoa)) {
    fiPagamentoErrorEl.textContent = `O pagamento não pode ultrapassar o saldo de ${formatMoney(saldoPessoa)}.`;
    fiPagamentoErrorEl.hidden = false;
    return;
  }

  const { error } = await supabase.from(FI_PAGAMENTOS_TABLE).insert({
    pessoa_id: pessoaId,
    valor,
    data,
    descricao,
  });

  if (error) {
    fiPagamentoErrorEl.textContent = 'Erro ao salvar. Tente novamente.';
    fiPagamentoErrorEl.hidden = false;
    return;
  }

  fiPagamentoForm.reset();
  fiPagamentoDataInput.value = hojeISO();
  fiPagamentoDescricaoInput.value = 'Pagamento';
  await carregarFiado();
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
  teste('Dinheiro — entrada vazia é inválida', () => igual(Number.isNaN(parseMoney('')), true));
  teste('Dinheiro — arredonda para dois centavos', () => igual(round2(10.005), 10.01));
  teste('Caixa — entradas somam e saídas subtraem', () => {
    igual(calcularSaldoCaixa([{ tipo: 'entrada', valor: 150 }, { tipo: 'saida', valor: 40 }]), 110);
  });
  teste('Caixa — saldo após aluguel nunca fica negativo', () => igual(calcularSaldoAposAluguel(300, 500), 0));
  teste('Caixa — saldo após aluguel preserva a sobra', () => igual(calcularSaldoAposAluguel(800, 500), 300));
  teste('Aluguel — abatimento não ultrapassa o aluguel', () => igual(calcularAbatimentoAluguel(800, 500), 500));
  teste('Aluguel — saldo negativo não gera abatimento', () => igual(calcularAbatimentoAluguel(-10, 500), 0));
  teste('Aluguel — valor líquido alimenta linha, semana e resumo mensal', () => {
    igual(valorExibidoOcorrencia({ valor: 1000, abatimentoCaixa: 300 }), 700);
  });
  teste('Salário — comissão é 25% da venda', () => igual(calcularComissao(199.99), 50));
  teste('Empréstimo — aporte informado grava somente origem manual', () => {
    igualJson(dadosAporteManual('e1', '2026-09-10', 50, '2026-09-15'), {
      conta_id: 'e1', data_ocorrencia: '2026-09-10', valor: 50, origem: 'manual', data: '2026-09-15',
    });
  });
  teste('Empréstimo — aportes reduzem o saldo sem deixá-lo negativo', () => {
    igual(calcularSaldoEmprestimo(1000, 1250), 0);
  });
  teste('Empréstimo — aporte maior é limitado ao saldo restante', () => {
    igual(limitarAporteEmprestimo(500, 120), 120);
  });
  teste('Empréstimo — soma o histórico por ocorrência', () => {
    const totais = somarAportesPorOcorrencia([
      { conta_id: 'e1', data_ocorrencia: '2026-09-10', valor: 25, origem: 'venda' },
      { conta_id: 'e1', data_ocorrencia: '2026-09-10', valor: 12.5, origem: 'manual' },
      { conta_id: 'e1', data_ocorrencia: '2026-10-10', valor: 10, origem: 'manual' },
    ]);
    igual(totais.get('e1|2026-09-10'), 37.5);
    igual(totais.get('e1|2026-10-10'), 10);
  });
  teste('Empréstimo — nome aproximado não recebe tratamento especial', () => {
    igual(ehEmprestimo({ descricao: ' EMPRÉSTIMO ' }), true);
    igual(ehEmprestimo({ descricao: 'Empréstimo banco' }), false);
  });
  teste('Salário — vendas somam e pagamentos subtraem', () => {
    igual(calcularSaldoSalario([{ tipo: 'venda', valor: 80 }, { tipo: 'pagamento', valor: 30 }]), 50);
  });
  teste('Contas a Pagar — soma ocorrências selecionadas sem alterar pagamento', () => {
    igual(somarValoresSelecionados([{ valor: 100.15 }, { valor: 20.2 }]), 120.35);
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
    igual(calcularSaldoFiado([{ valor: 100 }, { valor: 50 }], [{ valor: 40 }]), 110);
  });
  teste('Fiado — aceita pagamento até o saldo', () => igual(podeRegistrarPagamentoFiado(100, 100), true));
  teste('Fiado — bloqueia pagamento acima do saldo', () => igual(podeRegistrarPagamentoFiado(100.01, 100), false));
  teste('Fiado — bloqueia remover venda que deixaria pagamentos descobertos', () => {
    const vendas = [{ id: 'v1', valor: 100 }, { id: 'v2', valor: 50 }];
    igual(podeRemoverVendaFiado(vendas, [{ valor: 80 }], vendas[0]), false);
  });
  teste('Fiado — permite remover venda mantendo saldo suficiente', () => {
    const vendas = [{ id: 'v1', valor: 100 }, { id: 'v2', valor: 50 }];
    igual(podeRemoverVendaFiado(vendas, [{ valor: 80 }], vendas[1]), true);
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
    cpListEl.innerHTML = '<li><details class="cp-grupo-details" data-grupo="2026-9-1" open><summary>Semana 1</summary></details></li>'
      + '<li><details class="cp-grupo-details" data-grupo="2026-9-2"><summary>Semana 2</summary></details></li>'
      + '<li><details class="cp-grupo-details" data-grupo="emprestimo" open><summary>Empréstimo</summary></details></li>';
    cpListEl.querySelectorAll('.cp-grupo-details > summary').forEach((summary) => summary.click());
    igual(cpGruposAlteradosManualmente.get('2026-9-1'), false);
    igual(cpGruposAlteradosManualmente.get('2026-9-2'), true);
    igual(cpGruposAlteradosManualmente.get('emprestimo'), false);
    cpGruposAlteradosManualmente.clear();
    cpListEl.innerHTML = '';
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
  teste('Recorrência — pagas futuras continuam ocupando uma das três vagas', () => {
    const conta = { id: 'c1', data_inicio: '2024-01-31', dia_vencimento: 31 };
    igualJson(gerarOcorrenciasRecorrenteParaExibir(conta, new Set(['2024-02-29']), 3, '2024-03-15'),
      ['2024-03-31', '2024-04-30', '2024-05-31']);
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
    const aluguel = encontrarPrimeiroAluguelAberto(contas, [], parcelas, [{ conta_id: 'a', data: '2026-09-10' }], []);
    igualJson(aluguel, { data: '2026-10-10', valor: 600 });
  });

  teste('Interface — as quatro telas usam ícone para voltar ao início', () => {
    igual(document.querySelectorAll('button[data-nav="home"] svg').length, 4);
  });
  teste('Interface — card do Caixa possui os dois saldos', () => {
    igual(Boolean(document.getElementById('cc-saldo') && document.getElementById('cc-saldo-total')), true);
  });
  teste('Interface — descrição de Contas a Pagar é obrigatória', () => {
    igual(document.getElementById('cp-descricao').required, true);
  });
  teste('Interface — seleção de Contas a Pagar possui barra e ação de limpar', () => {
    igual(Boolean(document.getElementById('cp-selecao-bar') && document.getElementById('cp-selecao-limpar')), true);
  });
  teste('Interface — PWA declara manifesto para instalação', () => {
    igual(Boolean(document.querySelector('link[rel="manifest"][href="./manifest.webmanifest"]')), true);
  });
  teste('Interface — valor e ícones do Empréstimo seguem a mesma linha', () => {
    const fixture = document.createElement('div');
    fixture.className = 'emprestimo-grupo';
    fixture.style.cssText = 'position:absolute;left:-10000px;top:0;width:400px';
    fixture.innerHTML = '<div class="lancamento-item"><label class="lancamento-checkbox">'
      + '<input type="checkbox" disabled><div class="lancamento-info">'
      + '<span class="lancamento-desc">Empréstimo</span>'
      + '<span class="lancamento-data">18/11/2026</span></div></label>'
      + '<span class="lancamento-valor negativo">R$ 500,00</span>'
      + '<button class="btn-icon btn-aporte">+</button><button class="btn-icon">Editar</button>'
      + '<button class="btn-icon">Pular</button></div>';
    document.body.appendChild(fixture);
    try {
      const item = fixture.querySelector('.lancamento-item');
      const label = fixture.querySelector('.lancamento-checkbox').getBoundingClientRect();
      const valor = fixture.querySelector('.lancamento-valor').getBoundingClientRect();
      const aporte = fixture.querySelector('.btn-aporte').getBoundingClientRect();
      igual(valor.left >= label.right, true);
      igual(valor.top < label.bottom && valor.bottom > label.top, true);
      igual(aporte.left >= valor.right, true);
      igual(getComputedStyle(item).flexWrap, 'nowrap');
    } finally {
      fixture.remove();
    }
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

if (new URLSearchParams(window.location.search).has('testes')) {
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
