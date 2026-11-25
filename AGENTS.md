# Instruções para agentes

Projeto pessoal de controle financeiro de uma loja. HTML/CSS/JS puro, sem
build, sem framework, sem dependências instaladas. Backend é Supabase.

**Responda e escreva sempre em português do Brasil** (conversa, comentários no
código, documentação e commits).

## Mapa do repositório

- `index.html`, `style.css`, `app.js` — toda a aplicação (e a suíte de testes)
- `REGRAS.md` — regras de negócio, fonte de verdade
- `migrations/` — SQL do banco, numerado em sequência
- `manifest.webmanifest`, `sw.js`, `pwa-icon-*.png`, `ammi-logo.png` — PWA e logo

## Leia isto antes de mexer em qualquer lógica

[REGRAS.md](REGRAS.md) é a fonte de verdade das regras de negócio. Leia antes de alterar qualquer cálculo, regra de exibição ou comportamento
de algum módulo.

Se uma mudança alterar alguma regra descrita lá, **atualize o REGRAS.md no
mesmo commit**. Documentação desatualizada é pior que documentação ausente.

## Toda mudança atualiza regras e testes

Toda nova feature ou mudança no projeto deve atualizar, no mesmo trabalho:

1. O `REGRAS.md`, documentando o comportamento novo ou alterado
2. Os testes de regressão, adicionando ou ajustando casos que protejam esse comportamento,
  sempre cuidando para não inflar a quantidade de testes ou repetir algo que já está coberto.

A mudança só é considerada concluída quando documentação e testes também
estiverem coerentes com o código. Ao finalizar, informe quais testes foram
adicionados ou ajustados (quem os executa é o usuário, veja "Testes").

## Preferências de trabalho

### Evite overengineering, sempre

Esta é a preferência mais importante do projeto. O usuário rejeita
explicitamente abstrações prematuras.

- Não crie camadas, interfaces ou indireções que o projeto não precisa hoje
- Não adicione tratamento de erro para cenários que não acontecem
- Três linhas parecidas são melhores que uma abstração prematura
- Escopo fechado: implemente o que foi pedido, não o que talvez venha depois

### Tudo em três arquivos

Não crie arquivos JS/CSS novos para separar módulos — o usuário pediu explicitamente para manter tudo junto.
A separação é por blocos comentados dentro do `app.js`, no formato
`// ===================== CAIXA CASA =====================`.

#### Exceção: arquivos mínimos da PWA

A instalação pelo Chrome também depende de `manifest.webmanifest`, `sw.js` e
dos ícones `pwa-icon-192.png` e `pwa-icon-512.png`. São arquivos de suporte da
PWA, não módulos novos da aplicação. Mantenha o service worker restrito ao
cache da interface: nunca coloque respostas, credenciais ou dados do Supabase no cache.

### Comentários sucintos em funções novas

Toda função nova no código leva um comentário curto e simples dizendo o que ela
faz e para que serve. Uma ou duas linhas, sem jargão. Não comente o óbvio linha
a linha: o comentário é sobre a utilidade da função.

### Confirme antes de decidir por conta própria

Quando houver ambiguidade real (nome de campo, comportamento de uma regra,
escopo de uma feature), pergunte em vez de assumir. O usuário responde
rápido e prefere corrigir o rumo antes da implementação, não depois.

## Commits e push

### Ajustes simples: commit e push direto na main

Ajustes visuais pequenos — espaçamento, alinhamento, cor, troca de ícone,
tamanho de fonte — e correções simples, pontuais e sem mudança de schema
podem ser commitados e enviados para `vcl02/gestao-ammi` **sem pedir
confirmação**.

### Todo o resto: confirme antes do push

Features novas, mudanças de schema, alterações amplas de lógica em `app.js`,
refatorações estruturais. Na dúvida sobre a classificação, pergunte.

### Formato

Explique o **porquê** e não só o quê. Termine com
a linha de atribuição do modelo que o sistema indicar na sessão.

## Migrations — cuidado redobrado

`migrations/` contém os arquivos SQL do banco, e só existe o banco de PROD.
Ao criar uma migration, **mostre o SQL e peça confirmação antes de aplicar**.
Confirmado, **aplique pelo MCP do Supabase** (`apply_migration`), em vez de
pedir que o usuário rode no SQL Editor. Se o MCP não estiver disponível, avise
e peça ao usuário.

As queries devem ser sempre **idempotentes** (`if not exists`, `create or
replace`, etc.), para poderem rodar mais de uma vez sem erro.

**Nunca edite uma migration já aplicada.** Para mudar algo, crie uma nova com
o próximo número da sequência. As migrations 001 a 019 foram rodadas à mão pelo
usuário e não aparecem no histórico do MCP; da 020 em diante, confira o que já
foi aplicado com `list_migrations`. Na dúvida, pergunte.

Toda tabela nova precisa de RLS habilitado e a policy `auth_all`, seguindo
o padrão das existentes. Sem isso, a tabela fica inacessível pelo app. Tabelas
deliberadamente somente leitura, como auditoria, usam policy apenas de `select`
e removem as permissões de escrita dos usuários do aplicativo.

## Rodar localmente

O projeto é estático, mas precisa de servidor HTTP (o `app.js` usa módulo ES;
abrir o `index.html` direto, via `file://`, não funciona). O usuário usa a
extensão **Live Server** do VS Code (`http://127.0.0.1:5500`). Não há Node nem
`package.json`.

**Atenção: só existe o banco de PROD.** O app local grava de verdade no
Supabase de produção. Para checar sem risco, use `?testes=1`, que não faz login
nem consulta o banco.

## Convenções de código

Armadilhas e convenções do código ficam como comentário no próprio `app.js`,
junto do ponto onde se aplicam (ex.: a chave pública do Supabase e `hojeISO()`).
Leia os comentários antes de alterar essas partes.

## Testes

**Só testes unitários.** A suíte fica no próprio `app.js`: abra `?testes=1` no
navegador. Não criar testes de integração, nem Playwright ou qualquer outra
ferramenta de automação de navegador. Também não usar Node: o projeto não tem
`package.json` nem dependências, e isso não deve mudar.

Mudanças visuais, instalação pelo Chrome e operações reais no Supabase não têm
teste automatizado: exigem verificação manual. Informe isso ao usuário em vez
de afirmar que funcionam.

**Quem roda os testes é o usuário.** O agente não executa a suíte; ao
finalizar, diga quais casos foram adicionados ou ajustados para o usuário
rodar.
