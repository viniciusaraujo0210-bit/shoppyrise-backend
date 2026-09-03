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

/* Reserva a cota ANTES de chamar o Gemini — não só conta depois.
   Ler a contagem e só incrementar mais tarde deixa uma brecha: duas
   requisições do mesmo cliente, em paralelo, podem ler o mesmo valor
   e as duas passarem no limite. O UPDATE ... WHERE contagem < limite
   dentro do próprio INSERT ON CONFLICT é atômico — o banco garante
   que só uma delas consegue incrementar quando já tá no limite.
   Se a geração falhar depois, liberarCota devolve a vaga: tentativa
   que não deu certo não consome cota do cliente. */
async function reservarCota(usuarioId) {
        const { rows } = await db.query(
                       `INSERT INTO geracoes_ia_dia (usuario_id, dia, contagem)
                                    VALUES ($1, current_date, 1)
                                                 ON CONFLICT (usuario_id, dia) DO UPDATE
                                                                SET contagem = geracoes_ia_dia.contagem + 1
                                                                               WHERE geracoes_ia_dia.contagem < $2
                                                                                            RETURNING contagem`,
                       [usuarioId, LIMITE_DIARIO_GERACOES]
                );
        return rows.length > 0;
}

async function liberarCota(usuarioId) {
        await db.query(
                       `UPDATE geracoes_ia_dia SET contagem = contagem - 1
                                    WHERE usuario_id = $1 AND dia = current_date AND contagem > 0`,
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
                               // foto própria em base64 é maior que o limite padrão de 256KB do
                               // servidor (bodyLimit global em server.js) — só esta rota precisa
                               // de mais espaço, o resto do app continua protegido no limite baixo.
                               // 18 MB porque agora dá pra mandar DUAS fotos (produto + referência
                               // de influenciadora) — cada uma até 6 MB, e base64 infla ~33%.
                               bodyLimit: 18 * 1024 * 1024,
                               // custa dinheiro de verdade por chamada — limite bem mais apertado
                               // que o geral, pra uma conta comprometida não estourar a fatura.
                               config: { rateLimit: { max: 12, timeWindow: "10 minutes" } },
           },
                       async (req, reply) => {
                                               if (!env.GEMINI_API_KEY) {
                                                                                  return reply.status(501).send({ erro: "IA_NAO_CONFIGURADA" });
                                               }

                         const {
                                                            prompt, imagemProdutoUrl, imagemProdutoBase64, imagemProdutoMime,
                                                            // Foto de referência OPCIONAL de uma influenciadora (ex: print do Pinterest)
                                                            // pra usar o rosto/estilo dela como base da pessoa gerada, em vez de
                                                            // depender só da descrição em texto (idade, aparência etc).
                                                            imagemInfluenciadoraBase64, imagemInfluenciadoraMime,
                         } = req.body || {};
                                               if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 4000) {
                                                                                  return reply.status(400).send({ erro: "Prompt inválido." });
                                               }

                                /* Cliente pode mandar a URL de um produto do catálogo OU a
                                                  foto própria dele em base64 — os dois caem no mesmo
                                                  formato { data, mime } logo abaixo, pro resto da rota
                                                  (chamada ao Gemini) nem precisar saber qual dos dois foi. */
                                const MIMES_PERMITIDOS = ["image/jpeg", "image/png", "image/webp"];
                                               const usaUpload = typeof imagemProdutoBase64 === "string" && imagemProdutoBase64.length > 0;

                                if (!usaUpload && (typeof imagemProdutoUrl !== "string" || !/^https:\/\/[^ ]+$/.test(imagemProdutoUrl))) {
                                                                   return reply.status(400).send({ erro: "Foto do produto inválida." });
                                }
                                               if (usaUpload) {
                                                                                  if (!MIMES_PERMITIDOS.includes(imagemProdutoMime)) {
                                                                                                                                  return reply.status(400).send({ erro: "Formato de imagem não suportado. Envie JPG, PNG ou WEBP." });
                                                                                     }
                                                                                  // tamanho aproximado do binário decodificado (base64 infla ~33%) — barato e evita decodificar payload gigante à toa
                                                          const tamanhoAprox = Math.ceil((imagemProdutoBase64.length * 3) / 4);
                                                                                  if (tamanhoAprox > TAMANHO_MAX_IMAGEM) {
                                                                                                                                  return reply.status(400).send({ erro: "Foto do produto grande demais (máx. 6 MB)." });
                                                                                     }
                                               }

                                const temReferenciaInfluenciadora =
                                                                   typeof imagemInfluenciadoraBase64 === "string" && imagemInfluenciadoraBase64.length > 0;
                                               if (temReferenciaInfluenciadora) {
                                                                                  if (!MIMES_PERMITIDOS.includes(imagemInfluenciadoraMime)) {
                                                                                                                                  return reply.status(400).send({ erro: "Formato da foto de referência não suportado. Envie JPG, PNG ou WEBP." });
                                                                                     }
                                                                                  const tamanhoAproxRef = Math.ceil((imagemInfluenciadoraBase64.length * 3) / 4);
                                                                                  if (tamanhoAproxRef > TAMANHO_MAX_IMAGEM) {
                                                                                                                                  return reply.status(400).send({ erro: "Foto de referência grande demais (máx. 6 MB)." });
                                                                                     }
                                               }

                                if (!req.demo) {
                                                                   const reservou = await reservarCota(req.usuarioId);
                                                                   if (!reservou) {
                                                                                                                   return reply.status(429).send({
                                                                                                                                                                                  erro: `Você excedeu o limite diário de ${LIMITE_DIARIO_GERACOES} gerações. O limite é renovado todo dia à 00:00.`,
                                                                                                                      });
                                                                      }
                                }

                         let ref;
                                               if (usaUpload) {
                                                                                  /* Foto já veio do próprio navegador do cliente — nada pra baixar. */
                                                          ref = { data: imagemProdutoBase64, mime: imagemProdutoMime };
                                               } else {
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
                                                                                                                                                          if (!req.demo) await liberarCota(req.usuarioId);
                                                                                                                                                          return reply.status(400).send({ erro: "Foto do produto grande demais." });
                                                                                                             }
                                                                                                          ref = { data: buf.toString("base64"), mime: rimg.headers.get("content-type") || "image/jpeg" };
                                                                       } catch (e) {
                                                                                                          const motivo = e?.name === "AbortError" ? "timeout ao baixar a foto" : e?.message || "erro ao baixar";
                                                                                                          req.log.warn({ url: imagemProdutoUrl, motivo }, "falha ao baixar foto do produto");
                                                                                                          if (!req.demo) await liberarCota(req.usuarioId);
                                                                                                          return reply.status(400).send({
                                                                                                                                                          erro:
                                                                                                                                                                                                                         e?.name === "AbortError"
                                                                                                                                                              ? "A foto desse produto demorou demais pra carregar. Tenta de novo em alguns segundos."
                                                                                                                                                                                                                           : "Não consegui baixar a foto do produto. Tenta novamente.",
                                                                                                             });
                                                                       }
                                               }

                         /* Quando vem uma foto de referência de influenciadora, manda ela como
                                           uma segunda imagem pro Gemini e reforça no prompt (em texto, do lado
                                           do servidor — não depende do front mandar isso certo) que o rosto e o
                                           estilo dela é que devem valer pra pessoa gerada. O produto continua
                                           sendo sempre a PRIMEIRA imagem, e continua valendo exatamente como
                                           está na foto dele — só a pessoa muda de referência. */
                                const promptFinal = temReferenciaInfluenciadora
                                                          ? `${prompt}\n\nA SECOND reference image is attached: a photo of a specific woman/man. Use THAT PERSON's face, skin tone, hair and general look as the model in the generated photo — keep her/his identity recognizable. The product must still match the FIRST reference image exactly.`
                                                                   : prompt;
                                               const partesGemini = [{ text: promptFinal }, { inlineData: { mimeType: ref.mime, data: ref.data } }];
                                               if (temReferenciaInfluenciadora) {
                                                                                  partesGemini.push({ inlineData: { mimeType: imagemInfluenciadoraMime, data: imagemInfluenciadoraBase64 } });
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
                                                                                                                                                                                                                                                                                                                                                                                       parts: partesGemini,
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
                                                                                  if (!req.demo) await liberarCota(req.usuarioId);
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
                                                                                                                                  if (!req.demo) await liberarCota(req.usuarioId);
                                                                                                                                  return reply.status(502).send({ erro: "Chave de IA inválida no servidor. Avise o suporte." });
                                                                                     }
                                                                                  if (r.status === 429) {
                                                                                                                                  if (!req.demo) await liberarCota(req.usuarioId);
                                                                                                                                  return reply.status(429).send({ erro: "Limite da IA atingido. Espere um minuto." });
                                                                                     }
                                                                                  if (!req.demo) await liberarCota(req.usuarioId);
                                                                                  return reply.status(502).send({ erro: msg });
                                               }

                         const parts = j?.candidates?.[0]?.content?.parts || [];
                                               const img = parts.find((p) => p.inlineData?.data);
                                               if (!img) {
                                                                                  const txt = parts.find((p) => p.text)?.text;
                                                                                  if (!req.demo) await liberarCota(req.usuarioId);
                                                                                  return reply.status(422).send({
                                                                                                                                  erro: txt ? `O modelo recusou: ${txt.slice(0, 140)}` : "O modelo não devolveu imagem.",
                                                                                     });
                                               }

                         /* Sucesso: a cota já foi contada lá em cima, na reserva. */
                                return { imagemBase64: img.inlineData.data, mime: img.inlineData.mimeType || "image/png" };
                       }
                     );
}
