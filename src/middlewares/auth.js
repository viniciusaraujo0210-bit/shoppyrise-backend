/* ==================================================================
   Autenticação e autorização.

   Regra que evita a falha mais comum de SaaS (IDOR): o usuário nunca
   informa QUEM ele é. Isso vem sempre da sessão. Se uma rota aceitar
   ?usuario_id= vindo do cliente, qualquer um lê os dados de qualquer um.
================================================================== */

import crypto from "node:crypto";
import { db } from "../lib/db.js";

export async function autenticado(req, reply) {
  const token = req.cookies?.sid;
  if (!token) return reply.status(401).send({ erro: "Não autenticado." });

  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const { rows } = await db.query(
    `SELECT s.usuario_id, u.plano, u.ativo, u.demo
       FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token_hash = $1 AND s.expira_em > now()`,
    [hash]
  );

  const s = rows[0];
  if (!s || !s.ativo) {
    reply.clearCookie("sid", { path: "/" });
    return reply.status(401).send({ erro: "Sessão expirada." });
  }

  req.usuarioId = s.usuario_id;   // fonte única da verdade
  req.plano = s.plano;
  req.demo = s.demo === true;
  req.sessaoHash = hash;
}

export const exigePlano = (planos) => async (req, reply) => {
  if (!planos.includes(req.plano))
    return reply.status(403).send({ erro: "Recurso não incluído no seu plano." });
};

/* Webhook de pagamento: sem verificação de assinatura, qualquer pessoa
   manda "pagamento aprovado" e libera plano de graça. */
export function validarWebhook(segredo) {
  return async (req, reply) => {
    const recebida = req.headers["x-signature"] || "";
    const esperada = crypto
      .createHmac("sha256", segredo)
      .update(JSON.stringify(req.body))
      .digest("hex");
    const a = Buffer.from(String(recebida));
    const b = Buffer.from(esperada);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return reply.status(401).send({ erro: "Assinatura inválida." });
  };
}
