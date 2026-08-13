/* ==================================================================
   Autenticação — cadastro, login, sessão, logout.
================================================================== */

import crypto from "node:crypto";
import { z } from "zod";
import { db } from "../lib/db.js";
import { hashSenha, conferirSenha } from "../lib/cripto.js";
import { autenticado } from "../middlewares/auth.js";
import { producao } from "../lib/env.js";

const Email = z.string().email().max(160).trim().toLowerCase();
const Senha = z.string().min(8).max(200);
const Nome = z.string().min(2).max(80).trim();

/* Hash descartável: comparado quando o e-mail não existe, para o
   tempo de resposta ser igual ao do caminho válido. Sem isso, dá
   para descobrir quem é cliente seu medindo a latência. */
const HASH_FALSO =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm8";

const OPCOES_COOKIE = {
  httpOnly: true,          // JavaScript não lê → XSS não rouba a sessão
  secure: producao,        // só HTTPS em produção
  sameSite: "lax",         // barra CSRF vindo de outro site
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
};

async function abrirSessao(reply, usuarioId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  await db.query(
    `INSERT INTO sessoes (id, usuario_id, token_hash, expira_em)
     VALUES ($1, $2, $3, now() + interval '7 days')`,
    [crypto.randomUUID(), usuarioId, hash]
  );
  reply.setCookie("sid", token, OPCOES_COOKIE);
}

export async function rotasAuth(app) {
  app.post("/api/auth/cadastro", {
    config: { rateLimit: { max: 5, timeWindow: "10 minutes" } },
  }, async (req, reply) => {
    const p = z.object({ nome: Nome, email: Email, senha: Senha }).safeParse(req.body);
    if (!p.success) return reply.status(400).send({ erro: "Dados inválidos.", campos: p.error.flatten().fieldErrors });

    const { nome, email, senha } = p.data;
    const id = crypto.randomUUID();
    const hash = await hashSenha(senha);

    try {
      await db.query(
        `INSERT INTO usuarios (id, email, senha_hash, nome) VALUES ($1,$2,$3,$4)`,
        [id, email, hash, nome]
      );
      await db.query(`INSERT INTO assinaturas (usuario_id, plano, creditos) VALUES ($1,'free',10)`, [id]);
      await abrirSessao(reply, id);
      return { ok: true, usuario: { nome, email, plano: "free" } };
    } catch (e) {
      /* 23505 = e-mail duplicado. Não confirmamos que ele existe:
         isso permitiria montar lista de clientes seus. */
      if (String(e.message || "").includes("duplicate") || e.code === "23505")
        return reply.status(409).send({ erro: "Não foi possível criar a conta com esse e-mail." });
      throw e;
    }
  });

  app.post("/api/auth/login", {
    config: { rateLimit: { max: 8, timeWindow: "10 minutes" } },
  }, async (req, reply) => {
    const p = z.object({ email: Email, senha: Senha }).safeParse(req.body);
    if (!p.success) return reply.status(400).send({ erro: "Dados inválidos." });

    const { rows } = await db.query(
      `SELECT id, senha_hash, nome, email, plano, ativo, falhas, bloqueado_ate
         FROM usuarios WHERE email = $1`, [p.data.email]
    );
    const u = rows[0];

    if (u?.bloqueado_ate && new Date(u.bloqueado_ate) > new Date())
      return reply.status(429).send({ erro: "Conta bloqueada por tentativas. Tente em 15 minutos." });

    const ok = await conferirSenha(u?.senha_hash || HASH_FALSO, p.data.senha);

    if (!u || !ok || !u.ativo) {
      if (u) {
        await db.query(
          `UPDATE usuarios SET falhas = falhas + 1,
             bloqueado_ate = CASE WHEN falhas + 1 >= 5 THEN now() + interval '15 minutes' ELSE NULL END
           WHERE id = $1`, [u.id]);
      }
      return reply.status(401).send({ erro: "E-mail ou senha inválidos." });
    }

    await db.query(`UPDATE usuarios SET falhas = 0, bloqueado_ate = NULL WHERE id = $1`, [u.id]);
    await abrirSessao(reply, u.id);
    return { ok: true, usuario: { nome: u.nome, email: u.email, plano: u.plano } };
  });

  /* O front chama isto ao abrir: se devolver 401, mostra a tela de login. */
  app.get("/api/auth/eu", { preHandler: autenticado }, async (req) => {
    const { rows } = await db.query(
      `SELECT u.nome, u.email, u.plano, u.demo, u.senha_provisoria, a.creditos
         FROM usuarios u LEFT JOIN assinaturas a ON a.usuario_id = u.id
        WHERE u.id = $1`, [req.usuarioId]
    );
    return { usuario: rows[0] };
  });

  app.post("/api/auth/sair", { preHandler: autenticado }, async (req, reply) => {
    await db.query(`DELETE FROM sessoes WHERE token_hash = $1`, [req.sessaoHash]);
    reply.clearCookie("sid", { path: "/" });
    return { ok: true };
  });

  /* Primeiro acesso. A conta veio do webhook com a senha padrão, que é
     pública por natureza — qualquer um que saiba o e-mail do cliente
     entraria. Aqui ele define a senha dele e a marca de provisória cai.
     Só funciona ENQUANTO for provisória: depois disso, usa /api/auth/senha,
     que exige a senha atual. */
  app.post("/api/auth/definir-senha", { preHandler: autenticado }, async (req, reply) => {
    const p = z.object({ nova: Senha }).safeParse(req.body);
    if (!p.success) return reply.status(400).send({ erro: "A senha precisa de pelo menos 8 caracteres." });

    const { rows } = await db.query(
      `SELECT senha_provisoria FROM usuarios WHERE id = $1`, [req.usuarioId]);
    if (!rows[0]?.senha_provisoria)
      return reply.status(409).send({ erro: "Sua senha já foi definida. Use a troca de senha." });

    if (p.data.nova === "12345678")
      return reply.status(400).send({ erro: "Escolha uma senha diferente da provisória." });

    await db.query(
      `UPDATE usuarios SET senha_hash = $1, senha_provisoria = false WHERE id = $2`,
      [await hashSenha(p.data.nova), req.usuarioId]);
    /* Derruba outras sessões, mas mantém a atual: o cliente acabou de
       criar a senha, não faz sentido jogá-lo para fora agora. */
    await db.query(
      `DELETE FROM sessoes WHERE usuario_id = $1 AND token_hash <> $2`,
      [req.usuarioId, req.sessaoHash]);
    return { ok: true };
  });

  /* Trocar senha derruba TODAS as sessões — inclusive a de quem invadiu. */
  app.post("/api/auth/senha", { preHandler: autenticado }, async (req, reply) => {
    const p = z.object({ atual: Senha, nova: Senha }).safeParse(req.body);
    if (!p.success) return reply.status(400).send({ erro: "Dados inválidos." });

    const { rows } = await db.query(`SELECT senha_hash FROM usuarios WHERE id = $1`, [req.usuarioId]);
    if (!(await conferirSenha(rows[0].senha_hash, p.data.atual)))
      return reply.status(401).send({ erro: "Senha atual incorreta." });

    await db.query(`UPDATE usuarios SET senha_hash = $1 WHERE id = $2`,
      [await hashSenha(p.data.nova), req.usuarioId]);
    await db.query(`DELETE FROM sessoes WHERE usuario_id = $1`, [req.usuarioId]);
    reply.clearCookie("sid", { path: "/" });
    return { ok: true };
  });
}
