/* ==================================================================
   AfiliaPro — servidor
   Cada camada tem, ao lado, o ataque que ela previne.
================================================================== */

import Fastify from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import cookie from "@fastify/cookie";
import crypto from "node:crypto";

import { env, producao } from "./lib/env.js";
import { logger } from "./lib/logger.js";
import { db, migrar, limparSessoes } from "./lib/db.js";
import { rotasAuth } from "./rotas/auth.js";
import { rotasApp } from "./rotas/app.js";
import { rotasWebhook } from "./rotas/webhook.js";
import { rotasIA } from "./rotas/ia.js";
import { rotasShopeeCatalogo } from "./rotas/shopeeCatalogo.js";
import { rotasAfiliados } from "./rotas/afiliados.js";
import { rotasReembolsos } from "./rotas/reembolsos.js";

const app = Fastify({
  logger,
  trustProxy: 1,               // confia só no proxy do Railway (1 salto) — não em qualquer
                                // X-Forwarded-For que o próprio cliente possa forjar
  bodyLimit: 256 * 1024,      // 256 KB — corta payload gigante que estoura memória
});

/* Cabeçalhos: CSP mata XSS executado, HSTS força HTTPS,
   frameAncestors none impede clickjacking. */
await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https://*.susercontent.com"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
    },
  },
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
});

/* Lista fixa de origens. Nunca "*" com credentials: qualquer site
   passaria a chamar sua API com o cookie do usuário logado. */
await app.register(cors, {
  origin: env.ORIGENS_PERMITIDAS,
  credentials: true,
  methods: ["GET", "POST", "PATCH", "DELETE"],
});

await app.register(cookie, { secret: env.COOKIE_SECRET });

/* Primeira barreira contra força bruta e raspagem da base. */
await app.register(rateLimit, {
  max: 120,
  timeWindow: "1 minute",
  /* req.ip já vem correto do trustProxy acima. Um header tipo
     cf-connecting-ip só seria confiável se o Cloudflare estivesse na
     frente — não é o caso aqui, e um cliente podia mandar qualquer
     valor nele pra sempre cair num balde novo e furar o limite. */
  keyGenerator: (req) => req.ip,
  errorResponseBuilder: () => ({ erro: "Muitas requisições. Aguarde um minuto." }),
});

/* Erro nunca devolve stack trace: entregaria estrutura do banco
   e caminho de arquivo para quem está sondando. */
app.setErrorHandler((err, req, reply) => {
  const id = crypto.randomUUID().slice(0, 8);
  req.log.error({ err, id }, "erro nao tratado");
  const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
  reply.status(status).send({ erro: status < 500 ? err.message : "Erro interno.", id });
});

await migrar();
limparSessoes();

await app.register(rotasAuth);
await app.register(rotasApp);
await app.register(rotasWebhook);
await app.register(rotasIA);
await app.register(rotasShopeeCatalogo);
await app.register(rotasAfiliados);
await app.register(rotasReembolsos);

app.get("/saude", async () => ({ ok: true, banco: env.DATABASE_URL ? "postgres" : "pglite" }));

await app.listen({ port: env.PORT, host: "0.0.0.0" });
app.log.info(`AfiliaPro API em :${env.PORT} · banco: ${env.DATABASE_URL ? "Postgres" : "PGlite local"}`);
