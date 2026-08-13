/* ==================================================================
   ENTREGA AUTOMÁTICA — webhook da Wiven

   Fluxo: pessoa paga no checkout → Wiven chama esta rota →
   a conta é criada com o e-mail da compra e a senha padrão →
   o cliente entra no app e é obrigado a criar a senha dele.

   Três cuidados que não são opcionais aqui:

   1. SEGREDO. A rota é pública (a Wiven precisa alcançar), então
      sem segredo qualquer pessoa cria conta liberada de graça.
      Comparação em tempo constante para não vazar o segredo por
      diferença de tempo de resposta.

   2. IDEMPOTÊNCIA. Gateway reenvia webhook quando dá timeout.
      Guardamos o id da transação: o segundo envio não duplica nada.

   3. SENHA PROVISÓRIA. A senha padrão é conveniente para o cliente
      entrar, e é exatamente por isso que ela não pode ficar: quem
      souber o e-mail de um cliente entraria na conta dele. Marcamos
      como provisória e o app exige troca no primeiro acesso.
================================================================== */

import crypto from "node:crypto";
import { z } from "zod";
import { db } from "../lib/db.js";
import { hashSenha, iguaisEmTempoConstante } from "../lib/cripto.js";
import { env } from "../lib/env.js";

/* Combinada com o cliente: e-mail do checkout + estes 8 dígitos. */
export const SENHA_PADRAO = "12345678";

/* Códigos das ofertas criadas na Wiven. */
const PLANO_POR_OFERTA = {
  "5FX6U4G": "vitalicio",
  ERJGAHB: "mensal",
};

/* A Wiven muda nome de campo entre versões; aceitamos os apelidos
   mais comuns em vez de quebrar a entrega por causa de um rótulo. */
function extrair(corpo) {
  const c = corpo || {};
  const d = c.data || c.payload || c;
  const cli = d.customer || d.cliente || d.buyer || {};

  const email = (cli.email || d.email || d.customer_email || "").toString().trim().toLowerCase();
  const nome = (cli.name || cli.nome || d.name || d.customer_name || "").toString().trim();
  const oferta = (d.offer_code || d.offer || d.oferta || d.offerCode ||
    (d.offer && d.offer.code) || "").toString().trim().toUpperCase();
  const transacao = (d.id || d.transaction_id || d.order_id || d.transactionId || "").toString().trim();
  const status = (d.status || c.status || c.event || c.type || "").toString().toLowerCase();

  return { email, nome, oferta, transacao, status };
}

const PAGO = /paid|approved|aprovad|complet|confirmad|succe/;

export async function rotasWebhook(app) {
  app.post("/api/webhook/wiven", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    /* ---------- 1. segredo ---------- */
    const enviado =
      req.headers["x-wiven-token"] ||
      req.headers["x-webhook-secret"] ||
      (req.query && req.query.chave) || "";

    if (!env.WIVEN_WEBHOOK_SEGREDO ||
        !iguaisEmTempoConstante(String(enviado), env.WIVEN_WEBHOOK_SEGREDO)) {
      req.log.warn({ ip: req.ip }, "webhook com segredo inválido");
      return reply.status(401).send({ erro: "nao autorizado" });
    }

    /* ---------- 2. leitura ---------- */
    const { email, nome, oferta, transacao, status } = extrair(req.body);

    /* Devolvemos 200 mesmo quando ignoramos: 4xx faz o gateway
       reenviar para sempre e enche o log de ruído. */
    if (!PAGO.test(status)) return { ok: true, ignorado: "status nao pago", status };
    if (!z.string().email().safeParse(email).success)
      return { ok: true, ignorado: "sem e-mail valido" };

    const plano = PLANO_POR_OFERTA[oferta] || "mensal";

    /* ---------- 3. idempotência ---------- */
    if (transacao) {
      const { rows } = await db.query(`SELECT 1 FROM compras WHERE transacao = $1`, [transacao]);
      if (rows.length) return { ok: true, repetido: true };
    }

    /* ---------- 4. conta ---------- */
    const hash = await hashSenha(SENHA_PADRAO);
    const id = crypto.randomUUID();

    const { rows: u } = await db.query(
      `INSERT INTO usuarios (id, email, senha_hash, nome, plano, senha_provisoria)
       VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (email) DO UPDATE
         SET plano = EXCLUDED.plano, ativo = true
       RETURNING id, (xmax = 0) AS nova`,
      [id, email, hash, nome || email.split("@")[0], plano]
    );
    const usuarioId = u[0].id;

    await db.query(
      `INSERT INTO assinaturas (usuario_id, plano, creditos, renova_em)
       VALUES ($1, $2, $3, CASE WHEN $2 = 'mensal' THEN now() + interval '30 days' END)
       ON CONFLICT (usuario_id) DO UPDATE
         SET plano = EXCLUDED.plano, creditos = EXCLUDED.creditos, renova_em = EXCLUDED.renova_em`,
      [usuarioId, plano, plano === "vitalicio" ? 300 : 100]
    );

    await db.query(
      `INSERT INTO compras (id, usuario_id, transacao, oferta, plano, email)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (transacao) DO NOTHING`,
      [crypto.randomUUID(), usuarioId, transacao || crypto.randomUUID(), oferta, plano, email]
    );

    req.log.info({ email, plano, nova: u[0].nova }, "acesso liberado pelo webhook");
    return { ok: true, plano, novaConta: !!u[0].nova };
  });

  /* Conferência manual: "esse e-mail já tem acesso?" — sem expor senha
     nem listar a base inteira. Exige o mesmo segredo. */
  app.get("/api/webhook/wiven/conferir", async (req, reply) => {
    const chave = (req.query && req.query.chave) || "";
    if (!env.WIVEN_WEBHOOK_SEGREDO ||
        !iguaisEmTempoConstante(String(chave), env.WIVEN_WEBHOOK_SEGREDO))
      return reply.status(401).send({ erro: "nao autorizado" });

    const email = String((req.query && req.query.email) || "").trim().toLowerCase();
    const { rows } = await db.query(
      `SELECT email, plano, senha_provisoria, criado_em FROM usuarios WHERE email = $1`, [email]);
    return { encontrado: rows.length > 0, usuario: rows[0] || null };
  });
}
