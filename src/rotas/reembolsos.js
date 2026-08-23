/* ==================================================================
   Rotas de reembolso — o cliente preenche um formulário público (sem
   login) contando qual compra quer cancelar; a gente guarda o pedido
   pra você revisar e processar o reembolso manualmente no gateway.

   Essa rota NÃO processa o reembolso sozinha — ela só registra o
   pedido. Processar de fato (estornar o valor) continua sendo feito
   por você na Applyfy, porque é lá que o dinheiro está.

   Duas coisas que essa rota impede, de propósito:

   1. SPAM DE PEDIDO. Rate limit generoso mas real — sem ele, alguém
      podia inundar sua fila de reembolso com lixo.

   2. DADO SENSÍVEL DEMAIS. Só aceita os 4 últimos dígitos do cartão
      (é o bastante pra você achar a transação) — nunca o número
      completo, nunca CVV, nunca validade. Se algum dia o formulário
      mandar mais que isso, é bug, não recurso.
================================================================== */

import crypto from "node:crypto";
import { z } from "zod";
import { db } from "../lib/db.js";
import { iguaisEmTempoConstante } from "../lib/cripto.js";
import { env } from "../lib/env.js";

const CPF = z.string().trim().regex(/^\d{11}$|^\d{3}\.\d{3}\.\d{3}-\d{2}$/, "CPF inválido");

export async function rotasReembolsos(app) {
  /* ---------------- pedido ----------------
     Público — o próprio cliente preenche. */
  app.post("/api/reembolsos", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const p = z.object({
      nome: z.string().trim().min(2).max(120),
      email: z.string().trim().toLowerCase().email(),
      telefone: z.string().trim().min(8).max(30),
      cpf: CPF,
      pedido: z.string().trim().min(1).max(60),
      produto: z.string().trim().min(1).max(160),
      dataCompra: z.string().trim().min(1).max(20),
      valor: z.coerce.number().positive().max(100000),
      formaPagamento: z.enum(["Pix", "Cartão de crédito", "Cartão de débito", "Boleto"]),
      ultimosDigitos: z.string().trim().regex(/^\d{4}$/).optional().or(z.literal("")),
      motivo: z.enum([
        "Não era o que eu esperava",
        "Achei caro / encontrei mais barato",
        "Comprei por engano",
        "Tive dificuldade de usar",
        "Não preciso mais",
        "Outro",
      ]),
      detalhe: z.string().trim().max(1000).optional().or(z.literal("")),
      tentouSuporte: z.enum(["Sim", "Não"]),
    }).safeParse(req.body);

    if (!p.success) {
      return reply.status(400).send({ erro: p.error.issues[0]?.message || "Dados inválidos." });
    }

    const d = p.data;
    await db.query(
      `INSERT INTO reembolsos
         (id, nome, email, telefone, cpf, pedido, produto, data_compra, valor,
          forma_pagamento, ultimos_digitos, motivo, detalhe, tentou_suporte)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        crypto.randomUUID(), d.nome, d.email, d.telefone, d.cpf.replace(/\D/g, ""),
        d.pedido, d.produto, d.dataCompra, d.valor, d.formaPagamento,
        d.ultimosDigitos || null, d.motivo, d.detalhe || null, d.tentouSuporte === "Sim",
      ]
    );

    req.log.info({ email: d.email, pedido: d.pedido }, "novo pedido de reembolso");
    return { ok: true };
  });

  /* ---------------- lista (só você) ----------------
     Mesma chave do webhook — não criei segredo novo pra não
     multiplicar coisa pra guardar em produção. */
  app.get("/api/reembolsos", async (req, reply) => {
    const chave = (req.query && req.query.chave) || "";
    if (!env.WIVEN_WEBHOOK_SEGREDO || !iguaisEmTempoConstante(String(chave), env.WIVEN_WEBHOOK_SEGREDO)) {
      return reply.status(401).send({ erro: "nao autorizado" });
    }

    const { rows } = await db.query(
      `SELECT id, nome, email, telefone, cpf, pedido, produto, data_compra, valor,
              forma_pagamento, ultimos_digitos, motivo, detalhe, tentou_suporte,
              status, criado_em
         FROM reembolsos ORDER BY criado_em DESC`
    );
    return { reembolsos: rows };
  });

  /* ---------------- status (só você) ----------------
     Marca o pedido como resolvido depois que você processa (ou
     recusa) o estorno na Applyfy. Só muda o rótulo aqui dentro —
     não mexe em dinheiro nenhum. */
  app.patch("/api/reembolsos/:id", async (req, reply) => {
    const chave = (req.query && req.query.chave) || "";
    if (!env.WIVEN_WEBHOOK_SEGREDO || !iguaisEmTempoConstante(String(chave), env.WIVEN_WEBHOOK_SEGREDO)) {
      return reply.status(401).send({ erro: "nao autorizado" });
    }

    const p = z.object({ status: z.enum(["pendente", "aprovado", "negado"]) }).safeParse(req.body);
    if (!p.success) return reply.status(400).send({ erro: "Envie { status: 'pendente'|'aprovado'|'negado' }." });

    const { rowCount } = await db.query(
      `UPDATE reembolsos SET status = $2 WHERE id = $1`,
      [req.params.id, p.data.status]
    );
    if (!rowCount) return reply.status(404).send({ erro: "Pedido não encontrado." });
    return { ok: true };
  });
}
