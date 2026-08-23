/* ==================================================================
   Rotas de afiliados — cada afiliado ganha uma rota própria
   (shoppyrise.online/<slug>) que mostra a MESMA página de vendas,
   mas com os links de checkout DELE. Ele recebe o pagamento na
   conta de gateway que ele mesmo colocou; a gente nunca vê nem
   guarda credencial nenhuma, só a URL final do checkout.

   Duas coisas que essa rota impede, de propósito:

   1. SLUG ROUBADO. Nome de rota já usado por outro afiliado, ou por
      uma página real do site (afiliados, api, admin...), é recusado
      antes de gravar — senão o segundo cadastro pisa no primeiro,
      ou sequestra uma URL que o site já usa.

   2. LINK QUE NÃO É CHECKOUT. Só aceita link https. Não dá pra
      validar se a conta é de verdade (não temos acesso a ela, e não
      é nosso papel) — mas barra o óbvio: link vazio, http sem s, ou
      texto qualquer no lugar da URL.
================================================================== */

import crypto from "node:crypto";
import { z } from "zod";
import { db } from "../lib/db.js";
import { iguaisEmTempoConstante } from "../lib/cripto.js";
import { env } from "../lib/env.js";

/* Nomes que já são (ou podem vir a ser) página real do site, ou que
   colidiriam com uma rota do próprio sistema. */
const RESERVADOS = new Set([
  "afiliados", "afiliado", "api", "admin", "app", "login", "entrar",
  "planos", "sobre", "termos", "privacidade", "suporte", "index",
  "checkout", "webhook", "assets", "static", "favicon.ico", "robots.txt",
]);

const SLUG = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/, "use letras minúsculas, números e hífen");

const LINK = z.string().trim().url().startsWith("https://", "o link precisa começar com https://");

export async function rotasAfiliados(app) {
  /* ---------------- cadastro ----------------
     Público — o próprio afiliado preenche o formulário. */
  app.post("/api/afiliados", {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const p = z.object({
      nome: z.string().trim().min(2).max(120),
      email: z.string().trim().toLowerCase().email(),
      telefone: z.string().trim().max(30).optional(),
      slug: SLUG,
      linkMensal: LINK,
      linkVitalicio: LINK,
    }).safeParse(req.body);
    if (!p.success) {
      return reply.status(400).send({ erro: p.error.issues[0]?.message || "Dados inválidos." });
    }

    const { nome, email, telefone, slug, linkMensal, linkVitalicio } = p.data;
    if (RESERVADOS.has(slug)) {
      return reply.status(409).send({ erro: "Esse nome de rota não está disponível." });
    }

    const { rows: existe } = await db.query(`SELECT 1 FROM afiliados WHERE slug = $1`, [slug]);
    if (existe.length) return reply.status(409).send({ erro: "Esse nome de rota já está em uso." });

    await db.query(
      `INSERT INTO afiliados (id, nome, email, telefone, slug, link_mensal, link_vitalicio)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [crypto.randomUUID(), nome, email, telefone || null, slug, linkMensal, linkVitalicio]
    );

    req.log.info({ slug, email }, "novo afiliado cadastrado");
    return { ok: true, link: `https://shoppyrise.online/${slug}` };
  });

  /* ---------------- leitura pública ----------------
     A página de vendas chama isso pra saber se a rota que o
     visitante abriu é de um afiliado. Devolve só o que a página
     precisa pra trocar os botões — nunca e-mail nem telefone. */
  app.get("/api/afiliados/:slug", async (req) => {
    const p = SLUG.safeParse(req.params.slug);
    if (!p.success) return { encontrado: false };

    const { rows } = await db.query(
      `SELECT nome, link_mensal, link_vitalicio FROM afiliados WHERE slug = $1 AND ativo = true`,
      [p.data]
    );
    if (!rows.length) return { encontrado: false };
    return {
      encontrado: true,
      nome: rows[0].nome,
      linkMensal: rows[0].link_mensal,
      linkVitalicio: rows[0].link_vitalicio,
    };
  });

  /* ---------------- lista (só você) ----------------
     Mesma chave do webhook — não criei segredo novo pra não
     multiplicar coisa pra guardar em produção. */
  app.get("/api/afiliados", async (req, reply) => {
    const chave = (req.query && req.query.chave) || "";
    if (!env.WIVEN_WEBHOOK_SEGREDO || !iguaisEmTempoConstante(String(chave), env.WIVEN_WEBHOOK_SEGREDO)) {
      return reply.status(401).send({ erro: "nao autorizado" });
    }

    const { rows } = await db.query(
      `SELECT nome, email, telefone, slug, link_mensal, link_vitalicio, ativo, criado_em
         FROM afiliados ORDER BY criado_em DESC`
    );
    return { afiliados: rows };
  });

  /* ---------------- ativar / desativar (só você) ----------------
     Pra tirar a rota do ar sem apagar o cadastro — histórico e
     comissões já pagas continuam no banco, só a página para de
     responder por esse afiliado. */
  app.patch("/api/afiliados/:slug", async (req, reply) => {
    const chave = (req.query && req.query.chave) || "";
    if (!env.WIVEN_WEBHOOK_SEGREDO || !iguaisEmTempoConstante(String(chave), env.WIVEN_WEBHOOK_SEGREDO)) {
      return reply.status(401).send({ erro: "nao autorizado" });
    }

    const p = z.object({ ativo: z.boolean() }).safeParse(req.body);
    if (!p.success) return reply.status(400).send({ erro: "Envie { ativo: true|false }." });

    const { rowCount } = await db.query(
      `UPDATE afiliados SET ativo = $2 WHERE slug = $1`,
      [req.params.slug, p.data.ativo]
    );
    if (!rowCount) return reply.status(404).send({ erro: "Afiliado não encontrado." });
    return { ok: true };
  });
}
