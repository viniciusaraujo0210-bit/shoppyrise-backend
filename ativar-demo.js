/* Marca uma conta como demonstração — só a sua.
   Uso: node ativar-demo.js seu@email.com        (ativa)
        node ativar-demo.js seu@email.com off    (desativa)

   Conta demo mostra números de exemplo no painel. Toda conta de
   cliente continua zerada, preenchendo só com venda real da Shopee. */
import { db, migrar } from "./src/lib/db.js";

const email = process.argv[2];
const ligar = process.argv[3] !== "off";
if (!email) { console.error("Informe o e-mail."); process.exit(1); }

await migrar();
const { rows } = await db.query(
  `UPDATE usuarios SET demo = $2 WHERE email = $1 RETURNING email, demo`, [email.toLowerCase(), ligar]
);
console.log(rows[0] ? `${rows[0].email} → demo: ${rows[0].demo}` : "E-mail não encontrado.");
process.exit(0);
