// Edge Function infinitepay-saldo: busca o saldo da conta InfinitePay.
//
// A InfinitePay não tem API pública para isso; usamos as mesmas chamadas do
// painel web (app.infinitepay.io), autenticadas pelo cookie de sessão que o
// usuário cola no app. O cookie fica só na tabela infinitepay_sessao (sem
// acesso pelo navegador) e nunca volta na resposta: o app recebe só o saldo.
//
// Fluxo: cookie → POST /api/session/read-token → JWT (~30 min, guardado em
// cache na tabela) → GET /api/balance com Bearer.
//
// Corpo aceito (POST):
//   { acao: 'saldo' }
//   { acao: 'salvar', cookie?, user_id?, bearer? }  campos vazios mantêm o valor atual
//
// Resposta: { estado, saldo?, chaves? }, com estado em
//   ok | sem_sessao | sessao_expirada | bloqueado_cloudflare | formato_desconhecido | erro

import { createClient } from 'npm:@supabase/supabase-js@2';

const INFINITEPAY_URL = 'https://app.infinitepay.io';
const TABELA = 'infinitepay_sessao';

const cabecalhosCors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Imita o navegador: o site fica atrás da Cloudflare e pode recusar clientes "crus".
const cabecalhosNavegador = {
  accept: 'application/json, text/plain, */*',
  origin: INFINITEPAY_URL,
  referer: `${INFINITEPAY_URL}/`,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

// Devolve JSON com os cabeçalhos de CORS do app.
function responder(corpo: Record<string, unknown>) {
  return new Response(JSON.stringify(corpo), {
    headers: { ...cabecalhosCors, 'content-type': 'application/json' },
  });
}

// Lê a data de expiração (exp) de um JWT, sem validar assinatura.
function expiracaoDoJwt(jwt: string): string | null {
  try {
    const parte = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(parte));
    return typeof exp === 'number' ? new Date(exp * 1000).toISOString() : null;
  } catch {
    return null;
  }
}

// Diz se a recusa veio da Cloudflare (página HTML de desafio) e não da InfinitePay.
function bloqueioCloudflare(resposta: Response) {
  return resposta.headers.has('cf-mitigated')
    || (!resposta.ok && (resposta.headers.get('content-type') ?? '').includes('text/html'));
}

// SUPOSIÇÃO: o formato do /api/balance ainda não foi confirmado. Tenta os nomes
// mais prováveis; se nenhum servir, a resposta traz as chaves para ajustarmos.
function extrairSaldo(corpo: Record<string, any>): number | null {
  const candidatos = [corpo?.balance, corpo?.available_balance, corpo?.data?.balance, corpo?.data?.available_balance];
  const valor = candidatos.find((candidato) => typeof candidato === 'number');
  return valor ?? null;
}

// Pede um JWT novo ao read-token com o cookie guardado e salva no cache.
async function renovarJwt(sessao: { user_id: string; cookie: string }) {
  const resposta = await fetch(`${INFINITEPAY_URL}/api/session/read-token`, {
    method: 'POST',
    headers: { ...cabecalhosNavegador, 'content-type': 'application/json', cookie: sessao.cookie },
    body: JSON.stringify({ user_id: Number(sessao.user_id) || sessao.user_id }),
  });
  if (bloqueioCloudflare(resposta)) return { estado: 'bloqueado_cloudflare', status: resposta.status };
  if (resposta.status === 401 || resposta.status === 403) return { estado: 'sessao_expirada' };
  if (!resposta.ok) return { estado: 'erro', status: resposta.status };

  const corpo = await resposta.json();
  const jwt = corpo?.jwtReadToken;
  if (typeof jwt !== 'string') return { estado: 'formato_desconhecido', chaves: Object.keys(corpo ?? {}) };

  await admin.from(TABELA).update({ jwt, jwt_expira_em: expiracaoDoJwt(jwt) }).eq('id', 1);
  return { jwt };
}

// Consulta o saldo usando o JWT em cache; renova uma vez se ele estiver vencido ou for recusado.
async function buscarSaldo() {
  const { data: sessao, error } = await admin.from(TABELA).select('*').eq('id', 1).maybeSingle();
  if (error) return { estado: 'erro' };
  if (!sessao) return { estado: 'sem_sessao' };

  const margem = Date.now() + 60_000;
  let jwt = sessao.jwt && sessao.jwt_expira_em && Date.parse(sessao.jwt_expira_em) > margem ? sessao.jwt : null;

  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    if (!jwt) {
      const renovacao = await renovarJwt(sessao);
      if (!renovacao.jwt) return renovacao;
      jwt = renovacao.jwt;
    }

    const resposta = await fetch(`${INFINITEPAY_URL}/api/balance`, {
      headers: { ...cabecalhosNavegador, authorization: `Bearer ${jwt}` },
    });
    if (bloqueioCloudflare(resposta)) return { estado: 'bloqueado_cloudflare', status: resposta.status };
    if (resposta.status === 401 && tentativa === 0) {
      jwt = null;
      continue;
    }
    if (resposta.status === 401 || resposta.status === 403) return { estado: 'sessao_expirada' };
    if (!resposta.ok) return { estado: 'erro', status: resposta.status };

    const corpo = await resposta.json();
    const saldo = extrairSaldo(corpo);
    if (saldo === null) return { estado: 'formato_desconhecido', chaves: Object.keys(corpo ?? {}) };
    return { estado: 'ok', saldo };
  }
  return { estado: 'sessao_expirada' };
}

// Grava cookie, user_id e bearer informados; campos vazios mantêm o valor anterior.
async function salvarSessao(corpo: Record<string, unknown>) {
  const { data: atual } = await admin.from(TABELA).select('user_id, cookie').eq('id', 1).maybeSingle();
  const texto = (valor: unknown) => (typeof valor === 'string' ? valor.trim() : '');
  const cookie = texto(corpo.cookie) || atual?.cookie;
  const userId = texto(corpo.user_id) || atual?.user_id;
  const bearer = texto(corpo.bearer).replace(/^Bearer\s+/i, '');
  if (!cookie || !userId) return { estado: 'sem_sessao' };

  const linha: Record<string, unknown> = { id: 1, cookie, user_id: userId, atualizado_em: new Date().toISOString() };
  // Cookie novo invalida o JWT antigo; um bearer colado entra direto no cache.
  if (bearer) Object.assign(linha, { jwt: bearer, jwt_expira_em: expiracaoDoJwt(bearer) });
  else if (texto(corpo.cookie)) Object.assign(linha, { jwt: null, jwt_expira_em: null });

  const { error } = await admin.from(TABELA).upsert(linha);
  if (error) return { estado: 'erro' };
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
