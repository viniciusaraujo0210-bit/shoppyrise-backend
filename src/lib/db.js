/* ==================================================================
   Banco de dados.

   Produção  → Postgres de verdade (Supabase, Neon, RDS) via `pg`.
   Local     → PGlite: o mesmo Postgres compilado em WASM, rodando
               dentro do Node. Sem instalar nada, sem Docker.

   O SQL é idêntico nos dois. Você desenvolve local e sobe sem
   reescrever query nenhuma.
================================================================== */

import { env, producao } from "./env.js";

let impl;

if (env.DATABASE_URL) {
  const { Pool } = await import("pg");
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    /* rejectUnauthorized:false porque o Postgres interno do Railway (e de
       várias outras hospedagens) usa certificado autoassinado — a conexão
       já roda dentro da rede privada deles, então isso é seguro aqui. */
    ssl: producao ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  impl = {
    query: (texto, params) => pool.query(texto, params),
    exec: (texto) => pool.query(texto),          // migração multi-comando
    conectar: () => pool.connect(),
    fechar: () => pool.end(),
  };
} else {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(process.env.PGLITE_DIR || "memory://");        // memory:// = testes; caminho de pasta = persiste em disco
  impl = {
    query: async (texto, params = []) => pg.query(texto, params),
    exec: (texto) => pg.exec(texto),             // PGlite exige exec() para vários comandos
    /* PGlite é single-connection; BEGIN/COMMIT funcionam igual */
    conectar: async () => ({
      query: (t, p = []) => pg.query(t, p),
      release: () => {},
    }),
    fechar: () => pg.close(),
  };
}

export const db = impl;

/* Migração idempotente: roda toda subida, cria o que faltar. */
export async function migrar() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id            text PRIMARY KEY,
      email         text UNIQUE NOT NULL,
      senha_hash    text NOT NULL,
      nome          text NOT NULL,
      plano         text NOT NULL DEFAULT 'free',
      ativo         boolean NOT NULL DEFAULT true,
      falhas        int NOT NULL DEFAULT 0,
      demo          boolean NOT NULL DEFAULT false,
      bloqueado_ate timestamptz,
      criado_em     timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sessoes (
      id         text PRIMARY KEY,
      usuario_id text NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      token_hash text UNIQUE NOT NULL,
      expira_em  timestamptz NOT NULL,
      criado_em  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS assinaturas (
      usuario_id text PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
      plano      text NOT NULL DEFAULT 'free',
      creditos   int  NOT NULL DEFAULT 10,
      renova_em  timestamptz
    );

    CREATE TABLE IF NOT EXISTS contas_shopee (
      usuario_id         text PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
      app_id             text,
      app_secret_cifrado text,
      id_afiliado        text
    );

    CREATE TABLE IF NOT EXISTS produtos (
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
      origem_usuario text,
      atualizado_em  timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS estruturas (
      id          text PRIMARY KEY,
      usuario_id  text NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      item_id     text NOT NULL,
      link        text,
      tem_video   boolean NOT NULL DEFAULT false,
      grupos      int NOT NULL DEFAULT 0,
      cliques     int NOT NULL DEFAULT 0,
      conversoes  int NOT NULL DEFAULT 0,
      receita     numeric(10,2) NOT NULL DEFAULT 0,
      criado_em   timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS demo boolean NOT NULL DEFAULT false;
    ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS senha_provisoria boolean NOT NULL DEFAULT false;

    /* Registro de compra. Serve para dois fins: não processar o mesmo
       webhook duas vezes, e responder "quando essa pessoa comprou?". */
    CREATE TABLE IF NOT EXISTS compras (
      id         text PRIMARY KEY,
      usuario_id text NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      transacao  text UNIQUE NOT NULL,
      oferta     text,
      plano      text NOT NULL,
      email      text NOT NULL,
      criado_em  timestamptz NOT NULL DEFAULT now()
    );

    /* Cota diária de geração de influenciadora (IA). Uma linha por
       usuário por dia — conta demo nunca grava aqui, então nunca
       esbarra em limite. Cliente real: 10 por dia, contadas só nas
       gerações que deram certo (tentativa que falhou não gasta cota). */
    CREATE TABLE IF NOT EXISTS geracoes_ia_dia (
      usuario_id text NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      dia        date NOT NULL DEFAULT current_date,
      contagem   int  NOT NULL DEFAULT 0,
      PRIMARY KEY (usuario_id, dia)
    );

    /* Um afiliado = uma rota própria (shoppyrise.online/<slug>) com
       os links de checkout dele. Ver src/rotas/afiliados.js. */
    CREATE TABLE IF NOT EXISTS afiliados (
      id             text PRIMARY KEY,
      nome           text NOT NULL,
      email          text NOT NULL,
      telefone       text,
      slug           text UNIQUE NOT NULL,
      link_mensal    text NOT NULL,
      link_vitalicio text NOT NULL,
      ativo          boolean NOT NULL DEFAULT true,
      criado_em      timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS ix_sessoes_expira ON sessoes (expira_em);
    CREATE INDEX IF NOT EXISTS ix_estruturas_user ON estruturas (usuario_id, criado_em DESC);
    CREATE INDEX IF NOT EXISTS ix_produtos_cat ON produtos (categoria);
    CREATE INDEX IF NOT EXISTS ix_afiliados_ativo ON afiliados (ativo);
  `);
}

/* Sessões vencidas viram lixo e superfície de risco. Limpa a cada hora. */
export function limparSessoes() {
  setInterval(() => {
    db.query(`DELETE FROM sessoes WHERE expira_em < now()`).catch(() => {});
  }, 60 * 60 * 1000).unref();
}
