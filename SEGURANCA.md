# AfiliaPro — segurança

Documento prático. Cada item traz o ataque que ele previne, para você
não remover nada sem entender o custo.

---

## O que já está implementado no código

| Camada | Arquivo | Ataque que bloqueia |
|---|---|---|
| CSP, HSTS, anti-clickjacking | `server.js` | XSS executando script injetado, downgrade para HTTP, seu app dentro de iframe falso |
| CORS com lista fixa | `server.js` | Site de terceiro chamando sua API com o cookie do usuário logado |
| Cookie `httpOnly` + `secure` + `sameSite` | `server.js` | Roubo de sessão por JavaScript e CSRF |
| Token CSRF | `server.js` | Formulário externo agindo em nome do usuário |
| Rate limit global + por rota | `server.js`, `rotas/index.js` | Força bruta de senha, raspagem do catálogo, estouro de custo de IA |
| `bodyLimit` 256 KB | `server.js` | Payload gigante derrubando memória |
| Erro sem stack trace | `server.js` | Vazamento de estrutura do banco e caminhos de arquivo |
| Zod em toda entrada | `rotas/index.js` | Injeção, tipo inesperado, campo malicioso |
| Query parametrizada `$1` | `rotas/index.js` | **SQL injection** |
| Argon2id nas senhas | `lib/cripto.js` | Quebra de hash em GPU |
| Hash falso no login | `rotas/index.js` | Descoberta de e-mails cadastrados por tempo de resposta |
| Bloqueio após 5 falhas | `rotas/index.js` | Força bruta direcionada |
| AES-256-GCM nos segredos | `lib/cripto.js` | Dump do banco entregando App Secret dos clientes |
| Sessão opaca no banco | `rotas/index.js` | Token que não pode ser revogado (problema do JWT) |
| `usuarioId` só da sessão | `middlewares/auth.js` | **IDOR** — ler dados de outro cliente trocando um id |
| `itemId` só de dígitos | `rotas/index.js` | **SSRF** por URL arbitrária na geração de imagem |
| Imagem só do CDN da Shopee | `rotas/index.js` | Injeção de URL de rastreamento no seu catálogo |
| `FOR UPDATE` no crédito | `rotas/index.js` | Corrida gastando mais crédito do que o plano tem |
| HMAC no webhook | `middlewares/auth.js` | "Pagamento aprovado" falso liberando plano de graça |
| Env validado na subida | `lib/env.js` | Produção rodando com segredo vazio |

---

## Os 5 riscos que mais derrubam SaaS de afiliado

### 1. Chave de API no navegador
Hoje o protótipo tem `CHAVE_IA_PADRAO` no front. **Isso não pode ir para produção.**
Qualquer pessoa abre o DevTools, copia e usa sua cota — você paga a conta.

A rota `/api/ia/influenciadora` já resolve: o front pede, o backend chama o Gemini com a chave
que só existe no servidor.

### 2. Custo de IA sem teto
Sem limite, um usuário gera 500 imagens e você recebe a fatura. Já está travado por
crédito com transação, mas configure também **orçamento com alerta no Google Cloud**.

### 3. Raspagem do seu catálogo
Seu catálogo curado é o ativo. Sem paginação e rate limit, um concorrente baixa tudo numa
requisição. Já está limitado a 24 por página e 120 req/min.

### 4. Vazamento do App Secret dos clientes
Se um cliente confiar o App Secret dele a você e vazar, ele perde a conta de afiliado e você
responde por isso. Está cifrado em AES-256-GCM com chave fora do banco.

### 5. LGPD
Você guarda e-mail, nome e dados de comissão de brasileiros. Precisa de:
- Política de privacidade publicada
- Base legal (execução de contrato) documentada
- Rota de exclusão de conta que apaga de verdade
- Registro de quem acessou o quê

---

## Antes de abrir para o público

- [ ] Mover `CHAVE_IA_PADRAO` do front para o `.env` do backend
- [ ] Gerar segredos reais: `openssl rand -base64 48` (cookie, JWT) e `openssl rand -hex 32` (crypto)
- [ ] `.env` no `.gitignore` — segredo commitado é segredo vazado
- [ ] HTTPS obrigatório, redirect de HTTP
- [ ] Backup automático do Postgres com restauração testada
- [ ] `npm audit` no CI, falhando em vulnerabilidade alta
- [ ] Dependabot ligado no repositório
- [ ] Log sem senha, sem token e sem dado pessoal
- [ ] 2FA nas contas de Vercel, Supabase, Google Cloud e domínio
- [ ] Alerta de orçamento no Google Cloud
- [ ] Política de privacidade e termos publicados
- [ ] Rota de exclusão de conta funcionando

---

## Schema mínimo com as travas

```sql
CREATE TABLE usuarios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  senha_hash    text NOT NULL,
  nome          text NOT NULL,
  plano         text NOT NULL DEFAULT 'free',
  ativo         boolean NOT NULL DEFAULT true,
  falhas        int NOT NULL DEFAULT 0,
  bloqueado_ate timestamptz,
  criado_em     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessoes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token_hash  text UNIQUE NOT NULL,          -- só o hash, nunca o token
  expira_em   timestamptz NOT NULL
);
CREATE INDEX ON sessoes (expira_em);

CREATE TABLE contas_shopee (
  usuario_id         uuid PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  app_id             text NOT NULL,
  app_secret_cifrado text NOT NULL           -- AES-256-GCM
);

CREATE TABLE assinaturas (
  usuario_id uuid PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  plano      text NOT NULL,
  creditos   int  NOT NULL DEFAULT 0,
  renova_em  timestamptz
);

CREATE TABLE produtos (
  item_id        text PRIMARY KEY,
  shop_id        text,
  nome           text NOT NULL,
  imagem         text,
  preco          numeric(10,2),
  preco_de       numeric(10,2),
  comissao       numeric(5,2),
  vendas         bigint,
  categoria      text,
  ativo          boolean NOT NULL DEFAULT true,
  origem_usuario uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON produtos (categoria) WHERE ativo;
```

> `ON DELETE CASCADE` faz a exclusão de conta apagar sessão, credencial e assinatura junto.
> É o que torna o "direito ao esquecimento" da LGPD viável sem script manual.

---

## Rodar

```bash
cd backend
npm install
cp .env.exemplo .env      # preencha os segredos
npm run dev
```

Dependências: `fastify @fastify/helmet @fastify/cors @fastify/rate-limit @fastify/cookie
@fastify/csrf-protection zod argon2 pg pino`
