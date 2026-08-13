/* ==================================================================
   Geração de imagem da influenciadora — Gemini 2.5 Flash Image
   ("Nano Banana"). Recebe a FOTO REAL do produto como referência,
   pra manter forma, cor e rótulo fiéis.

   A chave do Google fica só aqui, nunca no navegador do cliente.
   Se ela viajasse no bundle do front, qualquer pessoa abrindo o
   DevTools a copiava e passava a gastar o crédito pago do dono da
   conta — por isso a rota é autenticada e tem limite de uso próprio,
   bem mais apertado que o limite geral da API.
================================================================== */

import { autenticado } from "../middlewares/auth.js";
import { env } from "../lib/env.js";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent";

const TAMANHO_MAX_IMAGEM = 6 * 1024 * 1024; // 6 MB — foto de produto normal não passa disso

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

      let ref;
      try {
        const rimg = await fetch(imagemProdutoUrl);
        if (!rimg.ok) throw new Error("download falhou");
        const buf = Buffer.from(await rimg.arrayBuffer());
        if (buf.length > TAMANHO_MAX_IMAGEM) {
          return reply.status(400).send({ erro: "Foto do produto grande demais." });
        }
        ref = { data: buf.toString("base64"), mime: rimg.headers.get("content-type") || "image/jpeg" };
      } catch {
        return reply.status(400).send({ erro: "Não consegui baixar a foto do produto." });
      }

      let r;
      try {
        r = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                { text: prompt },
                { inlineData: { mimeType: ref.mime, data: ref.data } },
              ],
            }],
            generationConfig: { responseModalities: ["IMAGE"] },
          }),
        });
      } catch {
        return reply.status(502).send({ erro: "Google indisponível agora. Tente de novo em instantes." });
      }

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

      return { imagemBase64: img.inlineData.data, mime: img.inlineData.mimeType || "image/png" };
    }
  );
}
