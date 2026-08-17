/* ==================================================================
   Rota: catálogo "mais vendidos" com dado real da Shopee.

   Puxa da API oficial de afiliados, com cache curto em memória —
   sem cache, cada carregamento de página assina e chama a Shopee de
   novo, o que não faz sentido nem pra performance nem pro limite de
   uso da API (e "mais vendido" não muda minuto a minuto mesmo).
================================================================== */
import { env } from "../lib/env.js";
import { autenticado } from "../middlewares/auth.js";
import { buscarMaisVendidos } from "../lib/shopeeApi.js";

const TEMPO_CACHE_MS = 10 * 60 * 1000; // 10 min
let cache = { expiraEm: 0, produtos: null };

export async function rotasShopeeCatalogo(app) {
  app.get(
    "/api/catalogo/mais-vendidos",
    {
      preHandler: autenticado,
      config: { rateLimit: { max: 30, timeWindow: "10 minutes" } },
    },
    async (req, reply) => {
      if (!env.SHOPEE_APP_ID || !env.SHOPEE_APP_SECRET) {
        return reply.status(501).send({ erro: "SHOPEE_NAO_CONFIGURADO" });
      }

      if (cache.produtos && cache.expiraEm > Date.now()) {
        return { produtos: cache.produtos, cache: true };
      }

      try {
        const produtos = await buscarMaisVendidos({
          appId: env.SHOPEE_APP_ID,
          appSecret: env.SHOPEE_APP_SECRET,
          limite: 100,
        });
        cache = { produtos, expiraEm: Date.now() + TEMPO_CACHE_MS };
        return { produtos, cache: false };
      } catch (e) {
        req.log.warn({ motivo: e?.message }, "falha ao buscar mais vendidos na Shopee");
        /* Se já tem cache velho, devolve ele em vez de tela vazia —
           produto "mais vendido" de alguns minutos atrás ainda serve
           bem melhor que uma tela de erro pro cliente. */
        if (cache.produtos) return { produtos: cache.produtos, cache: true, expirado: true };
        return reply.status(502).send({ erro: "Não consegui buscar os produtos agora. Tenta de novo em instantes." });
      }
    }
  );
}
