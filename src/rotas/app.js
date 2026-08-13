/* ==================================================================
   Rotas do app — catálogo, estruturas, dashboard.
   Tudo exige sessão. O usuarioId vem SEMPRE da sessão, nunca do
   corpo ou da query — é o que impede um cliente ler dados de outro.
================================================================== */

import crypto from "node:crypto";
import { z } from "zod";
import { db } from "../lib/db.js";
import { autenticado } from "../middlewares/auth.js";
import { cifrar } from "../lib/cripto.js";

/* ------------------------------------------------------------------
   Dados de demonstração — apenas em contas marcadas como demo.
   Toda conta de cliente começa zerada e preenche só com venda real.
------------------------------------------------------------------ */
const SERIE_DEMO = [820, 1150, 940, 1380, 1210, 1620, 1490,
                    1680, 1950, 1740, 2280, 2050, 2840, 2140];

/* Semana e mês são SOMADOS da própria série, para o gráfico e os
   cartões nunca se contradizerem. */
function DADOS_DEMO() {
  const hoje = new Date();
  const serie = SERIE_DEMO.map((v, i) => {
    const d = new Date(hoje); d.setDate(hoje.getDate() - (13 - i));
    return {
      d: `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`,
      v,
      _mes: d.getMonth() === hoje.getMonth(),
    };
  });

  const soma = (arr) => arr.reduce((s, x) => s + x.v, 0);
  const semana = soma(serie.slice(-7));
  const mes = soma(serie.filter((x) => x._mes));
  const doDia = serie[serie.length - 1].v;

  return {
    resumo: {
      hoje: doDia, semana, mes,
      cliques: 96400, vendas: 812, estruturas: 34,
    },
    serie: serie.map(({ d, v }) => ({ d, v })),
    canais: [
      { canal: "WhatsApp", v: Math.round(mes * 0.45) },
      { canal: "Facebook", v: Math.round(mes * 0.29) },
      { canal: "Instagram", v: Math.round(mes * 0.17) },
      { canal: "TikTok", v: Math.round(mes * 0.09) },
    ],
  };
}

const ESTRUTURAS_DEMO = [
  { id: "d1", item_id: "11244649617", nome: "Kit Tratamento 3 Meses Forever Hair", link: "https://s.shopee.com.br/8f2aK1x", tem_video: true, grupos: 12, cliques: 1420, conversoes: 61, receita: "512.30", criado_em: new Date(Date.now() - 3 * 864e5) },
  { id: "d2", item_id: "22231489535", nome: "Corretivo Líquido MELU by Ruby Rose", link: "https://s.shopee.com.br/3c9dQ7m", tem_video: true, grupos: 9, cliques: 1080, conversoes: 54, receita: "398.70", criado_em: new Date(Date.now() - 5 * 864e5) },
  { id: "d3", item_id: "8199769256", nome: "Lola Rapunzel Tônico de Crescimento", link: "https://s.shopee.com.br/7b1eR4p", tem_video: false, grupos: 6, cliques: 740, conversoes: 28, receita: "241.60", criado_em: new Date(Date.now() - 7 * 864e5) },
  { id: "d4", item_id: "23997821333", nome: "Calça Legging Suplex Cós Alto", link: "https://s.shopee.com.br/2d5fZ9t", tem_video: true, grupos: 14, cliques: 960, conversoes: 43, receita: "334.90", criado_em: new Date(Date.now() - 2 * 864e5) },
];

export async function rotasApp(app) {
  /* ---------------- catálogo ----------------
     Paginado sempre. Sem LIMIT, um concorrente baixa sua base
     curada inteira numa requisição. */
  app.get("/api/catalogo", { preHandler: autenticado }, async (req, reply) => {
    const p = z.object({
      cat: z.string().max(40).optional(),
      busca: z.string().max(80).optional(),
      pagina: z.coerce.number().int().min(1).max(200).default(1),
      ordem: z.enum(["ganho", "comissao", "vendas", "barato"]).default("ganho"),
    }).safeParse(req.query);
    if (!p.success) return reply.status(400).send({ erro: "Parâmetros inválidos." });

    const { cat, busca, pagina, ordem } = p.data;
    const porPagina = 24;
    /* Whitelist de ORDER BY. Interpolar valor do cliente aqui seria
       injeção — por isso o mapa fixo. */
    const ordens = {
      ganho: "(preco * comissao / 100) DESC",
      comissao: "comissao DESC",
      vendas: "vendas DESC",
      barato: "preco ASC",
    };

    const { rows } = await db.query(
      `SELECT item_id, nome, imagem, preco, preco_de, comissao, vendas, categoria
         FROM produtos
        WHERE ativo = true
          AND ($1::text IS NULL OR categoria = $1)
          AND ($2::text IS NULL OR nome ILIKE '%' || $2 || '%')
        ORDER BY ${ordens[ordem]}
        LIMIT $3 OFFSET $4`,
      [cat ?? null, busca ?? null, porPagina, (pagina - 1) * porPagina]
    );
    return { produtos: rows, pagina };
  });

  /* ---------------- estruturas do usuário ---------------- */
  app.get("/api/estruturas", { preHandler: autenticado }, async (req) => {
    if (req.demo) return { demo: true, estruturas: ESTRUTURAS_DEMO };
    const { rows } = await db.query(
      `SELECT e.id, e.item_id, e.link, e.tem_video, e.grupos, e.cliques,
              e.conversoes, e.receita, e.criado_em,
              p.nome, p.imagem, p.preco, p.comissao
         FROM estruturas e LEFT JOIN produtos p ON p.item_id = e.item_id
        WHERE e.usuario_id = $1
        ORDER BY e.criado_em DESC LIMIT 100`,
      [req.usuarioId]
    );
    return { demo: false, estruturas: rows };
  });

  app.post("/api/estruturas", { preHandler: autenticado }, async (req, reply) => {
    const p = z.object({
      itemId: z.string().regex(/^\d{5,20}$/),
      link: z.string().url().max(300).startsWith("https://").optional(),
      temVideo: z.boolean().default(false),
      grupos: z.number().int().min(0).max(500).default(0),
    }).safeParse(req.body);
    if (!p.success) return reply.status(400).send({ erro: "Dados inválidos." });

    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO estruturas (id, usuario_id, item_id, link, tem_video, grupos)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, req.usuarioId, p.data.itemId, p.data.link ?? null, p.data.temVideo, p.data.grupos]
    );
    return { ok: true, id };
  });

  /* ---------------- dashboard ----------------
     Números vêm de SOMA REAL das estruturas do usuário.
     Nada de valor fixo no código. */
  app.get("/api/dashboard", { preHandler: autenticado }, async (req) => {
    /* Conta de demonstração: números de exemplo para apresentar o produto.
       Vem sempre marcada como demo, e a interface mostra o selo.
       Conta de cliente real: soma do banco, começando em zero. */
    if (req.demo) return { demo: true, ...DADOS_DEMO() };

    const { rows } = await db.query(
      `SELECT
         COALESCE(SUM(receita) FILTER (WHERE criado_em >= current_date), 0)::float            AS hoje,
         COALESCE(SUM(receita) FILTER (WHERE criado_em >= current_date - 6), 0)::float        AS semana,
         COALESCE(SUM(receita) FILTER (WHERE criado_em >= date_trunc('month', now())),0)::float AS mes,
         COALESCE(SUM(cliques), 0)::int     AS cliques,
         COALESCE(SUM(conversoes), 0)::int  AS vendas,
         COUNT(*)::int                      AS estruturas
       FROM estruturas WHERE usuario_id = $1`,
      [req.usuarioId]
    );

    const { rows: serie } = await db.query(
      `SELECT to_char(d.dia, 'DD/MM') AS d, COALESCE(SUM(e.receita), 0)::float AS v
         FROM generate_series(current_date - 13, current_date, interval '1 day') AS d(dia)
         LEFT JOIN estruturas e
           ON e.usuario_id = $1 AND e.criado_em::date = d.dia::date
        GROUP BY d.dia ORDER BY d.dia`,
      [req.usuarioId]
    );

    const { rows: canais } = await db.query(
      `SELECT 'WhatsApp' AS canal, 0::float AS v
       UNION ALL SELECT 'Facebook', 0 UNION ALL SELECT 'Instagram', 0 UNION ALL SELECT 'TikTok', 0`
    );

    return { demo: false, resumo: rows[0], serie, canais };
  });

  /* ---------------- credenciais Shopee ----------------
     Guardadas cifradas. A resposta nunca devolve o segredo. */
  app.post("/api/shopee/conta", { preHandler: autenticado }, async (req, reply) => {
    const p = z.object({
      idAfiliado: z.string().max(40).optional(),
      appId: z.string().max(40).optional(),
      appSecret: z.string().min(16).max(200).optional(),
    }).safeParse(req.body);
    if (!p.success) return reply.status(400).send({ erro: "Dados inválidos." });

    await db.query(
      `INSERT INTO contas_shopee (usuario_id, id_afiliado, app_id, app_secret_cifrado)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (usuario_id) DO UPDATE
         SET id_afiliado = COALESCE(EXCLUDED.id_afiliado, contas_shopee.id_afiliado),
             app_id      = COALESCE(EXCLUDED.app_id, contas_shopee.app_id),
             app_secret_cifrado = COALESCE(EXCLUDED.app_secret_cifrado, contas_shopee.app_secret_cifrado)`,
      [req.usuarioId, p.data.idAfiliado ?? null, p.data.appId ?? null,
       p.data.appSecret ? cifrar(p.data.appSecret) : null]
    );
    return { ok: true };
  });

  /* ---------------- importação pela extensão ----------------
     Entrada de terceiro = maior risco do sistema. */
  app.post("/api/catalogo/importar", {
    preHandler: autenticado,
    config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
  }, async (req, reply) => {
    const p = z.object({
      itens: z.array(z.object({
        itemId: z.string().regex(/^\d{5,20}$/),
        shopId: z.string().regex(/^\d{3,20}$/).optional(),
        nome: z.string().min(3).max(200),
        preco: z.number().positive().max(1_000_000).nullable().optional(),
        comissao: z.number().min(0).max(100).nullable().optional(),
        vendas: z.number().int().min(0).max(100_000_000).nullable().optional(),
        /* só o CDN da Shopee: impede injetar URL de rastreamento no seu catálogo */
        imagem: z.string().regex(/^https:\/\/[a-z0-9.-]*susercontent\.com\//).nullable().optional(),
        categoria: z.string().max(40).optional(),
      })).min(1).max(120),
    }).safeParse(req.body);
    if (!p.success) return reply.status(400).send({ erro: "Dados inválidos." });

    const limpo = (s) => s.replace(/[<>]/g, "").trim();
    for (const it of p.data.itens) {
      await db.query(
        `INSERT INTO produtos (item_id, shop_id, nome, preco, comissao, vendas, imagem, categoria, origem_usuario)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (item_id) DO UPDATE
           SET preco = EXCLUDED.preco, comissao = EXCLUDED.comissao,
               vendas = EXCLUDED.vendas, atualizado_em = now()`,
        [it.itemId, it.shopId ?? null, limpo(it.nome), it.preco ?? null, it.comissao ?? null,
         it.vendas ?? null, it.imagem ?? null, it.categoria ?? null, req.usuarioId]
      );
    }
    return { ok: true, importados: p.data.itens.length };
  });
}
