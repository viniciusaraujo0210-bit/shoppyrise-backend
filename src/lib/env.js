/* Config validada na subida: se faltar segredo, o processo não sobe.
   Melhor falhar no deploy do que rodar em produção com chave vazia. */
import { z } from "zod";

const esquema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(3333),

  /* vazio = usa PGlite local (dev). Preenchido = Postgres de verdade. */
  DATABASE_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),

  COOKIE_SECRET: z.string().min(32).default("dev-".padEnd(48, "x")),
  CRYPTO_KEY: z.string().length(64).default("0".repeat(64)),

  SHOPEE_APP_ID: z.string().optional(),
  SHOPEE_APP_SECRET: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  /* Segredo do webhook da Wiven. Sem ele a rota de entrega recusa tudo. */
  WIVEN_WEBHOOK_SEGREDO: z.string().min(24).optional(),

  ORIGENS_PERMITIDAS: z.string().default("http://localhost:5173,http://localhost:3000")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)),
});

const r = esquema.safeParse(process.env);
if (!r.success) {
  console.error("Configuração inválida:\n", r.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = r.data;
export const producao = env.NODE_ENV === "production";

/* Em produção os padrões de desenvolvimento são proibidos. */
if (producao) {
  if (env.COOKIE_SECRET.startsWith("dev-") || env.CRYPTO_KEY === "0".repeat(64)) {
    console.error("Segredos padrão em produção. Gere com: openssl rand -base64 48 / openssl rand -hex 32");
    process.exit(1);
  }
  if (!env.DATABASE_URL) { console.error("DATABASE_URL obrigatório em produção."); process.exit(1); }
  if (!env.WIVEN_WEBHOOK_SEGREDO) {
    console.error("WIVEN_WEBHOOK_SEGREDO obrigatório em produção: sem ele, qualquer um libera acesso de graça.");
    process.exit(1);
  }
}
