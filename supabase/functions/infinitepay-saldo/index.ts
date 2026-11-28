// Edge Function infinitepay-saldo: busca o saldo da conta InfinitePay.
//
// A InfinitePay não tem API pública para isso; reproduzimos as mesmas
// requisições do painel web (app.infinitepay.io), copiadas pelo usuário no
// DevTools como cURL e coladas no app. Elas ficam só na tabela
// infinitepay_sessao (sem acesso pelo navegador) e nunca voltam na resposta:
// o app recebe só o saldo e as datas de expiração.
//
// Fluxo: cURL do read-token (cookie) → JWT (~30 min, guardado em cache) →
// cURL do balance com o Bearer trocado pelo JWT atual. Com o mesmo JWT, busca
// também o valor a receber nos próximos dias (payments_overview).
//
// Corpo aceito (POST):
//   { acao: 'saldo' }
//   { acao: 'salvar', curl }  um ou os dois cURLs no mesmo texto (bash ou cmd)
//
// Resposta: { estado, saldo?, a_receber?, validades?, erros?, chaves? }, com estado em
//   ok | sem_sessao | curl_invalido | sessao_expirada | bloqueado_cloudflare | formato_desconhecido | erro

import { createClient } from 'npm:@supabase/supabase-js@2';

const INFINITEPAY_HOST = 'app.infinitepay.io';
const CAMINHO_READ_TOKEN = '/api/session/read-token';
const CAMINHO_BALANCE = '/api/balance';
const RECEBIVEIS_URL = 'https://infinitepay-api-v2.services.production.infinitepay.io/transaction_payments/payments_overview';
const RECEBIVEIS_DIAS = 4;
const FUSO = 'America/Sao_Paulo';
const TABELA = 'infinitepay_sessao';
const TAMANHO_MAXIMO_CURL = 100_000;

const cabecalhosCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Cabeçalhos que o fetch do servidor calcula sozinho ou que quebrariam a resposta.
const CABECALHOS_IGNORADOS = new Set(['host', 'content-length', 'connection', 'accept-encoding']);

// Opções do curl que consomem o próximo argumento.
const OPCOES_COM_ARGUMENTO = new Set([
  '-H', '--header', '-b', '--cookie', '-X', '--request', '-d', '--data', '--data-raw', '--data-binary',
  '--data-ascii', '-A', '--user-agent', '-e', '--referer', '--url', '-o', '--output', '-u', '--user',
]);

type Requisicao = { url: string; metodo: string; headers: Record<string, string>; corpo: string | null };

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// Devolve JSON com os cabeçalhos de CORS do app.
function responder(corpo: Record<string, unknown>) {
  return new Response(JSON.stringify(corpo), {
    headers: { ...cabecalhosCors, 'content-type': 'application/json' },
  });
}

// Quebra o texto colado em argumentos, como o shell faria (aspas simples, $'...', aspas duplas).
// O formato cmd do Chrome (^" e ^ no fim da linha) é convertido antes.
function tokenizarCurl(textoOriginal: string): string[] {
  let texto = textoOriginal;
  if (/\^"|\^\r?\n/.test(texto)) texto = texto.replace(/\^\r?\n/g, ' ').replace(/\^(.)/g, '$1');
  texto = texto.replace(/\\\r?\n/g, ' ');

  const tokens: string[] = [];
  let i = 0;
  const fimSemAspas = () => { throw new Error('aspas sem fechar no cURL'); };
  while (i < texto.length) {
    if (/\s/.test(texto[i])) { i += 1; continue; }
    let atual = '';
    while (i < texto.length && !/\s/.test(texto[i])) {
      const c = texto[i];
      if (c === "'") {
        const fim = texto.indexOf("'", i + 1);
        if (fim < 0) fimSemAspas();
        atual += texto.slice(i + 1, fim);
        i = fim + 1;
      } else if (c === '$' && texto[i + 1] === "'") {
        i += 2;
        while (i < texto.length && texto[i] !== "'") {
          if (texto[i] === '\\') {
            const proximo = texto[i + 1];
            atual += ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[proximo] ?? proximo;
            i += 2;
          } else {
            atual += texto[i];
            i += 1;
          }
        }
        if (i >= texto.length) fimSemAspas();
        i += 1;
      } else if (c === '"') {
        i += 1;
        while (i < texto.length && texto[i] !== '"') {
          if (texto[i] === '\\' && '"\\$`'.includes(texto[i + 1])) {
            atual += texto[i + 1];
            i += 2;
          } else {
            atual += texto[i];
            i += 1;
          }
        }
        if (i >= texto.length) fimSemAspas();
        i += 1;
      } else if (c === '\\') {
        atual += texto[i + 1] ?? '';
        i += 2;
      } else {
        atual += c;
        i += 1;
      }
    }
    tokens.push(atual);
  }
  return tokens;
}

// Monta URL, método, cabeçalhos e corpo a partir dos argumentos de um curl.
function interpretarCurl(argumentos: string[]): Requisicao {
  let url = '';
  let metodo = '';
  let corpo: string | null = null;
  const headers: Record<string, string> = {};
  const cookies: string[] = [];

  for (let i = 0; i < argumentos.length; i += 1) {
    const argumento = argumentos[i];
    if (OPCOES_COM_ARGUMENTO.has(argumento)) {
      const valor = argumentos[i + 1] ?? '';
      i += 1;
      if (argumento === '-H' || argumento === '--header') {
        const separador = valor.indexOf(':');
        if (separador > 0) headers[valor.slice(0, separador).trim().toLowerCase()] = valor.slice(separador + 1).trim();
      } else if (argumento === '-b' || argumento === '--cookie') cookies.push(valor);
      else if (argumento === '-X' || argumento === '--request') metodo = valor.toUpperCase();
      else if (argumento.startsWith('-d') || argumento.startsWith('--data')) corpo = valor;
      else if (argumento === '-A' || argumento === '--user-agent') headers['user-agent'] = valor;
      else if (argumento === '-e' || argumento === '--referer') headers.referer = valor;
      else if (argumento === '--url') url = valor;
    } else if (!argumento.startsWith('-') && !url) {
      url = argumento;
    }
  }

  if (cookies.length) headers.cookie = [headers.cookie, ...cookies].filter(Boolean).join('; ');
  for (const nome of Object.keys(headers)) {
    if (CABECALHOS_IGNORADOS.has(nome) || nome.startsWith(':')) delete headers[nome];
  }
  return { url, metodo: metodo || (corpo === null ? 'GET' : 'POST'), headers, corpo };
}

// Separa os cURLs colados, identifica qual é o read-token e qual é o balance, e valida o básico.
function lerCurlsColados(texto: string) {
  const erros: string[] = [];
  const resultado: { readToken?: Requisicao; balance?: Requisicao } = {};
  if (texto.length > TAMANHO_MAXIMO_CURL) return { erros: ['Texto grande demais.'], resultado };

  let tokens: string[];
  try {
    tokens = tokenizarCurl(texto);
  } catch (erro) {
    return { erros: [(erro as Error).message], resultado };
  }

  const blocos: string[][] = [];
  for (const token of tokens) {
    if (/^curl(\.exe)?$/i.test(token)) blocos.push([]);
    else if (blocos.length) blocos[blocos.length - 1].push(token);
  }
  if (!blocos.length) return { erros: ['Nenhum comando curl encontrado.'], resultado };

  for (const bloco of blocos) {
    const requisicao = interpretarCurl(bloco);
    let url: URL;
    try {
      url = new URL(requisicao.url);
    } catch {
      erros.push('cURL sem URL válida.');
      continue;
    }
    if (url.protocol !== 'https:' || url.hostname !== INFINITEPAY_HOST) {
      erros.push(`URL fora da InfinitePay: ${url.hostname}`);
    } else if (url.pathname === CAMINHO_READ_TOKEN) {
      resultado.readToken = requisicao;
    } else if (url.pathname === CAMINHO_BALANCE) {
      resultado.balance = requisicao;
    } else {
      erros.push(`cURL não reconhecido: ${url.pathname}`);
    }
  }

  const readToken = resultado.readToken;
  if (readToken) {
    if (!readToken.headers.cookie) erros.push('O cURL do read-token está sem cookie.');
    try {
      if (!('user_id' in JSON.parse(readToken.corpo ?? ''))) erros.push('O corpo do read-token está sem user_id.');
    } catch {
      erros.push('O corpo do read-token não é JSON.');
    }
  }
  const bearer = resultado.balance?.headers.authorization;
  if (resultado.balance && !/^Bearer\s+\S+/i.test(bearer ?? '')) erros.push('O cURL do balance está sem Bearer.');
  if (!readToken && !resultado.balance) erros.push('Cole o cURL do read-token e/ou do balance.');
  return { erros, resultado };
}

// Lê a data de expiração (exp) de um JWT, sem validar assinatura.
function expiracaoDoJwt(jwt: string | null | undefined): string | null {
  try {
    const parte = jwt!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(parte));
    return typeof exp === 'number' ? new Date(exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

// Valor de um cookie dentro do cabeçalho "a=1; b=2".
function valorCookie(cabecalho: string, nome: string): string | null {
  for (const parte of cabecalho.split(';')) {
    const [chave, ...resto] = parte.trim().split('=');
    if (chave === nome) return resto.join('=');
  }
  return null;
}

// Datas de expiração da sessão, para o app mostrar com cores.
// SUPOSIÇÕES: ifp_token_exp é um timestamp (segundos ou ms) ou data ISO; o
// ipdashboard_session segue o formato Iron (Fe26.2*…), cujo 6º campo é a expiração em ms.
function validadesDaSessao(cookie: string, jwtExpiraEm: string | null) {
  const paraIso = (valor: string | null) => {
    if (!valor) return null;
    const numero = Number(valor);
    const data = Number.isFinite(numero) && numero > 0 ? new Date(numero < 1e12 ? numero * 1000 : numero) : new Date(valor);
    return Number.isNaN(data.getTime()) ? null : data.toISOString();
  };
  let iron: string | null = null;
  try {
    const partes = decodeURIComponent(valorCookie(cookie, 'ipdashboard_session') ?? '').split('*');
    if (partes[0] === 'Fe26.2') iron = paraIso(partes[5] || null);
  } catch {
    iron = null;
  }
  let tokenExp: string | null = null;
  try {
    tokenExp = paraIso(decodeURIComponent(valorCookie(cookie, 'ifp_token_exp') ?? ''));
  } catch {
    tokenExp = null;
  }
  return { ifp_token_exp: tokenExp, ipdashboard_session: iron, jwt: jwtExpiraEm };
}

// Diz se a recusa veio da Cloudflare (página HTML de desafio) e não da InfinitePay.
function bloqueioCloudflare(resposta: Response) {
  return resposta.headers.has('cf-mitigated')
    || (!resposta.ok && (resposta.headers.get('content-type') ?? '').includes('text/html'));
}

// O /api/balance devolve { total, free, premint, frozen, restricted, ... } em
// centavos; o saldo disponível (o "Seu saldo" do painel) é o free. Confirmado
// no teste real: free 47901 = R$ 479,01. O app recebe em reais.
function extrairSaldo(corpo: Record<string, any>): number | null {
  const free = typeof corpo?.free === 'string' ? Number(corpo.free) : corpo?.free;
  if (typeof free !== 'number' || !Number.isFinite(free)) return null;
  return Math.round(free) / 100;
}

// Período do "a receber": de amanhã até amanhã + 3 (4 dias corridos), no fuso de
// São Paulo. No pior caso, a venda de sexta cai 3 dias depois.
// SUPOSIÇÃO: o until da API inclui o último dia.
function periodoAReceber(agora = new Date()) {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }).format(agora); // AAAA-MM-DD
  const somarDias = (dias: number) => {
    const data = new Date(`${hoje}T12:00:00Z`);
    data.setUTCDate(data.getUTCDate() + dias);
    return data.toISOString().slice(0, 10);
  };
  return { since: somarDias(1), until: somarDias(RECEBIVEIS_DIAS) };
}

// Descreve o formato da resposta (chaves e tipos, sem valores) para ajustar a leitura depois.
function estrutura(valor: unknown, profundidade = 0): unknown {
  if (Array.isArray(valor)) return profundidade > 2 ? 'array' : [valor.length ? estrutura(valor[0], profundidade + 1) : 'vazio'];
  if (valor && typeof valor === 'object') {
    if (profundidade > 2) return 'objeto';
    return Object.fromEntries(Object.entries(valor).map(([chave, item]) => [chave, estrutura(item, profundidade + 1)]));
  }
  return typeof valor;
}

// O formato do payments_overview ainda não foi confirmado: por enquanto devolve
// a estrutura (sem valores) e o estado formato_desconhecido.
function extrairAReceber(_corpo: unknown): number | null {
  return null;
}

// Busca o total a receber no período, com o mesmo JWT do saldo. Nunca derruba o saldo.
async function buscarAReceber(jwt: string, cabecalhosBalance: Record<string, string>) {
  const periodo = periodoAReceber();
  try {
    const url = `${RECEBIVEIS_URL}?since=${periodo.since}&until=${periodo.until}`;
    const headers: Record<string, string> = {
      accept: '*/*',
      origin: `https://${INFINITEPAY_HOST}`,
      referer: `https://${INFINITEPAY_HOST}/`,
      authorization: `Bearer ${jwt}`,
    };
    if (cabecalhosBalance['user-agent']) headers['user-agent'] = cabecalhosBalance['user-agent'];
    const resposta = await fetch(url, { headers });
    if (bloqueioCloudflare(resposta)) return { estado: 'bloqueado_cloudflare', periodo };
    if (resposta.status === 401 || resposta.status === 403) return { estado: 'sessao_expirada', status: resposta.status, periodo };
    if (!resposta.ok) return { estado: 'erro', status: resposta.status, periodo };
    const corpo = await resposta.json();
    const valor = extrairAReceber(corpo);
    if (valor === null) {
      const formato = estrutura(corpo);
      console.log('payments_overview formato', JSON.stringify(formato));
      return { estado: 'formato_desconhecido', formato, periodo };
    }
    return { estado: 'ok', valor, periodo };
  } catch (erro) {
    console.error('payments_overview', erro);
    return { estado: 'erro', periodo };
  }
}

// Reproduz o cURL do read-token guardado e salva o JWT novo no cache.
async function renovarJwt(readToken: Requisicao) {
  const resposta = await fetch(readToken.url, { method: readToken.metodo, headers: readToken.headers, body: readToken.corpo });
  if (bloqueioCloudflare(resposta)) return { estado: 'bloqueado_cloudflare', status: resposta.status };
  if (resposta.status === 401 || resposta.status === 403) return { estado: 'sessao_expirada' };
  if (!resposta.ok) return { estado: 'erro', status: resposta.status };

  const corpo = await resposta.json();
  // O read-token devolve { token }; jwtReadToken fica como alternativa.
  const jwt = corpo?.token ?? corpo?.jwtReadToken;
  if (typeof jwt !== 'string') return { estado: 'formato_desconhecido', chaves: Object.keys(corpo ?? {}) };

  const jwtExpiraEm = expiracaoDoJwt(jwt);
  await admin.from(TABELA).update({ jwt, jwt_expira_em: jwtExpiraEm }).eq('id', 1);
  return { jwt, jwtExpiraEm };
}

// Consulta o saldo usando o JWT em cache; renova uma vez se ele estiver vencido ou for recusado.
async function buscarSaldo() {
  const { data: sessao, error } = await admin.from(TABELA).select('*').eq('id', 1).maybeSingle();
  if (error) return { estado: 'erro' };
  if (!sessao) return { estado: 'sem_sessao' };

  const readToken: Requisicao | null = sessao.requisicao_read_token;
  const balance: Requisicao = sessao.requisicao_balance
    ?? { url: `https://${INFINITEPAY_HOST}${CAMINHO_BALANCE}`, metodo: 'GET', headers: { accept: 'application/json' }, corpo: null };
  let jwtExpiraEm: string | null = sessao.jwt_expira_em;
  const validades = () => validadesDaSessao(readToken?.headers.cookie ?? '', jwtExpiraEm);

  const margem = Date.now() + 60_000;
  let jwt = sessao.jwt && jwtExpiraEm && Date.parse(jwtExpiraEm) > margem ? sessao.jwt : null;

  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    if (!jwt) {
      if (!readToken) return { estado: 'sessao_expirada', validades: validades() };
      const renovacao = await renovarJwt(readToken);
      if (!renovacao.jwt) return { ...renovacao, validades: validades() };
      ({ jwt, jwtExpiraEm } = renovacao);
    }

    const resposta = await fetch(balance.url, {
      method: balance.metodo,
      headers: { ...balance.headers, authorization: `Bearer ${jwt}` },
    });
    if (bloqueioCloudflare(resposta)) return { estado: 'bloqueado_cloudflare', status: resposta.status, validades: validades() };
    if (resposta.status === 401 && tentativa === 0) {
      jwt = null;
      continue;
    }
    if (resposta.status === 401 || resposta.status === 403) return { estado: 'sessao_expirada', validades: validades() };
    if (!resposta.ok) return { estado: 'erro', status: resposta.status, validades: validades() };

    const corpo = await resposta.json();
    const saldo = extrairSaldo(corpo);
    if (saldo === null) return { estado: 'formato_desconhecido', chaves: Object.keys(corpo ?? {}), validades: validades() };
    const aReceber = await buscarAReceber(jwt, balance.headers);
    return { estado: 'ok', saldo, a_receber: aReceber, validades: validades() };
  }
  return { estado: 'sessao_expirada', validades: validades() };
}

// Valida e grava os cURLs colados; o que não for colado mantém o valor anterior.
async function salvarSessao(corpo: Record<string, unknown>) {
  const { erros, resultado } = lerCurlsColados(typeof corpo.curl === 'string' ? corpo.curl : '');
  if (erros.length) return { estado: 'curl_invalido', erros };

  const { data: atual } = await admin.from(TABELA).select('id').eq('id', 1).maybeSingle();
  if (!atual && !resultado.readToken) return { estado: 'curl_invalido', erros: ['Na primeira vez, cole também o cURL do read-token.'] };

  const linha: Record<string, unknown> = { id: 1, atualizado_em: new Date().toISOString() };
  if (resultado.readToken) Object.assign(linha, { requisicao_read_token: resultado.readToken, jwt: null, jwt_expira_em: null });
  if (resultado.balance) {
    // O Bearer do cURL do balance vira o JWT em cache; o guardado sai sem ele.
    const jwt = resultado.balance.headers.authorization.replace(/^Bearer\s+/i, '');
    delete resultado.balance.headers.authorization;
    Object.assign(linha, { requisicao_balance: resultado.balance, jwt, jwt_expira_em: expiracaoDoJwt(jwt) });
  }

  const { error } = await admin.from(TABELA).upsert(linha);
  if (error) {
    console.error(error);
    return { estado: 'erro' };
  }
  return buscarSaldo();
}

Deno.serve(async (requisicao) => {
  if (requisicao.method === 'OPTIONS') return new Response('ok', { headers: cabecalhosCors });

  // Só usuários logados no app (o gateway já valida o JWT; aqui confirmamos o usuário).
  const token = (requisicao.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return new Response('Não autorizado', { status: 401, headers: cabecalhosCors });

  try {
    const corpo = await requisicao.json().catch(() => ({}));
    return responder(corpo.acao === 'salvar' ? await salvarSessao(corpo) : await buscarSaldo());
  } catch (erro) {
    console.error(erro);
    return responder({ estado: 'erro' });
  }
});
