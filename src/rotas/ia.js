/* ==================================================================
   Geração de imagem da influenciadora — Gemini 2.5 Flash Image
   ("Nano Banana"). Recebe a FOTO REAL do produto como referência,
   pra manter forma, cor e rótulo fiéis.

   A chave do Google fica só aqui, nunca no navegador do cliente.
   Se ela viajasse no bundle do front, qualquer pessoa abrindo o
   DevTools a copiava e passava a gastar o crédito pago do dono da
   conta — por isso a rota é autenticada e tem limite de uso próprio,
   bem mais apertado que o limite geral da API.

   Timeouts: produtos vêm de CDNs de terceiros (Shopee etc.) que às
   vezes travam pedidos sem User-Agent de navegador e nunca respondem.
   Sem um limite de tempo aqui, o pedido inteiro fica pendurado pra
   sempre e o cliente não vê nem sucesso nem erro — só roda infinito.
================================================================== */

import { autenticado } from "../middlewares/auth.js";
import { env } from "../lib/env.js";
import { db } from "../lib/db.js";

const GEMINI_URL =
     "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent";

const TAMANHO_MAX_IMAGEM = 6 * 1024 * 1024; // 6 MB — foto de produto normal não passa disso
const TEMPO_MAX_DOWNLOAD = 15000; // 15s pra baixar a foto do produto
const TEMPO_MAX_GEMINI = 45000; // 45s pra o Google responder
/* Cota diária de gerações por cliente real. A conta demo (req.demo)
   nunca passa por aqui — pode gerar quantas vezes quiser, pra
   apresentação a investidor não travar no meio. */
const LIMITE_DIARIO_GERACOES = 10;

async function contagemHoje(usuarioId) {
     const { rows } = await db.query(
            `SELECT contagem FROM geracoes_ia_dia WHERE usuario_id = $1 AND dia = current_date`,
            [usuarioId]
     );
     return rows[0]?.contagem || 0;
}

/* Só chamada depois que a geração deu certo — tentativa que falhou
   (foto travada, Google fora do ar) não consome a cota do cliente. */
async function registrarGeracao(usuarioId) {
     await db.query(
            `INSERT INTO geracoes_ia_dia (usuario_id, dia, contagem)
             VALUES ($1, current_date, 1)
             ON CONFLICT (usuario_id, dia) DO UPDATE SET contagem = geracoes_ia_dia.contagem + 1`,
            [usuarioId]
     );
}

async function buscaComTempoLimite(url, opcoes, tempoLimiteMs) {
     const controle = new AbortController();
     const foraDoTempo = setTimeout(() => controle.abort(), tempoLimiteMs);
     try {
         return await fetch(url, { ...opcoes, signal: controle.signal });
     } finally {
            clearTimeout(foraDoTempo);
     }
}

export async function rotasIA(app) {
     app.post(
            "/api/ia/influenciadora",
        {
                 preHandler: autenticado,
                 // custa dinheiro de verdade por chamada — limite bem mais apertado
                 // que o geral, pra uma conta comprometida não estourar a fatura.
                 config: { rateLimit: { max: 12, timeWindow: "10 minutes" } },
        },
            async (req, reply) => {
                     if (!env.GEMINI_API_KEY) {
                                return reply.status(501).send({ erro: "IA_NAO_CONFIGURADA" });
                     }

              const { prompt, imagemProdutoUrl } = req.body || {};
                     if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) {
                                return reply.status(400).send({ erro: "Prompt inválido." });
                     }
                     if (typeof imagemProdutoUrl !== "string" || !/^https:\/\/[^ ]+$/.test(imagemProdutoUrl)) {
                                return reply.status(400).send({ erro: "Foto do produto inválida." });
                     }

                     if (!req.demo) {
                                const usadas = await contagemHoje(req.usuarioId);
                                if (usadas >= LIMITE_DIARIO_GERACOES) {
                                             return reply.status(429).send({
                                                            erro: `Limite de ${LIMITE_DIARIO_GERACOES} gerações por dia atingido. Volte amanhã pra gerar mais.`,
                                             });
                                }
                     }

              let ref;
                     try {
                                const rimg = await buscaComTempoLimite(
                                             imagemProdutoUrl,
                                   {
                                                  headers: {
                                                                   "User-Agent":
                                                                     "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                                                                   Referer: "https://shopee.com.br/",
                                                                   Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                                                  },
                                   },
                                             TEMPO_MAX_DOWNLOAD
                                           );
                                if (!rimg.ok) throw new Error(`download falhou (${rimg.status})`);
                                const buf = Buffer.from(await rimg.arrayBuffer());
                                if (buf.length > TAMANHO_MAX_IMAGEM) {
                                             return reply.status(400).send({ erro: "Foto do produto grande demais." });
                                }
                                ref = { data: buf.toString("base64"), mime: rimg.headers.get("content-type") || "image/jpeg" };
                     } catch (e) {
                                const motivo = e?.name === "AbortError" ? "timeout ao baixar a foto" : e?.message || "erro ao baixar";
                                req.log.warn({ url: imagemProdutoUrl, motivo }, "falha ao baixar foto do produto");
                                return reply.status(400).send({
                                             erro:
                                                            e?.name === "AbortError"
                                                 ? "A foto desse produto demorou demais pra carregar. Tenta de novo em alguns segundos."
                                                              : "Não consegui baixar a foto do produto. Tenta novamente.",
                                });
                     }

              let r;
                     try {
                                r = await buscaComTempoLimite(
                                             `${GEMINI_URL}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
                                   {
                                                  method: "POST",
                                                  headers: { "Content-Type": "application/json" },
                                                  body: JSON.stringify({
                                                                   contents: [
                                                                      {
                                                                                           role: "user",
                                                                                           parts: [{ text: prompt }, { inlineData: { mimeType: ref.mime, data: ref.data } }],
                                                                      },
                                                                                    ],
                                                                   generationConfig: { responseModalities: ["IMAGE"] },
                                                  }),
                                   },
                                             TEMPO_MAX_GEMINI
                                           );
                     } catch (e) {
                                const motivo = e?.name === "AbortError" ? "timeout" : e?.message || "erro";
                                req.log.warn({ motivo }, "falha ao chamar Gemini");
                                return reply.status(502).send({
                                             erro:
                                                            e?.name === "AbortError"
                                                 ? "O Google demorou demais pra responder. Tenta de novo."
                                                              : "Google indisponível agora. Tente de novo em instantes.",
                                });
                     }
// build-retry

              const j = await r.json().catch(() => ({}));
                     if (!r.ok) {
                                const msg = j?.error?.message || `Erro ${r.status}`;
                                if (/API key not valid|API_KEY_INVALID/i.test(msg)) {
                                             req.log.error("GEMINI_API_KEY inválida ou revogada");
                                             return reply.status(502).send({ erro: "Chave de IA inválida no servidor. Avise o suporte." });
                                }
                                if (r.status === 429) {
                                             return reply.status(429).send({ erro: "Limite da IA atingido. Espere um minuto." });
                                }
                                return reply.status(502).send({ erro: msg });
                     }

              const parts = j?.candidates?.[0]?.content?.parts || [];
                     const img = parts.find((p) => p.inlineData?.data);
                     if (!img) {
                                const txt = parts.find((p) => p.text)?.text;
                                return reply.status(422).send({
                                             erro: txt ? `O modelo recusou: ${txt.slice(0, 140)}` : "O modelo não devolveu imagem.",
                                });
                     }

              if (!req.demo) await registrarGeracao(req.usuarioId);
                     return { imagemBase64: img.inlineData.data, mime: img.inlineData.mimeType || "image/png" };
            }
          );
}
