/* Log sem dado sensível. Senha, token e cookie são removidos antes de gravar —
   log vazado com senha dentro é incidente igual banco vazado. */
import { producao } from "./env.js";

export const logger = {
  level: producao ? "info" : "debug",
  redact: {
    paths: ["req.headers.cookie", "req.headers.authorization",
            "req.body.senha", "req.body.nova", "req.body.atual",
            "req.body.appSecret", "*.senha_hash", "*.token_hash"],
    remove: true,
  },
  /* A querystring pode carregar segredo (ex.: ?chave=... do webhook).
     Sem isto, o serializer padrão grava a URL inteira — segredo incluído
     — em todo log de requisição. */
  serializers: {
    req(req) {
      return { method: req.method, url: req.url.split("?")[0], hostname: req.hostname, remoteAddress: req.ip };
    },
  },
  transport: producao ? undefined : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
};
