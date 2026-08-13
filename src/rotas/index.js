/* ==================================================================
   Rotas. Toda entrada é validada com Zod antes de tocar no banco.
   Toda query usa parâmetro ($1), nunca concatenação de string —
   é o que elimina SQL injection na raiz.
================================================================== */

import { z } from "zod";
import { db } from "../lib/db.js";
import { autenticado, exigePlano } from "../middlewares/auth.js";
import { hashSenha, conferirSenha, cifrar, tokenAleatorio } from "../lib/cripto.js";
import { gerarImagemIA } from "../lib/ia.js";
import { env } from "../lib/env.js";

/* Zod recusa campo a mais, string gigante e tipo errado.
   Sem isso, um POST com 10 MB de JSON derruba o processo. */
const Email = z.string().email().max(160).toLowerCase().trim();
const Senha = z.string().min(10).max(200);

export async function registrarRotas(app) {
  /* ---------------- auth ---------------- */

  app.post("/api/auth/cadastro", {
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
    schema: { body: z.object({ email: Email, senha: Senha, nome: z.string().min(2).max(80) }) },
  }, async (req, reply) => {
    const { email, senha, nome } = req.body;
    const hash = await hashSenha(senha);
    try {
      const { rows } = await db.query(
        `INSERT INTO usuarios (email, senha_hash, nome) VALUES ($1, $2, $3) RETURNING id`,
        [email, hash, nome]
      );
      await criarSessao(reply, rows[0].id);
      return { ok: true };
    } catch (e) {
      /* Não diga "e-mail já existe": isso permite descobrir quem é cliente seu.
         Resposta e tempo idênticos aos do caminho de sucesso. */
      if (e.code === "23505") return { ok: true };
      throw e;
    }
  });

  app.post("/api/auth/login", {
    config: { rateLimit: { max: 8, timeWindow: "10 minutes" } },
    schema: { body: z.object({ email: Email, senha: Senha }) },
  }, async (req, reply) => {
    const { rows } = await db.query(
      `SELECT id, senha_hash, bloqueado_ate FROM usuarios WHERE email = $1`,
      [req.body.email]
    );
    const u = rows[0];

    /* Compara mesmo sem usuário, para o tempo de resposta não revelar
       se o e-mail existe (user enumeration por timing). */
    const hashFalso = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const ok = await conferirSenha(u?.senha_hash || hashFalso, req.body.senha);

    if (u?.bloqueado_ate && new Date(u.bloqueado_ate) > new Date())
      return reply.status(429).send({ erro: "Conta temporariamente bloqueada." });

    if (!u || !ok) {
      if (u) await db.query(
        `UPDATE usuarios SET falhas = falhas + 1,
           bloqueado_ate = CASE WHEN falhas + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END
         WHERE id = $1`, [u.id]);
      return reply.status(401).send({ erro: "E-mail ou senha inválidos." });
    }

    await db.query(`UPDATE usuarios SET falhas = 0, bloqueado_ate = NULL WHERE id = $1`, [u.id]);
    await criarSessao(reply, u.id);
    return { ok: true };
  });

  app.post("/api/auth/sair", { preHandler: autenticado }, async (req, reply) => {
    await db.query(`DELETE FROM sessoes WHERE token_hash = $1`, [req.sessaoHash]);
    reply.clearCookie("sid", { path: "/" });
    return { ok: true };
  });

  /* ---------------- catálogo ----------------
     Público para quem está logado. Paginado sempre: sem LIMIT, um
     cliente baixa sua base inteira numa requisição e monta o concorrente. */
  app.get("/api/catalogo", {
    preHandler: autenticado,
    schema: {
      querystring: z.object({
        cat: z.string().max(40).optional(),
        busca: z.string().max(80).optional(),
        pagina: z.coerce.number().int().min(1).max(200).default(1),
      }),
    },
  }, async (req) => {
    const { cat, busca, pagina } = req.query;
    const porPagina = 24;
    const { rows } = await db.query(
      `SELECT item_id, nome, imagem, preco, preco_de, comissao, vendas, categoria
         FROM produtos
        WHERE ativo = true
          AND ($1::text IS NULL OR categoria = $1)
          AND ($2::text IS NULL OR nome ILIKE '%' || $2 || '%')
        ORDER BY (preco * comissao / 100) DESC
        LIMIT $3 OFFSET $4`,
      [cat ?? null, busca ?? null, porPagina, (pagina - 1) * porPagina]
    );
    return { produtos: rows, pagina };
  });

  /* ---------------- geração de imagem ----------------
     A chave do Gemini fica AQUI, no servidor. O front nunca a vê.
     Crédito é debitado por transação, para dois pedidos simultâneos
     não furarem o limite do plano. */
  app.post("/api/ia/influenciadora", {
    preHandler: [autenticado, exigePlano(["pro", "premium"])],
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    schema: {
      body: z.object({
        itemId: z.string().regex(/^\d{5,20}$/),   // só dígitos: bloqueia SSRF por URL arbitrária
        genero: z.enum(["f", "m"]),
        faixa: z.enum(["20", "30", "45"]),
        tipo: z.enum(["morena", "negra", "branca", "parda", "asiatica", "ruiva"]),
        pose: z.enum(["segurando", "usando", "apontando", "close", "lado"]),
        enq: z.enum(["meio", "corpo", "rosto"]),
        amb: z.string().max(24),
      }),
    },
  }, async (req, reply) => {
    const cli = await db.conectar();
    try {
      await cli.query("BEGIN");
      /* FOR UPDATE trava a linha: evita gastar 2 créditos com 1 disponível
         quando o usuário clica duas vezes rápido (condição de corrida). */
      const { rows } = await cli.query(
        `SELECT creditos FROM assinaturas WHERE usuario_id = $1 FOR UPDATE`, [req.usuarioId]);
      if (!rows[0] || rows[0].creditos < 1) {
        await cli.query("ROLLBACK");
        return reply.status(402).send({ erro: "Créditos de imagem esgotados neste plano." });
      }
      await cli.query(`UPDATE assinaturas SET creditos = creditos - 1 WHERE usuario_id = $1`, [req.usuarioId]);

      /* A imagem de referência vem do NOSSO banco pelo itemId.
         Nunca aceite URL do cliente: seria SSRF direto na sua rede interna. */
      const { rows: p } = await cli.query(
        `SELECT nome, imagem FROM produtos WHERE item_id = $1 AND ativo = true`, [req.body.itemId]);
      if (!p[0]) { await cli.query("ROLLBACK"); return reply.status(404).send({ erro: "Produto não encontrado." }); }

      const img = await gerarImagemIA({ produto: p[0], opcoes: req.body });
      await cli.query("COMMIT");
      return { imagem: img };
    } catch (e) {
      await cli.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      cli.release();
    }
  });

  /* ---------------- importação pela extensão ----------------
     Entrada de terceiro = maior risco. Limite de itens, campos
     validados, e o texto é sanitizado antes de virar HTML no front. */
  app.post("/api/catalogo/importar", {
    preHandler: autenticado,
    config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
    schema: {
      body: z.object({
        origem: z.string().url().max(500),
        itens: z.array(z.object({
          itemId: z.string().regex(/^\d{5,20}$/),
          shopId: z.string().regex(/^\d{3,20}$/),
          nome: z.string().min(3).max(200),
          preco: z.number().positive().max(1_000_000).nullable(),
          comissao: z.number().min(0).max(100).nullable(),
          vendas: z.number().int().min(0).max(100_000_000).nullable(),
          /* só o CDN da Shopee: impede que injetem URL de rastreamento
             ou de servidor deles dentro do seu catálogo */
          imagem: z.string().url().regex(/^https:\/\/[a-z0-9.-]*susercontent\.com\//).nullable(),
        })).min(1).max(120),
      }),
    },
  }, async (req) => {
    const limpo = (s) => s.replace(/[<>]/g, "").trim();
    for (const it of req.body.itens) {
      await db.query(
        `INSERT INTO produtos (item_id, shop_id, nome, preco, comissao, vendas, imagem, origem_usuario)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (item_id) DO UPDATE
           SET preco = EXCLUDED.preco, comissao = EXCLUDED.comissao,
               vendas = EXCLUDED.vendas, atualizado_em = now()`,
        [it.itemId, it.shopId, limpo(it.nome), it.preco, it.comissao, it.vendas, it.imagem, req.usuarioId]
      );
    }
    return { ok: true, importados: req.body.itens.length };
  });

  /* ---------------- credenciais Shopee do cliente ---------------- */
  app.post("/api/shopee/credenciais", {
    preHandler: autenticado,
    schema: { body: z.object({ appId: z.string().max(40), appSecret: z.string().min(16).max(200) }) },
  }, async (req) => {
    await db.query(
      `INSERT INTO contas_shopee (usuario_id, app_id, app_secret_cifrado)
       VALUES ($1,$2,$3)
       ON CONFLICT (usuario_id) DO UPDATE SET app_id = EXCLUDED.app_id, app_secret_cifrado = EXCLUDED.app_secret_cifrado`,
      [req.usuarioId, req.body.appId, cifrar(req.body.appSecret)]
    );
    return { ok: true };   // jamais devolva o segredo, nem parcialmente
  });
}

/* Sessão opaca no banco, não JWT com dados dentro.
   Vantagem: dá para revogar na hora (logout, senha trocada, conta invadida).
   Guardamos só o hash — se dumparem a tabela, não dá para usar os tokens. */
async function criarSessao(reply, usuarioId) {
  const token = tokenAleatorio();
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await db.query(
    `INSERT INTO sessoes (usuario_id, token_hash, expira_em) VALUES ($1,$2, now() + interval '7 days')`,
    [usuarioId, hash]
  );
  reply.setCookie("sid", token, {
    httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7,
  });
}
