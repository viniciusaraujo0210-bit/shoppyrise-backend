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
  transport: producao ? undefined : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
};
