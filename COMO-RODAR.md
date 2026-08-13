# Backend AfiliaPro — como rodar

## Local, agora (sem instalar banco)

```bash
cd backend
npm install
npm run dev
```

Sobe em `http://localhost:3333` usando **PGlite** — Postgres compilado em WASM,
rodando dentro do Node. Sem Docker, sem instalar Postgres.

Para os dados persistirem entre reinícios, defina uma pasta:

```bash
PGLITE_DIR=./.dados npm run dev
```

Sem isso o banco é em memória e zera a cada restart (bom para teste, ruim para uso).

## Produção

Preencha `DATABASE_URL` no `.env` apontando para um Postgres de verdade
(Supabase, Neon, RDS). O código troca de driver sozinho — **o SQL é o mesmo**.

Antes de subir, gere os segredos:

```bash
openssl rand -base64 48   # COOKIE_SECRET
openssl rand -hex 32      # CRYPTO_KEY
```

O servidor **se recusa a subir** em produção com segredo padrão ou sem `DATABASE_URL`.

## Rotas

| Método | Rota | O que faz |
|---|---|---|
| POST | `/api/auth/cadastro` | Cria conta e abre sessão |
| POST | `/api/auth/login` | Autentica |
| GET | `/api/auth/eu` | Quem está logado (o front chama ao abrir) |
| POST | `/api/auth/sair` | Encerra a sessão |
| POST | `/api/auth/senha` | Troca senha e derruba todas as sessões |
| GET | `/api/catalogo` | Produtos, paginado |
| GET | `/api/estruturas` | Estruturas do usuário |
| POST | `/api/estruturas` | Salva uma estrutura nova |
| GET | `/api/dashboard` | Faturamento real, somado do banco |
| POST | `/api/shopee/conta` | Salva credenciais (cifradas) |
| POST | `/api/catalogo/importar` | Recebe produtos da extensão |
| GET | `/saude` | Diz se está no ar e qual banco |

## Testado de ponta a ponta

Cadastro, login, sessão por cookie, 401 sem cookie, e-mail duplicado, senha errada,
bloqueio por tentativas, criação e listagem de estrutura, dashboard somando do banco,
tentativa de SQL injection no filtro (tabela intacta) e logout invalidando a sessão.

## Front

O `AfiliaPro.jsx` aponta para `http://localhost:3999` na constante `API`.
Ajuste para a URL de produção antes do deploy.

Com o backend no ar, o app **exige login**. Sem backend, abre em modo demonstração
com dados de exemplo — útil para mostrar o produto sem subir nada.
