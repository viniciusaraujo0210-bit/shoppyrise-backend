/* ==================================================================
   Cliente da Shopee Affiliate Open API (GraphQL) — usado só pra
   puxar o catálogo de "mais vendidos" que todo cliente vê.

   Autenticado com a credencial da PLATAFORMA (SHOPEE_APP_ID/SECRET
   no .env), não com a credencial pessoal que cada usuário salva em
   /perfil — essa outra é só pro link de afiliado dele, coisa separada.
================================================================== */
import crypto from "node:crypto";

const URL_GRAPHQL = "https://open-api.affiliate.shopee.com.br/graphql";
const TEMPO_MAX_MS = 8000;

const QUERY_MAIS_VENDIDOS = `
  query MaisVendidos($page: Int, $limit: Int, $keyword: String) {
    productOfferV2(page: $page, limit: $limit, keyword: $keyword, sortType: 2) {
      nodes {
        itemId
        productName
        imageUrl
        priceMin
        priceDiscountRate
        commissionRate
        sales
        ratingStar
        shopName
        offerLink
      }
    }
  }
`;

/* Esquema oficial: SHA256(AppId + Timestamp + Payload + Secret),
   timestamp em segundos (não milissegundos) — errar isso devolve
   "Invalid Signature" sem mais detalhe. */
function assinar(appId, timestamp, payload, appSecret) {
  return crypto.createHash("sha256").update(`${appId}${timestamp}${payload}${appSecret}`).digest("hex");
}

async function chamarGraphQL(appId, appSecret, query, variables) {
  const payload = JSON.stringify({ query, variables });
  const timestamp = Math.floor(Date.now() / 1000);
  const assinatura = assinar(appId, timestamp, payload, appSecret);

  const controle = new AbortController();
  const t = setTimeout(() => controle.abort(), TEMPO_MAX_MS);
  try {
    const r = await fetch(URL_GRAPHQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${assinatura}`,
      },
      body: payload,
      signal: controle.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.errors) throw new Error(j?.errors?.[0]?.message || `Erro ${r.status}`);
    return j.data;
  } finally {
    clearTimeout(t);
  }
}

/* Mapeia o retorno da Shopee pro mesmo formato que o catálogo já usa
   no front (nome, imagem, preco, comissao, vendas...), pra encaixar
   nos cards existentes sem precisar redesenhar nada.

   OBS: a Shopee costuma devolver commissionRate como fração (ex.:
   0.10 = 10%) — por isso o *100 aqui. Confirmar contra uma resposta
   real assim que houver credencial de produção; se vier já em
   percentual, é só tirar o *100. */
function mapear(n) {
  const preco = Number(n.priceMin) || 0;
  const descontoPct = Number(n.priceDiscountRate) || 0;
  return {
    itemId: String(n.itemId),
    nome: n.productName,
    imagem: n.imageUrl,
    preco,
    precoDe: descontoPct > 0 ? Number((preco / (1 - descontoPct / 100)).toFixed(2)) : preco,
    comissao: Number((Number(n.commissionRate) * 100).toFixed(1)),
    vendas: Number(n.sales) || 0,
    rating: Number(n.ratingStar) || 0,
    loja: n.shopName || "Shopee",
    link: n.offerLink,
  };
}

/* sortType:2 = ordenado por vendas na própria Shopee — é o que dá
   o "mais vendidos" de verdade, sem precisar ordenar nada aqui. */
export async function buscarMaisVendidos({ appId, appSecret, pagina = 1, limite = 24, busca }) {
  const data = await chamarGraphQL(appId, appSecret, QUERY_MAIS_VENDIDOS, {
    page: pagina,
    limit: limite,
    keyword: busca || undefined,
  });
  const nodes = data?.productOfferV2?.nodes || [];
  return nodes.map(mapear);
}
