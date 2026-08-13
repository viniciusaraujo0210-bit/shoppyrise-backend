/* ==================================================================
   Criptografia e senhas.
================================================================== */

import crypto from "node:crypto";
import argon2 from "argon2";
import { env } from "./env.js";

/* ---------- senhas ----------
   Argon2id é o recomendado atual. Resiste a ataque com GPU, ao
   contrário de MD5/SHA, que quebram bilhões de hashes por segundo.
   NUNCA guarde senha em texto, nem "criptografada" — só hash. */
export const hashSenha = (senha) =>
  argon2.hash(senha, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });

export const conferirSenha = async (hash, senha) => {
  try { return await argon2.verify(hash, senha); }
  catch { return false; }
};

/* ---------- segredos de terceiros no banco ----------
   O App Secret da Shopee de cada cliente é criptografado com AES-256-GCM.
   Se alguém dumpar o banco, leva bytes inúteis sem a CRYPTO_KEY,
   que vive só na variável de ambiente. */
const CHAVE = Buffer.from(env.CRYPTO_KEY, "hex");

export function cifrar(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", CHAVE, iv);
  const dados = Buffer.concat([c.update(texto, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), dados]).toString("base64");
}

export function decifrar(b64) {
  const buf = Buffer.from(b64, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", CHAVE, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

/* ---------- comparação segura ----------
   Comparar string com === vaza informação pelo tempo de resposta.
   Use isto para token, assinatura de webhook e chave de API. */
export function iguaisEmTempoConstante(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export const tokenAleatorio = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
